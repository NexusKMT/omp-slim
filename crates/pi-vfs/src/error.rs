//! Canonical I/O errors for provider and facade failures.
//!
//! Unix builds use raw OS error codes so utilities print the same `strerror`
//! text (and match the same `raw_os_error`) whether a failure came from the
//! host or from a provider.

use std::{io, path::Path};

use crate::path::url_scheme;

fn os(code: i32) -> io::Error {
	io::Error::from_raw_os_error(code)
}

/// An operation the filesystem (or this platform) does not implement.
pub fn unsupported(op: &str) -> io::Error {
	io::Error::new(io::ErrorKind::Unsupported, format!("{op}: Operation not supported"))
}

/// A URL path handed to a filesystem that has no provider for it.
pub fn no_provider(path: &Path) -> io::Error {
	let scheme = url_scheme(path).unwrap_or_default();
	io::Error::new(
		io::ErrorKind::NotFound,
		format!("No such file or directory (no filesystem provider for {scheme}://)"),
	)
}

/// The operation was cancelled through [`crate::Fs::with_cancellation`].
///
/// Deliberately not [`io::ErrorKind::Interrupted`]: std I/O loops retry that
/// kind, which would spin forever on a cancelled handle.
pub fn cancelled() -> io::Error {
	os(libc::ECANCELED)
}

/// Whether `err` is the cancellation error produced by [`cancelled`].
pub fn is_cancelled(err: &io::Error) -> bool {
	err.raw_os_error() == Some(libc::ECANCELED)
}

/// `EXDEV`: the operation would cross filesystem backends or devices.
pub fn crosses_devices() -> io::Error {
	os(libc::EXDEV)
}

/// `EROFS`: the filesystem is mounted read-only.
pub fn read_only_filesystem() -> io::Error {
	os(libc::EROFS)
}

/// `ENOTDIR`: a path component is not a directory.
pub fn not_a_directory() -> io::Error {
	os(libc::ENOTDIR)
}

/// `EISDIR`: the operation needs a non-directory.
pub fn is_a_directory() -> io::Error {
	os(libc::EISDIR)
}

/// `EINVAL`: e.g. `read_link` on something that is not a symbolic link.
pub fn invalid_argument() -> io::Error {
	os(libc::EINVAL)
}

/// `EACCES`: permission denied.
pub fn permission_denied() -> io::Error {
	os(libc::EACCES)
}

/// `EPERM`: the path names a descriptor overlay that cannot be modified.
pub(crate) fn not_permitted() -> io::Error {
	os(libc::EPERM)
}

/// `EEXIST`.
pub(crate) fn already_exists() -> io::Error {
	os(libc::EEXIST)
}

/// uucore's canonicalize loop error, kept textually identical.
pub(crate) fn symlink_loop() -> io::Error {
	io::Error::new(io::ErrorKind::InvalidInput, "Too many levels of symbolic links")
}

/// `NUL` byte inside a host path.
pub(crate) fn nul_in_path() -> io::Error {
	io::Error::new(io::ErrorKind::InvalidInput, "file name contained an unexpected NUL byte")
}
