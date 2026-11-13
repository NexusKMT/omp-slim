use std::{
	fs::{self, File, OpenOptions},
	io::{self, Write},
	path::{Path, PathBuf},
	sync::atomic::{AtomicU64, Ordering},
};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Publishes `contents` at `path` as one complete file without replacing an
/// existing callback.
///
/// The caller owns the private parent directory. A same-directory temporary
/// file and an atomic hard-link publication keep readers from observing a
/// partial value and make concurrent publishers race safely.
pub(crate) fn publish_once(path: &Path, contents: &[u8]) -> io::Result<()> {
	let parent = path
		.parent()
		.filter(|parent| !parent.is_empty())
		.ok_or_else(|| {
			io::Error::new(io::ErrorKind::InvalidInput, "callback path has no parent directory")
		})?;
	let file_name = path.file_name().ok_or_else(|| {
		io::Error::new(io::ErrorKind::InvalidInput, "callback path has no file name")
	})?;

	let (temporary_path, mut temporary) = create_temporary(parent, file_name)?;
	let result = (|| {
		temporary.write_all(contents)?;
		temporary.sync_all()?;
		drop(temporary);

		// `hard_link` creates the destination name atomically and fails when it
		// already exists on every supported filesystem. `rename` cannot provide
		// that no-replace guarantee portably.
		fs::hard_link(&temporary_path, path)?;
		Ok(())
	})();
	let cleanup_result = fs::remove_file(&temporary_path);

	match (result, cleanup_result) {
		(Err(error), _) => Err(error),
		(Ok(()), Ok(())) => Ok(()),
		(Ok(()), Err(error)) => Err(io::Error::new(
			error.kind(),
			format!("callback was published but its temporary link could not be removed: {error}"),
		)),
	}
}

fn create_temporary(parent: &Path, file_name: &std::ffi::OsStr) -> io::Result<(PathBuf, File)> {
	for _ in 0..128 {
		let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
		let name = format!(".{}.{}.{}.tmp", file_name.display(), std::process::id(), sequence);
		let path = parent.join(name);
		let mut options = OpenOptions::new();
		options.write(true).create_new(true);
		configure_private_mode(&mut options);
		match options.open(&path) {
			Ok(file) => {
				if let Err(error) = set_private_permissions(&file) {
					drop(file);
					let _ = fs::remove_file(&path);
					return Err(error);
				}
				return Ok((path, file));
			},
			Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {},
			Err(error) => return Err(error),
		}
	}

	Err(io::Error::new(
		io::ErrorKind::AlreadyExists,
		"could not allocate a unique callback temporary file",
	))
}

#[cfg(unix)]
fn configure_private_mode(options: &mut OpenOptions) {
	use std::os::unix::fs::OpenOptionsExt as _;
	options.mode(0o600);
}

#[cfg(not(unix))]
fn configure_private_mode(_options: &mut OpenOptions) {}

#[cfg(unix)]
fn set_private_permissions(file: &File) -> io::Result<()> {
	use std::os::unix::fs::PermissionsExt as _;
	file.set_permissions(fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_private_permissions(_file: &File) -> io::Result<()> {
	Ok(())
}


