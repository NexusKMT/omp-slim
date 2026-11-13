//! `rmdir` builtin: remove empty directories.
//!
//! Diagnostics: `failed to remove directory` for ancestors, the
//! `Symbolic link not followed` hint, permission errors ignored on non-empty
//! directories under `--ignore-fail-on-non-empty`).

use std::{
	ffi::{OsStr, OsString},
	io::{self, Write},
	path::Path,
};

use clap::{Arg, ArgAction, ArgMatches, Command, builder::ValueParser};
use uucore::display::Quotable;

use crate::host::{Host, Utility, format_usage, matches_parser, strip_errno};

mod options {
	pub const IGNORE_FAIL_NON_EMPTY: &str = "ignore-fail-on-non-empty";
	pub const PARENTS: &str = "parents";
	pub const VERBOSE: &str = "verbose";
	pub const DIRS: &str = "dirs";
}

/// Parsed `rmdir` invocation.
pub(crate) struct Rmdir {
	matches: ArgMatches,
}

matches_parser!(Rmdir, app);

struct Opts {
	ignore: bool,
	parents: bool,
	verbose: bool,
}

impl Utility for Rmdir {
	const NAME: &'static str = "rmdir";

	fn run(self, host: &mut Host) -> i32 {
		let opts = Opts {
			ignore: self.matches.get_flag(options::IGNORE_FAIL_NON_EMPTY),
			parents: self.matches.get_flag(options::PARENTS),
			verbose: self.matches.get_flag(options::VERBOSE),
		};
		let dirs: Vec<OsString> = self
			.matches
			.get_many::<OsString>(options::DIRS)
			.unwrap_or_default()
			.cloned()
			.collect();
		for dir in &dirs {
			if host.is_cancelled() {
				break;
			}
			remove_operand(host, dir, &opts);
		}
		host.exit_code()
	}
}

fn app() -> Command {
	Command::new(Rmdir::NAME)
		.version("0.8.0")
		.about("Remove the DIRECTORY(ies), if they are empty.")
		.override_usage(format_usage("rmdir [OPTION]... DIRECTORY..."))
		.infer_long_args(true)
		.arg(
			Arg::new(options::IGNORE_FAIL_NON_EMPTY)
				.long(options::IGNORE_FAIL_NON_EMPTY)
				.help("ignore each failure to remove a non-empty directory")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::PARENTS)
				.short('p')
				.long(options::PARENTS)
				.help(
					"remove DIRECTORY and its ancestors; e.g., 'rmdir -p a/b' is similar to 'rmdir a/b \
					 a'",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::VERBOSE)
				.short('v')
				.long(options::VERBOSE)
				.help("output a diagnostic for every directory processed")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::DIRS)
				.action(ArgAction::Append)
				.num_args(1..)
				.required(true)
				.value_parser(ValueParser::os_string())
				.value_hint(clap::ValueHint::DirPath),
		)
}

/// GNU `errno_rmdir_non_empty`: ENOTEMPTY or EEXIST.
fn is_non_empty_error(error: &io::Error) -> bool {
	matches!(error.kind(), io::ErrorKind::DirectoryNotEmpty | io::ErrorKind::AlreadyExists)
}

/// GNU `errno_may_be_non_empty`: EACCES, EPERM, EROFS, EBUSY.
fn may_be_non_empty_error(error: &io::Error) -> bool {
	matches!(
		error.kind(),
		io::ErrorKind::PermissionDenied
			| io::ErrorKind::ReadOnlyFilesystem
			| io::ErrorKind::ResourceBusy
	)
}

/// GNU `ignorable_failure`.
fn ignorable(host: &Host, opts: &Opts, error: &io::Error, dir: &OsStr) -> bool {
	opts.ignore
		&& (is_non_empty_error(error)
			|| (may_be_non_empty_error(error) && directory_non_empty(host, dir)))
}

/// Whether `dir` is a readable directory holding at least one entry.
fn directory_non_empty(host: &Host, dir: &OsStr) -> bool {
	host.fs()
		.read_dir(host.resolve(dir))
		.is_ok_and(|mut entries| entries.next().is_some())
}

fn verbose(host: &mut Host, dir: &OsStr) {
	let _ = writeln!(host.stdout, "rmdir: removing directory, {}", Path::new(dir).quote());
}

fn rmdir(host: &Host, dir: &OsStr) -> io::Result<()> {
	#[cfg(windows)]
	reject_dot_component(host, dir)?;
	let resolved = host.resolve(dir);
	#[cfg(windows)]
	reject_trimmed_component(dir, &resolved)?;
	host.fs().remove_dir(resolved)
}

