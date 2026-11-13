//! Search-root resolution: the path text a caller supplies, turned into the
//! absolute spelling a walk or search starts from.

use std::{
	io,
	path::{Path, PathBuf},
};

use crate::walk::WalkError;

/// Absolute spelling of `path`: `scheme://` URLs and absolute host paths are
/// kept verbatim; relative host paths join the process working directory.
///
/// # Errors
/// The working directory cannot be read.
pub fn absolute(path: &Path) -> io::Result<PathBuf> {
	if pi_vfs::is_virtual_path(path) || path.is_absolute() {
		return Ok(path.to_path_buf());
	}
	Ok(pi_vfs::absolute_path(&std::env::current_dir()?, path))
}

/// Canonical spelling of an existing `path` on `fs`, or `path` itself when it
/// cannot be canonicalized.
///
/// A canonical form in another scheme (a URL whose provider resolves it to its
/// backing host file) is ignored, so URL roots keep their URL spelling.
pub async fn canonical(fs: &pi_vfs::Fs, path: PathBuf) -> PathBuf {
	match fs.canonicalize(&path).await {
		Ok(canonical) if pi_vfs::url_scheme(&canonical) == pi_vfs::url_scheme(&path) => canonical,
		_ => path,
	}
}

/// The canonical directory a walk of the user path `path` starts from,
/// statted and canonicalized through `fs`.
///
/// # Errors
/// [`WalkError::Root`] when the working directory cannot be read, `path`
/// does not exist, or it is not a directory
/// ([`io::ErrorKind::NotADirectory`]).
pub async fn resolve_dir(fs: &pi_vfs::Fs, path: &Path) -> Result<PathBuf, WalkError> {
	let root_error = |error| WalkError::Root { path: path.to_path_buf(), error };
	let root = absolute(path).map_err(root_error)?;
	let metadata = fs.metadata(&root).await.map_err(root_error)?;
	if !metadata.is_dir() {
		return Err(root_error(io::Error::new(
			io::ErrorKind::NotADirectory,
			"search path must be a directory",
		)));
	}
	Ok(canonical(fs, root).await)
}


