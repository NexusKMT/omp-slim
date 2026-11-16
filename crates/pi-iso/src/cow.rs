//! Copy-on-write file cloning, shared by the tree-cloning backends and the
//! shell's `cp`.
//!
//! A clone shares the source's storage extents until either file is written:
//!
//! | Platform | Primitive | Filesystems |
//! |---|---|---|
//! | Linux, Android | `FICLONE` | btrfs, XFS, bcachefs, OCFS2, … |
//! | macOS | `clonefile(2)` | APFS |
//!
//! Elsewhere, and between files that cannot share extents (different
//! filesystems, NTFS, ext4, …), [`clone_file`] fails with an error
//! [`is_unsupported`] recognizes; callers then copy the data instead.
//!
//! # Example
//!
//! ```ignore
//! match pi_iso::cow::clone_file(src, dst) {
//!     Ok(()) => {},
//!     Err(err) if pi_iso::cow::is_unsupported(&err) => drop(std::fs::copy(src, dst)?),
//!     Err(err) => return Err(err),
//! }
//! ```

use std::{
	fs::{self, Metadata},
	io,
	path::Path,
	sync::atomic::{AtomicU64, Ordering},
};

/// Makes `dst` a copy-on-write clone of the regular file `src`, following
/// symlinks at either path.
///
/// A missing `dst` is created. Only its data is guaranteed: an APFS clone
/// also carries `src`'s mode, flags, extended attributes, and timestamps,
/// while elsewhere `dst` gets default permissions.
///
/// An existing `dst` is never written in place: the clone is made beside it
/// and renamed over it, so a failed clone leaves `dst` untouched. The swap
/// keeps what an in-place copy keeps: `dst`'s mode, its owner and group
/// (Unix), and its hard links, which is why `dst` must be a writable regular
/// file with one link whose owner the clone can take on. `dst`'s extended
/// attributes and ACL do not survive.
///
/// # Errors
///
/// An [`is_unsupported`] error when the files cannot share extents
/// (different filesystems, a filesystem without cloning, an unsupported
/// platform) or `dst` cannot be swapped for a clone; otherwise the failing
/// call. On error no clone is left behind and an existing `dst` is unchanged.
pub fn clone_file(src: &Path, dst: &Path) -> io::Result<()> {
	let existing = match fs::metadata(dst) {
		Ok(metadata) if metadata.is_file() => Some(metadata),
		Ok(_) => return Err(unsupported("destination is not a regular file")),
		Err(err) if err.kind() == io::ErrorKind::NotFound => None,
		Err(err) => return Err(err),
	};
	check_same_device(src, dst, existing.as_ref())?;
	match existing {
		None => {
			clone_new(src, dst)?;
			Ok(())
		},
		// Swap the file a symlinked `dst` names, as an in-place copy writes it.
		Some(metadata) => clone_over(src, &fs::canonicalize(dst)?, &metadata),
	}
}

/// Whether `err` from [`clone_file`] means the files cannot be cloned, as
/// opposed to an I/O failure a data copy would hit too.
pub fn is_unsupported(err: &io::Error) -> bool {
	if err.kind() == io::ErrorKind::Unsupported {
		return true;
	}
	#[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
	{
		err.raw_os_error().is_some_and(imp::is_unsupported_code)
	}
	#[cfg(not(any(target_os = "linux", target_os = "android", target_os = "macos")))]
	{
		false
	}
}

/// Clones `src`'s data into `dst`, two files the caller already holds open.
///
/// `dst` must be writable and empty (just created or truncated). This is the
/// copy GNU `cp` issues on its open descriptors, without [`clone_file`]'s
/// path lookups, probe file and rename.
///
/// # Errors
///
/// As [`clone_file`]. A failed clone leaves `dst` empty, so the caller can
/// copy the data into it instead.
#[cfg(any(target_os = "linux", target_os = "android"))]
pub fn clone_open(src: &fs::File, dst: &fs::File) -> io::Result<()> {
	let cloned = imp::clone_into(src, dst);
	cloned
}

/// Whether an [`is_unsupported`] [`clone_open`] error is cross-device.
///
/// Distinguishes files on different devices from a source filesystem that
/// cannot clone: only the latter holds for every later copy from it.
pub fn is_cross_device(err: &io::Error) -> bool {
	err.kind() == io::ErrorKind::CrossesDevices
}

#[cfg(target_os = "macos")]
pub(crate) use imp::{CLONE_NOFOLLOW, clonefile};

fn unsupported(reason: &str) -> io::Error {
	io::Error::new(io::ErrorKind::Unsupported, reason)
}

/// Fails before touching `dst` when it is on another device than `src`, which
/// no platform can clone across.
fn check_same_device(src: &Path, dst: &Path, existing: Option<&Metadata>) -> io::Result<()> {
	use std::os::unix::fs::MetadataExt as _;

	let dst_dev = if let Some(metadata) = existing {
		metadata.dev()
	} else {
		let parent = dst.parent().filter(|parent| !parent.is_empty());
		// Let the clone itself report a missing directory.
		let Ok(metadata) = fs::metadata(parent.unwrap_or_else(|| Path::new("."))) else {
			return Ok(());
		};
		metadata.dev()
	};
	(fs::metadata(src)?.dev() == dst_dev)
		.ok_or_else(|| unsupported("source and destination are on different devices"))
}

