//! Cross-platform fallback isolation: git worktree, or plain recursive copy.
//!
//! When `lower` is a git working tree, [`start`](IsolationBackend::start)
//! materializes `merged` via `git worktree add --detach <merged> HEAD`.
//! Stop tears it down with `git worktree remove --force`. This lets git
//! itself manage refs/index/HEAD inside `merged`, keeping
//! [`diff`](IsolationBackend::diff) on the `git diff` path.
//!
//! Otherwise we do a vanilla recursive copy, preserving file modes and
//! mtimes so the default mtime-skipping diff path stays fast. There is no
//! file-system magic; the caller pays full filesystem-copy cost up front
//! and an `rm -rf` on teardown.

use std::{fs::FileType, path::Path};

use async_trait::async_trait;

use crate::{
	BackendKind, IsoError, IsoResult, IsolationBackend, ProbeResult, command_failed,
	tree::{self, TreeCopy},
};

pub struct RcopyBackend;

#[async_trait]
impl IsolationBackend for RcopyBackend {
	fn kind(&self) -> BackendKind {
		BackendKind::Rcopy
	}

	fn probe(&self) -> ProbeResult {
		// Pure-stdlib fallback path is always available. We don't probe for
		// `git` here because the non-git branch doesn't need it; the git
		// branch will surface a clear unavailable-error if `lower` is a git
		// tree but `git` is missing from PATH.
		ProbeResult::available()
	}

	fn start(&self, lower: &Path, merged: &Path) -> IsoResult<()> {
		let lower = tree::canonical_existing_dir(lower, "rcopy source", IsoError::other)?;
		let merged = std::path::absolute(merged).unwrap_or_else(|_| merged.to_path_buf());
		tree::prepare_destination(&merged, "rcopy", tree::remove_existing)?;
		if is_git_worktree(&lower) {
			git_worktree_add(&lower, &merged)?;
			// `worktree add --detach HEAD` lands on a clean checkout. omp
			// (and friends) expect `merged` to mirror `lower`'s **live**
			// working tree, so seed the index + working tree + untracked
			// files exactly as they exist in lower. No applyBaseline call
			// in the caller — every backend's post-`start` invariant is
			// the same.
			seed_dirty_state(&lower, &merged)
		} else {
			recursive_copy(&lower, &merged)
		}
	}

	fn stop(&self, merged: &Path) -> IsoResult<()> {
		// Best-effort: if we recognise this path as a registered worktree,
		// use git to remove it (so the parent repo's worktree list stays
		// consistent). Otherwise just rm -rf.
		if is_git_worktree(merged) {
			let _ = git_worktree_remove(merged);
		}
		match std::fs::remove_dir_all(merged) {
			Ok(()) => Ok(()),
			Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
			Err(err) => Err(IsoError::other(format!("unable to remove {}: {err}", merged.display()))),
		}
	}
}

fn is_git_worktree(path: &Path) -> bool {
	// A regular working tree has `.git` as a dir; a linked worktree has it
	// as a `gitdir: …` text file. Either way, presence of `.git` is the
	// signal git itself uses.
	std::fs::symlink_metadata(path.join(".git")).is_ok()
}

fn git_worktree_add(lower: &Path, merged: &Path) -> IsoResult<()> {
	let output = std::process::Command::new("git")
		.arg("-C")
		.arg(lower)
		.args(["worktree", "add", "--detach"])
		.arg(merged)
		.arg("HEAD")
		.stdin(std::process::Stdio::null())
		.stdout(std::process::Stdio::piped())
		.stderr(std::process::Stdio::piped())
		.output()
		.map_err(|err| {
			if err.kind() == std::io::ErrorKind::NotFound {
				IsoError::unavailable(
					"`git` not on PATH; rcopy cannot materialise a worktree from a git source",
				)
			} else {
				IsoError::other(format!("spawn git worktree add: {err}"))
			}
		})?;
	if output.status.success() {
		return Ok(());
	}
	Err(command_failed("git worktree add", output.status.code().unwrap_or(-1), &output.stderr))
}

fn git_worktree_remove(merged: &Path) -> IsoResult<()> {
	let output = std::process::Command::new("git")
		.arg("-C")
		.arg(merged)
		.args(["worktree", "remove", "--force"])
		.arg(merged)
		.stdin(std::process::Stdio::null())
		.stdout(std::process::Stdio::piped())
		.stderr(std::process::Stdio::piped())
		.output()
		.map_err(|err| IsoError::other(format!("spawn git worktree remove: {err}")))?;
	if output.status.success() {
		return Ok(());
	}
	Err(command_failed("git worktree remove", output.status.code().unwrap_or(-1), &output.stderr))
}

