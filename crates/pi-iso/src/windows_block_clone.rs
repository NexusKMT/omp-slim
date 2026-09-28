//! Windows block-clone based isolation.
//!
//! `FSCTL_DUPLICATE_EXTENTS_TO_FILE` asks `ReFS` (including Dev Drive) to share
//! file extents copy-on-write between a source file and a destination file;
//! other filesystems such as NTFS reject it, which surfaces as
//! [`IsoError::unavailable`](crate::IsoError). The backend
//! recursively materializes the directory tree and block-clones each regular
//! file. There is no mount/session state to undo, so
//! [`stop`](IsolationBackend::stop) is a recursive remove.

use std::path::Path;

use async_trait::async_trait;

#[cfg(not(windows))]
use crate::IsoError;
use crate::{BackendKind, IsoResult, IsolationBackend, ProbeResult};

pub struct WindowsBlockCloneBackend;

pub fn backend() -> &'static dyn IsolationBackend {
	&WindowsBlockCloneBackend
}

#[async_trait]
impl IsolationBackend for WindowsBlockCloneBackend {
	fn kind(&self) -> BackendKind {
		BackendKind::WindowsBlockClone
	}

	fn probe(&self) -> ProbeResult {
		#[cfg(windows)]
		{
			ProbeResult::available()
		}
		#[cfg(not(windows))]
		{
			ProbeResult::unavailable("Windows block-clone isolation is only available on Windows")
		}
	}

	fn start(&self, lower: &Path, merged: &Path) -> IsoResult<()> {
		#[cfg(windows)]
		{
			imp::start(lower, merged)
		}
		#[cfg(not(windows))]
		{
			let _ = (lower, merged);
			Err(IsoError::unavailable("Windows block-clone isolation is only available on Windows"))
		}
	}

	fn clone_tree(&self, lower: &Path, merged: &Path, skip: &[&std::ffi::OsStr]) -> IsoResult<()> {
		#[cfg(windows)]
		{
			imp::clone_tree(lower, merged, skip)
		}
		#[cfg(not(windows))]
		{
			let _ = (lower, merged, skip);
			Err(IsoError::unavailable("Windows block-clone isolation is only available on Windows"))
		}
	}

	fn stop(&self, merged: &Path) -> IsoResult<()> {
		#[cfg(windows)]
		{
			imp::stop(merged)
		}
		#[cfg(not(windows))]
		{
			let _ = merged;
			Ok(())
		}
	}
}

#[cfg(windows)]
mod imp {
	use std::{
		ffi::c_void,
		fs::{self, File, OpenOptions},
		io,
		os::windows::{
			fs::{FileTypeExt, MetadataExt, OpenOptionsExt},
			io::AsRawHandle,
		},
		path::{Path, PathBuf},
	};

	use windows_sys::Win32::{
		Foundation::{
			ERROR_ACCESS_DENIED, ERROR_INVALID_FUNCTION, ERROR_INVALID_PARAMETER,
			ERROR_NOT_SAME_DEVICE, ERROR_NOT_SUPPORTED, FILETIME,
		},
		Storage::FileSystem::{
			FILE_ATTRIBUTE_SPARSE_FILE, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
			SetFileTime,
		},
		System::{
			IO::DeviceIoControl,
			Ioctl::{
				DUPLICATE_EXTENTS_DATA, FILE_SET_SPARSE_BUFFER, FSCTL_DUPLICATE_EXTENTS_TO_FILE,
				FSCTL_GET_INTEGRITY_INFORMATION, FSCTL_GET_INTEGRITY_INFORMATION_BUFFER,
				FSCTL_SET_INTEGRITY_INFORMATION, FSCTL_SET_INTEGRITY_INFORMATION_BUFFER,
				FSCTL_SET_SPARSE,
			},
		},
	};

	use crate::{IsoError, IsoResult};

	pub fn start(lower: &Path, merged: &Path) -> IsoResult<()> {
		let lower = canonical_existing_dir(lower)?;
		prepare_destination(merged)?;

		let result = recursive_block_clone(&lower, merged);
		if result.is_err() {
			let _ = remove_path(merged);
		}
		result
	}

	pub fn clone_tree(lower: &Path, merged: &Path, skip: &[&std::ffi::OsStr]) -> IsoResult<()> {
		let lower = canonical_existing_dir(lower)?;
		prepare_destination(merged)?;
		let result = (|| {
			fs::create_dir_all(merged)
				.map_err(|err| IsoError::other(format!("create {}: {err}", merged.display())))?;
			clone_dir_contents(&lower, merged, Some(skip))?;
			copy_metadata_best_effort(&lower, merged);
			Ok(())
		})();
		if result.is_err() {
			let _ = remove_path(merged);
		}
		result
	}