/// Replaces the regular file `dst` (described by `metadata`) with a clone of
/// `src` made beside it, when the swap passes for an in-place copy.
fn clone_over(src: &Path, dst: &Path, metadata: &Metadata) -> io::Result<()> {
	/// Keeps the temporaries of concurrent clones in one process apart.
	static SEQUENCE: AtomicU64 = AtomicU64::new(0);

	fs::OpenOptions::new()
		.write(true)
		.open(dst)
		.map_err(|_| unsupported("destination is not writable"))?;
	if link_count(metadata) != 1 {
		return Err(unsupported("destination has other hard links"));
	}

	let temp = dst.with_file_name(format!(
		".cow-clone-{}-{}",
		std::process::id(),
		SEQUENCE.fetch_add(1, Ordering::Relaxed)
	));
	clone_new(src, &temp)?;
	let swapped = (|| {
		take_owner(&temp, metadata)?;
		fs::set_permissions(&temp, metadata.permissions())?;
		fs::rename(&temp, dst)
	})();
	if swapped.is_err() {
		let _ = fs::remove_file(&temp);
	}
	swapped
}

/// Gives `clone` the owner and group of the file it replaces.
fn take_owner(clone: &Path, metadata: &Metadata) -> io::Result<()> {
	use std::os::unix::fs::{MetadataExt as _, chown};

	let current = fs::symlink_metadata(clone)?;
	if (current.uid(), current.gid()) == (metadata.uid(), metadata.gid()) {
		return Ok(());
	}
	chown(clone, Some(metadata.uid()), Some(metadata.gid()))
		.map_err(|_| unsupported("clone cannot take the destination's owner"))
}

/// The number of hard links to the file described by `metadata`.
fn link_count(metadata: &Metadata) -> u64 {
	std::os::unix::fs::MetadataExt::nlink(metadata)
}

/// Creates `dst` as a clone of `src`.
#[cfg(target_os = "macos")]
fn clone_new(src: &Path, dst: &Path) -> io::Result<()> {
	clonefile(src, dst, 0)
}

/// Creates the missing `dst` as a clone of `src`, removing it again on
/// failure.
///
/// Returns `src` and `dst` still open, so the tree-cloning backends, which
/// clone into fresh directories, read the source's metadata and apply it to
/// the clone through the handles rather than by path, and skip
/// [`clone_file`]'s existence probe and device check: a clone across devices
/// fails with an [`is_unsupported`] error anyway.
#[cfg(any(target_os = "linux", target_os = "android"))]
pub(crate) fn clone_new(src: &Path, dst: &Path) -> io::Result<(fs::File, fs::File)> {
	let src = fs::File::open(src)?;
	let dst_file = fs::OpenOptions::new()
		.write(true)
		.create_new(true)
		.open(dst)?;
	if let Err(err) = imp::clone_into(&src, &dst_file) {
		drop(dst_file);
		let _ = fs::remove_file(dst);
		return Err(err);
	}
	Ok((src, dst_file))
}

#[cfg(not(any(target_os = "linux", target_os = "android", target_os = "macos")))]
fn clone_new(_src: &Path, _dst: &Path) -> io::Result<()> {
	Err(unsupported("copy-on-write cloning is not implemented on this platform"))
}

#[cfg(any(target_os = "linux", target_os = "android"))]
mod imp {
	use std::{fs::File, io, os::fd::AsRawFd as _};

	// `libc::Ioctl` is `c_int` on musl and `c_ulong` on glibc; the constant
	// fits both.
	const FICLONE: libc::Ioctl = 0x4004_9409;

	/// Clones `src`'s data into the empty `dst`.
	pub fn clone_into(src: &File, dst: &File) -> io::Result<()> {
		// SAFETY: both descriptors are borrowed from live files for the call,
		// and the kernel retains neither.
		(unsafe { libc::ioctl(dst.as_raw_fd(), FICLONE, src.as_raw_fd()) } == 0)
			.ok_or_else(io::Error::last_os_error)
	}

	pub const fn is_unsupported_code(code: i32) -> bool {
		matches!(code, libc::EXDEV | libc::EOPNOTSUPP | libc::ENOTTY | libc::EINVAL | libc::ENOSYS)
	}
}

#[cfg(target_os = "macos")]
mod imp {
	use std::{ffi::CString, io, os::unix::ffi::OsStrExt as _, path::Path};

	/// Clones a symlink itself rather than its target. Darwin's `clonefile.h`
	/// defines it; `libc` does not.
	pub const CLONE_NOFOLLOW: u32 = 0x0001;

	/// `clonefile(src, dst, flags)`; a directory `src` clones its whole tree.
	pub fn clonefile(src: &Path, dst: &Path, flags: u32) -> io::Result<()> {
		let src = CString::new(src.as_os_str().as_bytes())?;
		let dst = CString::new(dst.as_os_str().as_bytes())?;
		// SAFETY: both strings are NUL-terminated and outlive the call, which
		// retains neither pointer.
		(unsafe { libc::clonefile(src.as_ptr(), dst.as_ptr(), flags) } == 0)
			.ok_or_else(io::Error::last_os_error)
	}

	pub const fn is_unsupported_code(code: i32) -> bool {
		matches!(code, libc::ENOTSUP | libc::EOPNOTSUPP | libc::EXDEV)
	}
}
