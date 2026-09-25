//! Backup naming for `ln` and `mv` through the injected filesystem.
//!
//! `uucore::backup_control::get_backup_path` probes numbered backups on the
//! host filesystem; these helpers probe the shell's filesystem instead and
//! keep URL (`scheme://`) spellings intact.

use std::{
	ffi::OsStr,
	path::{Path, PathBuf},
};

use pi_vfs::{BlockingFs, child_path, file_name, parent_path, with_file_name};
use uucore::backup_control::BackupMode;

/// The backup name for `path` under `mode`, probing numbered backups through
/// `filesystem`.
pub(crate) fn backup_path(
	filesystem: &BlockingFs,
	mode: BackupMode,
	path: &Path,
	suffix: impl AsRef<OsStr>,
) -> Option<PathBuf> {
	let simple = |suffix: &OsStr| {
		let mut name = file_name(path).unwrap_or_default().into_owned();
		name.push(suffix);
		with_file_name(path, name)
	};
	let numbered = || {
		(1u64..)
			.map(|index| simple(OsStr::new(&format!(".~{index}~"))))
			.find(|candidate| !filesystem.exists(candidate))
			.expect("backup index space is unbounded")
	};
	match mode {
		BackupMode::None => None,
		BackupMode::Simple => Some(simple(suffix.as_ref())),
		BackupMode::Numbered => Some(numbered()),
		BackupMode::Existing => {
			if filesystem.exists(simple(OsStr::new(".~1~"))) {
				Some(numbered())
			} else {
				Some(simple(suffix.as_ref()))
			}
		},
	}
}

/// Rebuilds the operand-relative display form of `backup`, created beside
/// `operand`.
pub(crate) fn backup_display(operand: &Path, backup: &Path) -> PathBuf {
	match (parent_path(operand), file_name(backup)) {
		(Some(parent), Some(name)) if !parent.as_os_str().is_empty() => child_path(parent, &name),
		(_, Some(name)) => PathBuf::from(name.into_owned()),
		_ => backup.to_path_buf(),
	}
}
