//! Windows `PATHEXT`: which files count as executable, and how a bare name
//! resolves to `name.exe` & co..
//!
//! The logic is platform-neutral so it is tested everywhere; only
//! [`Pathext::from_env`] reads the process environment.

use std::{
	ffi::OsStr,
	path::{Path, PathBuf},
};

/// Executable extensions, lowercased, each with its leading dot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pathext {
	exts: Vec<String>,
}

impl Pathext {
	/// Extensions used when `PATHEXT` is unset or empty.
	pub const FALLBACK: [&'static str; 4] = [".com", ".exe", ".bat", ".cmd"];

	/// Parse a `PATHEXT` value (`;`-separated, leading dot optional,
	/// case-insensitive); `None` or an empty list falls back to
	/// [`Pathext::FALLBACK`].
	pub fn parse(value: Option<&OsStr>) -> Self {
		let exts: Vec<String> = value.map_or_default(|v| {
			v.to_string_lossy()
				.split(';')
				.map(str::trim)
				.filter(|e| !e.is_empty())
				.map(|e| {
					let e = e.to_ascii_lowercase();
					if e.starts_with('.') {
						e
					} else {
						format!(".{e}")
					}
				})
				.collect()
		});
		if exts.is_empty() {
			return Self { exts: Self::FALLBACK.iter().map(|e| (*e).to_owned()).collect() };
		}
		Self { exts }
	}

	/// The normalized suffixes, each with its leading dot.
	pub fn into_extensions(self) -> Vec<String> {
		self.exts
	}

	/// From the process's `PATHEXT`.
	pub fn from_env() -> Self {
		Self::parse(std::env::var_os("PATHEXT").as_deref())
	}

	/// Whether `path` has an executable extension (no filesystem access).
	pub fn has_executable_extension(&self, path: &Path) -> bool {
		path
			.extension()
			.is_some_and(|ext| self.exts.iter().any(|e| ext.eq_ignore_ascii_case(&e[1..])))
	}

	/// Whether `path` is an existing file with an executable extension.
	pub fn is_executable(&self, path: &Path) -> bool {
		self.has_executable_extension(path) && path.is_file()
	}

	/// `path` itself when it is executable, else the first `path` + extension
	/// that exists as a file.
	pub fn resolve(&self, path: PathBuf) -> Option<PathBuf> {
		if self.is_executable(&path) {
			return Some(path);
		}
		self.exts.iter().find_map(|ext| {
			let mut name = path.as_os_str().to_owned();
			name.push(ext);
			let candidate = PathBuf::from(name);
			candidate.is_file().then_some(candidate)
		})
	}
}