/// Win32 strips trailing dots and spaces from a component, so `rmdir e.` can
/// remove `e` or a child reached through a trimmed component. Refuse an operand
/// whose own spelling would trim, and a resolved path Win32 would still
/// normalize; a verbatim path is accessed literally, so its components are not
/// re-checked.
#[cfg(windows)]
fn reject_trimmed_component(dir: &OsStr, resolved: &Path) -> io::Result<()> {
	let operand = dir.as_encoded_bytes();
	if operand.starts_with(br"\\?\") || operand.starts_with(br"\??\") {
		return Ok(());
	}
	if pi_vfs::is_virtual_path(resolved) {
		return Ok(());
	}
	let joined = resolved.as_os_str().as_encoded_bytes();
	let verbatim = joined.starts_with(br"\\?\") || joined.starts_with(br"\??\");
	if !trimmable(operand) && (verbatim || !trimmable(joined)) {
		return Ok(());
	}
	Err(pi_vfs::invalid_argument())
}

/// Whether a component of `path` would lose a trailing dot or space to Win32
/// normalization (`.` and `..` name their own directories).
#[cfg(windows)]
fn trimmable(path: &[u8]) -> bool {
	path.split(|&byte| byte == b'/' || byte == b'\\')
		.any(|part| part != b"." && part != b".." && matches!(part.last(), Some(b'.' | b' ')))
}

/// POSIX `rmdir(2)` refuses a final `.` (EINVAL) or `..` (ENOTEMPTY) once the
/// directory holding it resolves. Win32 folds those components away instead,
/// so `rmdir e/.` would remove `e` and `rmdir x/..` the working directory.
#[cfg(windows)]
fn reject_dot_component(host: &Host, dir: &OsStr) -> io::Result<()> {
	let is_separator = |byte: &u8| matches!(byte, b'/' | b'\\');
	let bytes = dir.as_encoded_bytes();
	let end = bytes.iter().rposition(|byte| !is_separator(byte)).map_or(0, |i| i + 1);
	let trimmed = &bytes[..end];
	let start = trimmed.iter().rposition(is_separator).map_or(0, |i| i + 1);
	let refusal = match &trimmed[start..] {
		b"." => pi_vfs::invalid_argument(),
		b".." => io::Error::new(io::ErrorKind::DirectoryNotEmpty, "Directory not empty"),
		_ => return Ok(()),
	};
	let parent = if start == 0 {
		OsStr::new(".")
	} else {
		// SAFETY: `trimmed[..start]` ends just after an ASCII separator, a valid
		// encoded-bytes boundary.
		unsafe { OsStr::from_encoded_bytes_unchecked(&trimmed[..start]) }
	};
	if !host.fs().metadata(host.resolve(parent))?.is_dir() {
		return Err(pi_vfs::not_a_directory());
	}
	Err(refusal)
}

fn remove_operand(host: &mut Host, dir: &OsStr, opts: &Opts) {
	if opts.verbose {
		verbose(host, dir);
	}
	let Err(error) = rmdir(host, dir) else {
		if opts.parents {
			remove_parents(host, dir, opts);
		}
		return;
	};
	if ignorable(host, opts, &error, dir) {
		return;
	}
	let quoted = Path::new(dir).quote();
	if error.kind() == io::ErrorKind::NotADirectory && symlink_with_trailing_slash(host, dir) {
		host.error(format_args!("failed to remove {quoted}: Symbolic link not followed"), 1);
	} else {
		host.error(format_args!("failed to remove {quoted}: {}", strip_errno(&error)), 1);
	}
}

/// GNU's diagnosis of `rmdir symlink/` failing with ENOTDIR (Linux): the
/// operand ends in `/`, names a directory (or can't be followed for another
/// reason), and its last component is a symlink.
fn symlink_with_trailing_slash(host: &Host, dir: &OsStr) -> bool {
	let bytes = dir.as_encoded_bytes();
	if bytes.last() != Some(&b'/') {
		return false;
	}
	match host.fs().metadata(host.resolve(dir)) {
		Ok(meta) if !meta.is_dir() => return false,
		Err(error) if error.kind() == io::ErrorKind::NotADirectory => return false,
		_ => {},
	}
	let stripped = strip_trailing_slashes(bytes);
	// SAFETY: `stripped` is a prefix of `bytes` ending before an ASCII `/`.
	let stripped = unsafe { OsStr::from_encoded_bytes_unchecked(stripped) };
	host.fs()
		.symlink_metadata(host.resolve(stripped))
		.is_ok_and(|meta| meta.is_symlink())
}

/// GNU `strip_trailing_slashes`: drops trailing `/`s but keeps a lone root.
fn strip_trailing_slashes(bytes: &[u8]) -> &[u8] {
	let mut end = bytes.len();
	while end > 1 && bytes[end - 1] == b'/' {
		end -= 1;
	}
	&bytes[..end]
}

/// GNU `remove_parents`: removes each ancestor named in `dir`, stopping at the
/// first failure.
fn remove_parents(host: &mut Host, dir: &OsStr, opts: &Opts) {
	let mut current = strip_trailing_slashes(dir.as_encoded_bytes());
	loop {
		if host.is_cancelled() {
			return;
		}
		let Some(mut slash) = current.iter().rposition(|&b| b == b'/') else {
			return;
		};
		while slash > 0 && current[slash] == b'/' {
			slash -= 1;
		}
		current = &current[..=slash];
		// SAFETY: `current` is a prefix of the operand cut just before an ASCII `/`
		// (or the lone leading `/`), which is a valid encoded-bytes boundary.
		let parent = unsafe { OsStr::from_encoded_bytes_unchecked(current) };
		if opts.verbose {
			verbose(host, parent);
		}
		if let Err(error) = rmdir(host, parent) {
			if !ignorable(host, opts, &error, parent) {
				host.error(
					format_args!(
						"failed to remove directory {}: {}",
						Path::new(parent).quote(),
						strip_errno(&error)
					),
					1,
				);
			}
			return;
		}
	}
}