/// Replicate `lower`'s live working tree on top of a freshly-checked-out
/// worktree at `merged`. Three passes mirror what `git status` would
/// report at `lower`:
///
///  1. **Staged** — `git diff --binary --cached` from lower, applied to both
///     the index and the working tree of `merged`.
///  2. **Unstaged** — `git diff --binary` from lower, applied to the working
///     tree only.
///  3. **Untracked** — every path listed by `git ls-files --others
///     --exclude-standard -z` from lower, recursively copied into the same
///     relative location under `merged`.
///
/// Result: `git status` inside `merged` reports the same dirty set as
/// `lower` at the moment `start()` was called, so the rest of the PAL
/// contract ("merged mirrors lower's live working tree") holds for
/// rcopy on git inputs too.
fn seed_dirty_state(lower: &Path, merged: &Path) -> IsoResult<()> {
	let staged = git_capture(lower, &["diff", "--binary", "--no-color", "--cached"])?;
	if !staged.is_empty() {
		git_apply(merged, &staged, &["--cached"])?;
		git_apply(merged, &staged, &[])?;
	}

	let unstaged = git_capture(lower, &["diff", "--binary", "--no-color"])?;
	if !unstaged.is_empty() {
		git_apply(merged, &unstaged, &[])?;
	}

	let untracked = git_capture(lower, &["ls-files", "--others", "--exclude-standard", "-z"])?;
	for path_bytes in untracked.split(|b| *b == 0) {
		if path_bytes.is_empty() {
			continue;
		}
		let rel = std::str::from_utf8(path_bytes)
			.map_err(|err| IsoError::other(format!("untracked path is not valid UTF-8: {err}")))?;
		let src = lower.join(rel);
		let dst = merged.join(rel);
		if let Some(parent) = dst.parent() {
			std::fs::create_dir_all(parent)
				.map_err(|err| IsoError::other(format!("create {}: {err}", parent.display())))?;
		}
		copy_path(&src, &dst)?;
	}

	Ok(())
}

fn git_capture(cwd: &Path, args: &[&str]) -> IsoResult<Vec<u8>> {
	let output = std::process::Command::new("git")
		.arg("-C")
		.arg(cwd)
		.args(args)
		.stdin(std::process::Stdio::null())
		.stdout(std::process::Stdio::piped())
		.stderr(std::process::Stdio::piped())
		.output()
		.map_err(|err| {
			if err.kind() == std::io::ErrorKind::NotFound {
				IsoError::unavailable(
					"`git` not on PATH; rcopy cannot seed dirty state from a git source",
				)
			} else {
				IsoError::other(format!("spawn git {}: {err}", args.first().unwrap_or(&"<args>")))
			}
		})?;
	if !output.status.success() {
		return Err(command_failed(
			format_args!("git {}", args.join(" ")),
			output.status.code().unwrap_or(-1),
			&output.stderr,
		));
	}
	Ok(output.stdout)
}

fn git_apply(cwd: &Path, patch: &[u8], extra: &[&str]) -> IsoResult<()> {
	git_apply_with_program(Path::new("git"), cwd, patch, extra)
}

fn git_apply_with_program(
	program: &Path,
	cwd: &Path,
	patch: &[u8],
	extra: &[&str],
) -> IsoResult<()> {
	use std::io::{Read as _, Write as _};
	let mut child = std::process::Command::new(program)
		.arg("-C")
		.arg(cwd)
		.args(["apply", "--binary", "--whitespace=nowarn"])
		.args(extra)
		.stdin(std::process::Stdio::piped())
		.stdout(std::process::Stdio::null())
		.stderr(std::process::Stdio::piped())
		.spawn()
		.map_err(|err| {
			if err.kind() == std::io::ErrorKind::NotFound {
				IsoError::unavailable(
					"`git` not on PATH; rcopy cannot seed dirty state from a git source",
				)
			} else {
				IsoError::other(format!("spawn git apply: {err}"))
			}
		})?;
	let mut stderr = child
		.stderr
		.take()
		.ok_or_else(|| IsoError::other("git apply: child stderr was not piped".to_string()))?;
	let stderr_reader = std::thread::Builder::new()
		.name("pi-iso-git-apply-stderr".to_string())
		.spawn(move || {
			let mut bytes = Vec::new();
			stderr.read_to_end(&mut bytes).map(|_| bytes)
		})
		.map_err(|err| IsoError::other(format!("spawn git apply stderr reader: {err}")))?;
	let write_result = {
		let mut stdin = child
			.stdin
			.take()
			.ok_or_else(|| IsoError::other("git apply: child stdin was not piped".to_string()))?;
		let result = stdin.write_all(patch);
		drop(stdin);
		result
	};
	let status = child
		.wait()
		.map_err(|err| IsoError::other(format!("wait git apply: {err}")))?;
	let stderr = stderr_reader
		.join()
		.map_err(|_| IsoError::other("wait git apply: stderr reader panicked".to_string()))?
		.map_err(|err| IsoError::other(format!("read git apply stderr: {err}")))?;
	if status.success() {
		write_result.map_err(|err| IsoError::other(format!("write patch to git apply: {err}")))?;
		return Ok(());
	}
	Err(command_failed("git apply", status.code().unwrap_or(-1), &stderr))
}

