//! `which` builtin: locate executables in the shell's `PATH`.
//!
//! Ported from pi-shell's in-process `which` implementation.

use std::{
	io::Write,
	path::{Path, PathBuf},
};

use clap::Parser;
use pi_vfs::BlockingFs;

use crate::host::{Host, Utility};

/// Parsed `which` invocation.
#[derive(Parser, Debug)]
#[command(name = "which", about = "Locate a command's executable in the shell's PATH")]
pub(crate) struct WhichCli {
	/// Print all matching executables in PATH, not just the first.
	#[arg(short = 'a', long = "all")]
	all: bool,

	/// Silent (BSD): print nothing, report matches via the exit status only.
	#[arg(short = 's')]
	silent: bool,

	/// Command names to locate.
	#[arg(value_name = "name")]
	names: Vec<String>,
}

impl Utility for WhichCli {
	const NAME: &'static str = "which";
	const USAGE_ERROR: u8 = 2;

	fn run(self, host: &mut Host) -> i32 {
		// BSD and GNU which both treat a bare `which` as a usage error (exit 1).
		if self.names.is_empty() {
			let _ = writeln!(host.stderr, "usage: which [-as] program ...");
			return 1;
		}
		let search_path = host.var("PATH").unwrap_or_default().to_owned();
		let mut missing = false;
		for name in &self.names {
			let found = locate(host, &search_path, name, self.all);
			missing |= found.is_empty();
			if !self.silent {
				for path in found {
					let _ = writeln!(host.stdout, "{}", path.display());
				}
			}
		}
		i32::from(missing)
	}
}

/// The executables `name` stands for: itself when it contains a directory
/// separator, else the matches in the `search_path` directories, in order
/// (only the first unless `all`). Directories never match.
fn locate(host: &Host, search_path: &str, name: &str, all: bool) -> Vec<PathBuf> {
	let separators: &[char] = if cfg!(windows) { &['/', '\\'] } else { &['/'] };
	if name.contains(separators) {
		return runnable(host.fs(), &host.resolve(name)).into_iter().collect();
	}
	let mut found = Vec::new();
	for entry in std::env::split_paths(search_path) {
		// Quoted entries are common in Windows `PATH`s.
		let entry = if cfg!(windows) {
			PathBuf::from(entry.to_string_lossy().trim_matches('"'))
		} else {
			entry
		};
		let candidate = pi_vfs::join_path(&host.resolve(entry), Path::new(name));
		let Some(path) = runnable(host.fs(), &candidate) else {
			continue;
		};
		found.push(path);
		if !all {
			break;
		}
	}
	found
}

/// The file at `candidate` the user can run, if any. Windows has no execute
/// bit: a file runs when its extension is one `PATHEXT` lists, and `name`
/// also names `name.exe` and the like.
fn runnable(fs: &BlockingFs, candidate: &Path) -> Option<PathBuf> {
	if fs.is_dir(candidate) {
		return None;
	}
	#[cfg(windows)]
	{
		let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_owned());
		let extensions: Vec<String> = pathext
			.split(';')
			.map(|ext| ext.trim().trim_start_matches('.').to_ascii_lowercase())
			.filter(|ext| !ext.is_empty())
			.collect();
		let listed = candidate
			.extension()
			.and_then(|ext| ext.to_str())
			.is_some_and(|ext| extensions.iter().any(|known| known.eq_ignore_ascii_case(ext)));
		if listed && fs.is_file(candidate) {
			return Some(candidate.to_path_buf());
		}
		extensions.iter().find_map(|ext| {
			let mut with_ext = candidate.as_os_str().to_owned();
			with_ext.push(".");
			with_ext.push(ext);
			let with_ext = PathBuf::from(with_ext);
			fs.is_file(&with_ext).then_some(with_ext)
		})
	}
	#[cfg(not(windows))]
	{
		fs.access(candidate, false, false, true).is_ok().then(|| candidate.to_path_buf())
	}
}


