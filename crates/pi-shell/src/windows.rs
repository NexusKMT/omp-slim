//! Windows host specifics: the `PATH` the shell starts with and 8.3 path
//! spellings.

use std::{
	collections::{HashMap, HashSet},
	env,
	os::windows::ffi::{OsStrExt, OsStringExt},
	path::{Path, PathBuf},
	process::Command,
};

use windows_sys::Win32::Storage::FileSystem::{GetLongPathNameW, GetShortPathNameW};
use winreg::{RegKey, enums::HKEY_LOCAL_MACHINE};

/// Add Git for Windows' tool directories to the shell's starting `PATH` in
/// `vars`, translating MSYS2-style entries to Windows paths.
pub fn configure_windows_path<S: std::hash::BuildHasher>(vars: &mut HashMap<String, String, S>) {
	let GitDiscovery { install_roots, paths: git_paths } = discover_git();
	if install_roots.is_empty() && git_paths.is_empty() {
		return;
	}

	let existing_path = vars.get("PATH").cloned().unwrap_or_default();

	// Translate MSYS2-style entries (e.g. /usr/bin, /mingw64/bin, /c/Users/...)
	// into Windows-native paths so the shell's std::path-based lookups can
	// resolve executables shipped with Git Bash.
	let mut segments: Vec<String> = Vec::new();
	let mut seen_normalized: HashSet<String> = HashSet::new();
	for raw in env::split_paths(&existing_path) {
		let raw_str = raw.to_string_lossy().into_owned();
		if raw_str.trim().is_empty() {
			continue;
		}
		let translated = translate_msys_segment(&raw_str, &install_roots).unwrap_or(raw_str);
		let normalized = normalize_path(Path::new(&translated));
		if normalized.is_empty() {
			segments.push(translated);
			continue;
		}
		if !seen_normalized.insert(normalized) {
			continue;
		}
		segments.push(translated);
	}

	for git_path in &git_paths {
		if !Path::new(git_path).is_dir() {
			continue;
		}
		let normalized = normalize_path(Path::new(git_path));
		if normalized.is_empty() || !seen_normalized.insert(normalized) {
			continue;
		}
		segments.push(git_path.clone());
	}

	let updated_path = segments.join(";");
	if updated_path != existing_path {
		vars.insert("PATH".to_owned(), updated_path);
	}
}

/// Expand 8.3 short-name components (e.g. `ADMINI~1`) in `path` to their long
/// form, leaving the path otherwise unchanged (symlinks and junctions kept).
pub fn expand_to_long_path(path: &Path) -> PathBuf {
	query_path_name(path, GetLongPathNameW)
}

/// The existing 8.3 spelling of `path`, without resolving symlinks or
/// junctions; the input when no short spelling is available.
pub fn get_short_path(path: &Path) -> PathBuf {
	query_path_name(path, GetShortPathNameW)
}

/// Both Win32 name queries preserve symlinks and junctions, unlike
/// canonicalize. A failed query (a missing path) returns the input.
fn query_path_name(
	path: &Path,
	query: unsafe extern "system" fn(*const u16, *mut u16, u32) -> u32,
) -> PathBuf {
	// Encode straight from the wide form: Windows `OsStr` is UTF-16 and may
	// not round-trip through UTF-8.
	let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
	// SAFETY: `wide` is NUL-terminated; a null buffer with length 0 asks only
	// for the required size (including the NUL).
	let needed = unsafe { query(wide.as_ptr(), std::ptr::null_mut(), 0) };
	if needed == 0 {
		return path.to_path_buf();
	}
	let mut buf = vec![0u16; needed as usize];
	loop {
		let Ok(len) = u32::try_from(buf.len()) else {
			return path.to_path_buf();
		};
		// SAFETY: `wide` is NUL-terminated and `buf` is writable for `len` u16s.
		let written = unsafe { query(wide.as_ptr(), buf.as_mut_ptr(), len) };
		if written == 0 {
			return path.to_path_buf();
		}
		// A result longer than the buffer reports the size it needs instead.
		if written as usize >= buf.len() {
			buf.resize(written as usize, 0);
			continue;
		}
		buf.truncate(written as usize);
		return PathBuf::from(std::ffi::OsString::from_wide(&buf));
	}
}

fn normalize_path(path: &Path) -> String {
	let path_str = path.to_string_lossy();
	let trimmed = path_str.trim();
	let unquoted = trimmed.trim_matches('"');
	if unquoted.is_empty() {
		return String::new();
	}

	let path = Path::new(unquoted);
	if let Ok(canonical) = path.canonicalize() {
		return canonical.to_string_lossy().into_owned();
	}

	let mut normalized = PathBuf::new();
	for component in path.components() {
		normalized.push(component.as_os_str());
	}

	normalized.to_string_lossy().into_owned()
}

struct GitDiscovery {
	install_roots: Vec<PathBuf>,
	paths:         Vec<String>,
}

fn discover_git() -> GitDiscovery {
	discover_git_with(query_git_install_path_from_registry, query_git_install_path_from_where)
}