	pub fn stop(merged: &Path) -> IsoResult<()> {
		remove_path(merged).map_err(|err| {
			IsoError::other(format!("unable to remove block-cloned tree {}: {err}", merged.display()))
		})
	}

	fn canonical_existing_dir(path: &Path) -> IsoResult<PathBuf> {
		let resolved = if path.is_absolute() {
			path.to_path_buf()
		} else {
			std::env::current_dir().map_or_else(|_| path.to_path_buf(), |cwd| cwd.join(path))
		};
		let meta = fs::metadata(&resolved).map_err(|err| {
			IsoError::other(format!("invalid block-clone source {}: {err}", resolved.display()))
		})?;
		if !meta.is_dir() {
			return Err(IsoError::other(format!(
				"block-clone source {} is not a directory",
				resolved.display()
			)));
		}
		Ok(fs::canonicalize(&resolved).unwrap_or(resolved))
	}

	fn prepare_destination(merged: &Path) -> IsoResult<()> {
		if let Some(parent) = merged.parent() {
			fs::create_dir_all(parent).map_err(|err| {
				IsoError::other(format!("create parent of {}: {err}", merged.display()))
			})?;
		}
		remove_path(merged).map_err(|err| {
			IsoError::other(format!("unable to clear {} before block clone: {err}", merged.display()))
		})?;
		Ok(())
	}

	fn remove_path(path: &Path) -> io::Result<()> {
		let meta = match fs::symlink_metadata(path) {
			Ok(meta) => meta,
			Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
			Err(err) => return Err(err),
		};
		let file_type = meta.file_type();
		if file_type.is_dir() && !file_type.is_symlink() {
			for entry in fs::read_dir(path)? {
				remove_path(&entry?.path())?;
			}
			clear_readonly(path, &meta);
			fs::remove_dir(path)
		} else {
			clear_readonly(path, &meta);
			fs::remove_file(path)
		}
	}