/// Copy a single path (regular file, symlink, or directory) from `src`
/// to `dst`, preserving mtime. Used by the untracked-files pass;
/// directories are recursed via [`tree::copy_dir_contents`].
fn copy_path(src: &Path, dst: &Path) -> IsoResult<()> {
	let meta = std::fs::symlink_metadata(src)
		.map_err(|err| IsoError::other(format!("stat {}: {err}", src.display())))?;
	if meta.file_type().is_symlink() {
		tree::copy_symlink(src, dst, meta.file_type())
	} else if meta.file_type().is_dir() {
		std::fs::create_dir_all(dst)
			.map_err(|err| IsoError::other(format!("create {}: {err}", dst.display())))?;
		tree::copy_dir_contents(src, dst, &[], &Rcopy)?;
		Rcopy.finish_dir(src, dst)
	} else {
		Rcopy.file(src, dst, meta.file_type())
	}
}

/// Recursive copy preserving file modes (via `std::fs::copy`) and mtimes.
/// `copy` already preserves mtime on the macOS/Linux platforms we care
/// about, but we still set it explicitly to keep behaviour consistent
/// across hosts where the stdlib promise is weaker.
fn recursive_copy(lower: &Path, merged: &Path) -> IsoResult<()> {
	std::fs::create_dir_all(merged)
		.map_err(|err| IsoError::other(format!("create {}: {err}", merged.display())))?;
	tree::copy_dir_contents(lower, merged, &[], &Rcopy)
}

struct Rcopy;

impl TreeCopy for Rcopy {
	fn symlink(&self, src: &Path, dst: &Path, file_type: FileType) -> IsoResult<()> {
		tree::copy_symlink(src, dst, file_type)
	}

	fn file(&self, src: &Path, dst: &Path, _file_type: FileType) -> IsoResult<()> {
		std::fs::copy(src, dst).map_err(|err| {
			IsoError::other(format!("copy {} -> {}: {err}", src.display(), dst.display()))
		})?;
		copy_mtime(src, dst);
		Ok(())
	}

	fn finish_dir(&self, src: &Path, dst: &Path) -> IsoResult<()> {
		copy_mtime(src, dst);
		Ok(())
	}
}

/// Mirror `src`'s mtime onto the file or directory `dst`. Failures are
/// silently ignored — the mtime hint is an optimisation for [`crate::diff`],
/// not a correctness requirement.
fn copy_mtime(src: &Path, dst: &Path) {
	let Ok(mtime) = std::fs::metadata(src).and_then(|meta| meta.modified()) else {
		return;
	};
	let _ = open_for_times(dst).and_then(|file| file.set_modified(mtime));
}

/// Opens `path` (file or directory) with just enough access to set its
/// timestamps; Windows needs backup semantics to open a directory, and
/// write-attributes access works on readonly files.
#[cfg(windows)]
fn open_for_times(path: &Path) -> std::io::Result<std::fs::File> {
	use std::os::windows::fs::OpenOptionsExt;

	use windows_sys::Win32::Storage::FileSystem::{
		FILE_FLAG_BACKUP_SEMANTICS, FILE_WRITE_ATTRIBUTES,
	};

	std::fs::OpenOptions::new()
		.access_mode(FILE_WRITE_ATTRIBUTES)
		.custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
		.open(path)
}

/// Opens `path` (file or directory) read-only; `futimens` needs only
/// ownership, not write access.
#[cfg(not(windows))]
fn open_for_times(path: &Path) -> std::io::Result<std::fs::File> {
	std::fs::File::open(path)
}

#[cfg(all(test, unix))]
mod tests {
	use std::{
		fs,
		path::{Path, PathBuf},
		sync::atomic::{AtomicU64, Ordering},
		time::{SystemTime, UNIX_EPOCH},
	};

	use super::*;

	struct TempDirGuard(PathBuf);

	impl TempDirGuard {
		fn new() -> Self {
			static COUNTER: AtomicU64 = AtomicU64::new(0);
			let nanos = SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("system time should be after epoch")
				.as_nanos();
			let dir = std::env::temp_dir().join(format!(
				"pi-iso-rcopy-test-{}-{nanos}-{}",
				std::process::id(),
				COUNTER.fetch_add(1, Ordering::Relaxed)
			));
			fs::create_dir_all(&dir).expect("create temp test directory");
			Self(dir)
		}

		fn path(&self) -> &Path {
			&self.0
		}
	}

	impl Drop for TempDirGuard {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.0);
		}
	}

	#[test]
	fn git_apply_drains_stderr_while_writing_stdin() {
		use std::os::unix::fs::PermissionsExt as _;

		let root = TempDirGuard::new();
		let fake_git = root.path().join("git");
		fs::write(
			&fake_git,
			"#!/bin/sh\nprintf 'simulated apply failure\\n' >&2\nyes x | head -c 4194304 >&2\ncat \
			 >/dev/null\nexit 42\n",
		)
		.expect("write fake git");
		fs::set_permissions(&fake_git, fs::Permissions::from_mode(0o755))
			.expect("make fake git executable");

		let patch = vec![b'p'; 4 * 1024 * 1024];
		let err = git_apply_with_program(&fake_git, root.path(), &patch, &[])
			.expect_err("fake git apply should fail after consuming stdin");
		let message = err.to_string();
		assert!(message.starts_with("git apply (exit 42): simulated apply failure"));
	}
}