fn discover_git_with<R, W>(registry_query: R, where_query: W) -> GitDiscovery
where
	R: FnOnce() -> Option<String>,
	W: FnOnce() -> Option<String>,
{
	let registry_path = registry_query();
	let where_path = where_query();
	let mut install_roots = Vec::new();
	let mut paths = Vec::new();
	let mut seen_roots = HashSet::new();
	let mut seen_paths = HashSet::new();

	for install_path in [registry_path, where_path].into_iter().flatten() {
		for path in git_paths_for_install_root(&install_path) {
			let normalized_path = normalize_path(Path::new(&path));
			if !normalized_path.is_empty() && seen_paths.insert(normalized_path) {
				paths.push(path);
			}
		}

		let root = PathBuf::from(&install_path);
		let normalized_root = normalize_path(&root);
		if !normalized_root.is_empty() && seen_roots.insert(normalized_root) {
			install_roots.push(root);
		}
	}

	GitDiscovery { install_roots, paths }
}

fn query_git_install_path_from_registry() -> Option<String> {
	let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
	let key_paths = ["SOFTWARE\\GitForWindows", "SOFTWARE\\WOW6432Node\\GitForWindows"];

	for key_path in key_paths {
		if let Ok(key) = hklm.open_subkey(key_path)
			&& let Ok(path) = key.get_value::<String, _>("InstallPath")
			&& !path.is_empty()
		{
			return Some(path);
		}
	}

	None
}

fn query_git_install_path_from_where() -> Option<String> {
	let output = Command::new("where").arg("git").output().ok()?;
	if !output.status.success() {
		return None;
	}

	let stdout = String::from_utf8_lossy(&output.stdout);
	let line = stdout.lines().next()?.trim();
	if line.is_empty() {
		return None;
	}

	let git_path = Path::new(line);
	let install_root = git_install_root_from_path(git_path)?;
	Some(install_root.to_string_lossy().into_owned())
}

fn git_install_root_from_path(git_path: &Path) -> Option<PathBuf> {
	let parent = git_path.parent()?;
	let parent_name = parent.file_name()?.to_string_lossy();

	if parent_name.eq_ignore_ascii_case("cmd") {
		return parent.parent().map(Path::to_path_buf);
	}

	if parent_name.eq_ignore_ascii_case("bin") {
		let grandparent = parent.parent()?;
		if let Some(grandparent_name) = grandparent.file_name() {
			let grandparent_name = grandparent_name.to_string_lossy();
			if grandparent_name.eq_ignore_ascii_case("usr")
				|| grandparent_name.eq_ignore_ascii_case("mingw64")
				|| grandparent_name.eq_ignore_ascii_case("mingw32")
			{
				return grandparent.parent().map(Path::to_path_buf);
			}
		}
		return Some(grandparent.to_path_buf());
	}

	parent.parent().map(Path::to_path_buf)
}

fn git_paths_for_install_root(install_root: &str) -> Vec<String> {
	let root = Path::new(install_root);
	let mut paths = Vec::new();

	let cmd = root.join("cmd");
	if has_git_command(&cmd) {
		paths.push(cmd.to_string_lossy().into_owned());
	}

	let bin = root.join("bin");
	if has_git_command(&bin) {
		paths.push(bin.to_string_lossy().into_owned());
	}

	let usr_bin = root.join("usr").join("bin");
	if has_git_command(&usr_bin) || usr_bin.join("ls.exe").is_file() {
		paths.push(usr_bin.to_string_lossy().into_owned());
	}

	paths
}

fn has_git_command(dir: &Path) -> bool {
	if !dir.is_dir() {
		return false;
	}

	["git.exe", "git.cmd", "git.bat"]
		.iter()
		.any(|name| dir.join(name).is_file())
}

/// Translate an MSYS2/Git Bash style path entry (e.g. `/usr/bin`,
/// `/mingw64/bin`, `/c/Users/foo`) into a Windows-native path so that
/// the shell's `std::path` based executable lookups can resolve binaries
/// shipped with Git Bash. Returns `None` when the segment is already a
/// Windows-style path or cannot be translated.
fn translate_msys_segment(segment: &str, install_roots: &[PathBuf]) -> Option<String> {
	let trimmed = segment.trim().trim_matches('"');
	if trimmed.is_empty() || is_windows_style_path(trimmed) {
		return None;
	}

	let forward = trimmed.replace('\\', "/");
	if !forward.starts_with('/') {
		return None;
	}

	// MSYS drive-letter mapping: /c -> C:\, /c/Users/foo -> C:\Users\foo.
	let rest = &forward[1..];
	if let Some((head, tail)) = rest.split_once('/') {
		if is_drive_letter(head) {
			let drive = head.to_ascii_uppercase();
			let windows_tail = tail.replace('/', "\\");
			return Some(format!("{drive}:\\{windows_tail}"));
		}
	} else if is_drive_letter(rest) {
		return Some(format!("{}:\\", rest.to_ascii_uppercase()));
	}

	// Anchor the remainder against any known Git/MSYS install root.
	let relative = rest.replace('/', "\\");
	for root in install_roots {
		let candidate = root.join(&relative);
		if candidate.is_dir() {
			return Some(candidate.to_string_lossy().into_owned());
		}
	}

	None
}

fn is_drive_letter(value: &str) -> bool {
	value.len() == 1
		&& value
			.chars()
			.next()
			.is_some_and(|c| c.is_ascii_alphabetic())
}

fn is_windows_style_path(value: &str) -> bool {
	let bytes = value.as_bytes();
	if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
		return true;
	}
	value.starts_with("\\\\")
}