	fn clear_readonly(path: &Path, meta: &fs::Metadata) {
		if meta.file_type().is_symlink() {
			return;
		}
		let mut permissions = meta.permissions();
		if permissions.readonly() {
			// This backend only removes a temporary Windows block-clone tree;
			// clearing the readonly file attribute is required so removal can
			// proceed.
			#[allow(
				clippy::permissions_set_readonly_false,
				reason = "Windows block-clone cleanup must clear the readonly file attribute before \
				          deletion"
			)]
			permissions.set_readonly(false);
			let _ = fs::set_permissions(path, permissions);
		}
	}

	fn recursive_block_clone(lower: &Path, merged: &Path) -> IsoResult<()> {
		fs::create_dir_all(merged)
			.map_err(|err| IsoError::other(format!("create {}: {err}", merged.display())))?;
		clone_dir_contents(lower, merged, None)?;
		copy_metadata_best_effort(lower, merged);
		Ok(())
	}

	fn clone_dir_contents(
		src: &Path,
		dst: &Path,
		skip: Option<&[&std::ffi::OsStr]>,
	) -> IsoResult<()> {
		let entries = fs::read_dir(src)
			.map_err(|err| IsoError::other(format!("read_dir {}: {err}", src.display())))?;
		for entry in entries {
			let entry = entry
				.map_err(|err| IsoError::other(format!("dir entry in {}: {err}", src.display())))?;
			if skip.is_some_and(|names| names.contains(&entry.file_name().as_os_str())) {
				continue;
			}
			let file_type = entry.file_type().map_err(|err| {
				IsoError::other(format!("file_type {}: {err}", entry.path().display()))
			})?;
			let src_path = entry.path();
			let dst_path = dst.join(entry.file_name());

			if file_type.is_symlink() {
				clone_symlink(&src_path, &dst_path)?;
				copy_metadata_best_effort(&src_path, &dst_path);
			} else if file_type.is_dir() {
				fs::create_dir_all(&dst_path)
					.map_err(|err| IsoError::other(format!("create {}: {err}", dst_path.display())))?;
				clone_dir_contents(&src_path, &dst_path, None)?;
				copy_metadata_best_effort(&src_path, &dst_path);
			} else if file_type.is_file() {
				clone_regular_file(&src_path, &dst_path)?;
				copy_metadata_best_effort(&src_path, &dst_path);
			} else {
				return Err(IsoError::other(format!(
					"unsupported filesystem entry for block clone: {}",
					src_path.display()
				)));
			}
		}
		Ok(())
	}

	fn clone_symlink(src: &Path, dst: &Path) -> IsoResult<()> {
		let target = fs::read_link(src)
			.map_err(|err| IsoError::other(format!("read_link {}: {err}", src.display())))?;
		let file_type = fs::symlink_metadata(src)
			.map_err(|err| IsoError::other(format!("symlink_metadata {}: {err}", src.display())))?
			.file_type();
		let res = if file_type.is_symlink_dir() {
			std::os::windows::fs::symlink_dir(target, dst)
		} else {
			std::os::windows::fs::symlink_file(target, dst)
		};
		res.map_err(|err| IsoError::other(format!("symlink {}: {err}", dst.display())))
	}

	fn clone_regular_file(src: &Path, dst: &Path) -> IsoResult<()> {
		let src_meta = fs::metadata(src)
			.map_err(|err| IsoError::other(format!("metadata {}: {err}", src.display())))?;
		let len = src_meta.len();

		let src_file = OpenOptions::new().read(true).open(src).map_err(|err| {
			IsoError::other(format!("open block-clone source {}: {err}", src.display()))
		})?;
		let dst_file = OpenOptions::new()
			.write(true)
			.create_new(true)
			.open(dst)
			.map_err(|err| {
				IsoError::other(format!("create block-clone destination {}: {err}", dst.display()))
			})?;

		if len == 0 {
			return Ok(());
		}
		let Err(err) = clone_file_data(&src_file, &dst_file, len) else {
			return Ok(());
		};
		if is_unavailable_error(&err) {
			Err(IsoError::unavailable(format!(
				"Windows block clone unsupported for {} -> {}: {err}",
				src.display(),
				dst.display()
			)))
		} else {
			Err(IsoError::other(format!(
				"block clone {} -> {}: {err}",
				src.display(),
				dst.display()
			)))
		}
	}

	/// Block-clones the `len` bytes of `src` into the empty, writable `dst`.
	///
	/// Follows the `ReFS` rules from
	/// <https://learn.microsoft.com/windows/win32/fileio/block-cloning>: each
	/// region is cluster-aligned and under 4 GiB, `dst` is extended to `len`
	/// first, and it matches `src`'s integrity-stream and sparse settings.
	/// The last region is rounded up to the whole cluster holding the end of
	/// file, as the `reflink` tools do (`0xbadfca11/reflink`, `reflink-copy`).
	///
	/// # Errors
	///
	/// The first failing `FSCTL`; a filesystem without block cloning (NTFS,
	/// FAT, a different volume) fails `FSCTL_GET_INTEGRITY_INFORMATION` or the
	/// clone with an error [`is_unavailable_error`] accepts.
	fn clone_file_data(src: &File, dst: &File, len: u64) -> io::Result<()> {
		/// The largest cloned region is under 4 GiB.
		const MAX_REGION: u64 = (4 << 30) - 1;

		let mut integrity = FSCTL_GET_INTEGRITY_INFORMATION_BUFFER::default();
		fsctl(src, FSCTL_GET_INTEGRITY_INFORMATION, &(), &mut integrity)?;
		let cluster = u64::from(integrity.ClusterSizeInBytes).max(1);
		// Best effort: some volumes (reportedly Dev Drive) refuse the change,
		// and a real mismatch then fails the clone itself.
		let _ = fsctl(
			dst,
			FSCTL_SET_INTEGRITY_INFORMATION,
			&FSCTL_SET_INTEGRITY_INFORMATION_BUFFER {
				ChecksumAlgorithm: integrity.ChecksumAlgorithm,
				Reserved:          0,
				Flags:             integrity.Flags,
			},
			&mut (),
		);

		// Sparse while cloning, so extending the end of file allocates no
		// clusters the clone replaces anyway; ReFS also requires it of the
		// destination of a sparse source.
		fsctl(dst, FSCTL_SET_SPARSE, &FILE_SET_SPARSE_BUFFER { SetSparse: true }, &mut ())?;
		dst.set_len(len)?;

		let region_limit = MAX_REGION / cluster * cluster;
		let end = len.div_ceil(cluster) * cluster;
		let mut offset = 0;
		while offset < end {
			let count = region_limit.min(end - offset);
			let offset_i64 = i64::try_from(offset).map_err(|_| io::ErrorKind::FileTooLarge)?;
			let data = DUPLICATE_EXTENTS_DATA {
				FileHandle:       src.as_raw_handle() as _,
				SourceFileOffset: offset_i64,
				TargetFileOffset: offset_i64,
				ByteCount:        i64::try_from(count).map_err(|_| io::ErrorKind::FileTooLarge)?,
			};
			fsctl(dst, FSCTL_DUPLICATE_EXTENTS_TO_FILE, &data, &mut ())?;
			offset += count;
		}

		let src_is_sparse = src.metadata()?.file_attributes() & FILE_ATTRIBUTE_SPARSE_FILE != 0;
		if !src_is_sparse {
			fsctl(dst, FSCTL_SET_SPARSE, &FILE_SET_SPARSE_BUFFER { SetSparse: false }, &mut ())?;
		}
		Ok(())
	}

	/// Issues the filesystem control `code` on `file` with the plain-data
	/// `input` and `output` buffers; `()` passes no buffer.
	fn fsctl<I, O>(file: &File, code: u32, input: &I, output: &mut O) -> io::Result<()> {
		fn buffer_size<T>() -> u32 {
			u32::try_from(size_of::<T>()).expect("FSCTL buffer fits u32")
		}
		let input_ptr: *const c_void =
			if size_of::<I>() == 0 { std::ptr::null() } else { std::ptr::from_ref(input).cast() };
		let output_ptr: *mut c_void =
			if size_of::<O>() == 0 { std::ptr::null_mut() } else { std::ptr::from_mut(output).cast() };
		let mut returned = 0u32;
		// SAFETY: `file` owns a valid handle for the call, and each buffer
		// pointer is either null with size 0 or points to a live `I`/`O` of the
		// stated size. The call is synchronous, so no pointer outlives it.
		let ok = unsafe {
			DeviceIoControl(
				file.as_raw_handle() as _,
				code,
				input_ptr,
				buffer_size::<I>(),
				output_ptr,
				buffer_size::<O>(),
				&raw mut returned,
				std::ptr::null_mut(),
			)
		};
		if ok == 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
	}

	fn is_unavailable_error(err: &io::Error) -> bool {
		let Some(code) = err.raw_os_error() else {
			return false;
		};
		let code = code as u32;
		matches!(
			code,
			ERROR_INVALID_FUNCTION
				| ERROR_NOT_SUPPORTED
				| ERROR_NOT_SAME_DEVICE
				| ERROR_INVALID_PARAMETER
				| ERROR_ACCESS_DENIED
		)
	}

	fn copy_metadata_best_effort(src: &Path, dst: &Path) {
		let Ok(meta) = fs::symlink_metadata(src) else {
			return;
		};
		set_times_best_effort(dst, &meta);
		if !meta.file_type().is_symlink() {
			let _ = fs::set_permissions(dst, meta.permissions());
		}
	}

	fn set_times_best_effort(path: &Path, meta: &fs::Metadata) {
		let created = meta.created().ok().and_then(system_time_to_filetime);
		let accessed = meta.accessed().ok().and_then(system_time_to_filetime);
		let modified = meta.modified().ok().and_then(system_time_to_filetime);
		if created.is_none() && accessed.is_none() && modified.is_none() {
			return;
		}

		let mut opts = OpenOptions::new();
		opts.write(true);
		opts.custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
		let Ok(file) = opts.open(path) else { return };
		// SAFETY: `file` owns the HANDLE for the duration of the call. The
		// optional FILETIME pointers either reference stack locals that outlive
		// the call or are null when the corresponding timestamp is unavailable.
		let _ = unsafe {
			SetFileTime(
				file.as_raw_handle() as _,
				created
					.as_ref()
					.map_or(std::ptr::null(), |ft| ft as *const FILETIME),
				accessed
					.as_ref()
					.map_or(std::ptr::null(), |ft| ft as *const FILETIME),
				modified
					.as_ref()
					.map_or(std::ptr::null(), |ft| ft as *const FILETIME),
			)
		};
	}

	fn system_time_to_filetime(time: std::time::SystemTime) -> Option<FILETIME> {
		let dur = time.duration_since(std::time::UNIX_EPOCH).ok()?;
		// Windows FILETIME = 100-ns ticks since 1601-01-01.
		const EPOCH_DIFF_100NS: u64 = 116_444_736_000_000_000;
		let ticks = EPOCH_DIFF_100NS
			.checked_add(dur.as_secs().checked_mul(10_000_000)?)?
			.checked_add(u64::from(dur.subsec_nanos() / 100))?;
		Some(FILETIME {
			dwLowDateTime:  (ticks & 0xffff_ffff) as u32,
			dwHighDateTime: (ticks >> 32) as u32,
		})
	}
}
