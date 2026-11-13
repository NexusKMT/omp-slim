//! Deterministic endpoint naming shared by every process that dials or binds.
//!
//! The helpers here are pure so the naming rules (stem sanitizing, `sun_path`
//! relocation, Windows pipe shape) are testable on any host OS.

#[cfg(windows)]
use std::path::{self, Path};
#[cfg(unix)]
use std::{
	env,
	path::{Component, Path, PathBuf},
};

use xxhash_rust::xxh64::xxh64;

/// `name` with every char outside `[A-Za-z0-9._-]` replaced by `_`.
pub fn sanitize_stem(name: &str) -> String {
	name
		.chars()
		.map(|ch| {
			if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
				ch
			} else {
				'_'
			}
		})
		.collect()
}

/// 16 lowercase hex digits identifying `bytes`.
pub fn hash16(bytes: &[u8]) -> String {
	format!("{:016x}", xxh64(bytes, 0))
}

/// Private per-user directory that hosts relocated Unix sockets.
#[cfg_attr(windows, allow(dead_code, reason = "pure helper unit-tested on every host"))]
pub fn relocation_dir(euid: u32) -> String {
	format!("/tmp/omp-{euid}")
}

/// Unix socket path for `name` in the already-resolved `dir`.
///
/// `sun_path_max` is the size of `sockaddr_un::sun_path` including the NUL
/// terminator; a path that does not fit is relocated under
/// [`relocation_dir`] with a hashed basename.
#[cfg_attr(windows, allow(dead_code, reason = "pure helper unit-tested on every host"))]
pub fn unix_endpoint(dir: &str, name: &str, euid: u32, sun_path_max: usize) -> String {
	let stem = sanitize_stem(name);
	let direct = if dir.ends_with('/') {
		format!("{dir}{stem}.sock")
	} else {
		format!("{dir}/{stem}.sock")
	};
	if direct.len() < sun_path_max {
		return direct;
	}
	let mut key = Vec::with_capacity(dir.len() + 1 + name.len());
	key.extend_from_slice(dir.as_bytes());
	key.push(0);
	key.extend_from_slice(name.as_bytes());
	format!("{}/{}.sock", relocation_dir(euid), hash16(&key))
}

/// Windows named-pipe path for `name` in the already-resolved `dir`.
#[cfg_attr(not(windows), allow(dead_code, reason = "pure helper unit-tested on every host"))]
pub fn windows_pipe_name(dir: &str, name: &str) -> String {
	format!(r"\\.\pipe\omp-{}-{}", sanitize_stem(name), hash16(dir.to_lowercase().as_bytes()))
}

/// Size of `sockaddr_un::sun_path` on this platform, including the NUL.
#[cfg(unix)]
pub const SUN_PATH_MAX: usize = if cfg!(any(target_os = "linux", target_os = "android")) {
	108
} else {
	104
};

/// Lexically absolute, normalized form of `dir` (like Node's `path.resolve`).
#[cfg(unix)]
pub fn resolve_dir(dir: &str) -> String {
	let path = Path::new(dir);
	let joined = if path.is_absolute() {
		path.to_path_buf()
	} else {
		env::current_dir()
			.unwrap_or_else(|_| PathBuf::from("/"))
			.join(path)
	};
	let mut resolved = PathBuf::from("/");
	for component in joined.components() {
		match component {
			Component::ParentDir => {
				resolved.pop();
			},
			Component::Normal(part) => resolved.push(part),
			Component::RootDir | Component::CurDir | Component::Prefix(_) => {},
		}
	}
	resolved
		.into_string()
		.unwrap_or_else(|raw| raw.to_string_lossy().into_owned())
}

/// Lexically absolute, normalized form of `dir` (like Node's `path.resolve`).
#[cfg(windows)]
pub fn resolve_dir(dir: &str) -> String {
	let target = if dir.is_empty() {
		Path::new(".")
	} else {
		Path::new(dir)
	};
	let resolved = path::absolute(target).unwrap_or_else(|_| target.to_path_buf());
	let mut text = resolved
		.into_string()
		.unwrap_or_else(|raw| raw.to_string_lossy().into_owned());
	// `GetFullPathNameW` keeps a trailing separator; `path.resolve` drops it
	// except on a drive root such as `C:\`.
	while text.len() > 3 && text.ends_with(['\\', '/']) {
		text.pop();
	}
	text
}


