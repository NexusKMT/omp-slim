//! The engine-neutral core of pi's `git` layers over the git binary.
//!
//! It provides the shared-checkout [`guard`] and in-process `git worktree add`
//! ([`AddRequest`]). The shell adapter (the engine's `git` tool,
//! [`crate::tools`]) runs these and falls back to
//! the git binary for everything a layer does not take.
//!
//! A layer is on through a variable truthy in the session or process
//! environment ([`GitLayers::from_env`]):
//!
//! - `PI_SMART_GIT`: `git worktree add` creates linked worktrees through
//!   [`pi_vcs`], described below.
//! - `PI_GIT_GUARD`: commands that discard or move work are refused in a
//!   checkout other sessions may share, and run after saving what they discard
//!   in a worktree of one's own; see [`guard`].
//!
//! `git worktree add` checks out every file of the target commit. pi-vcs
//! instead copy-on-write clones the source checkout (APFS `clonefile`, Linux
//! reflinks, Windows block cloning), registers the worktree metadata, and
//! rewrites only the paths that differ from the target commit, so ignored build
//! caches come along for free. Without a working clone backend it falls back to
//! an in-process checkout.
//!
//! Arguments are parsed the way git's parse-options does: bundled short flags
//! (`-qd`, `-qbname`), unique long-option abbreviations, `--no-` negations,
//! `--opt=value`, options mixed with operands, and `--`/`--end-of-options`.
//! The builtin serves `-f`, `-b`, `-B`, `-d`, `--checkout`, `--lock`,
//! `--reason`, `-q`, `--no-track`, `--[no-]guess-remote`, and
//! `--no-relative-paths`. Everything else — other subcommands and global
//! options, `--orphan`, `--no-checkout`, `--track`, `--relative-paths`, start
//! points that set up an upstream, bare/reftable/submodule repositories, env
//! redirection, and any invocation git would reject — runs the git binary with
//! the original arguments, so git keeps reporting its own errors.

pub mod guard;

use std::{
	io,
	path::{Path, PathBuf},
};

use pi_vcs::{WorktreeAddOptions, WorktreeClone, git::GitRepo};

/// Exit status of a git `fatal:` error.
pub const FATAL_EXIT: u8 = 128;

/// Git variables that pin a repository location to the launch checkout.
///
/// Forwarding them into a shell makes `git` ignore the command's working
/// directory and mutate the wrong worktree or index, so the shell rediscovers
/// the repository from `cwd` instead. Mirrors the `env_remove` list in
/// `crates/pi-vcs/src/git/cli.rs`.
pub const GIT_REPO_LOCATION_ENV_VARS: [&str; 6] = [
	"GIT_DIR",
	"GIT_COMMON_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
];

/// Whether `key` is one of [`GIT_REPO_LOCATION_ENV_VARS`]. Windows
/// environment lookups are case-insensitive, so `git_dir` binds there exactly
/// like `GIT_DIR`; POSIX names are case-sensitive.
#[cfg(windows)]
pub fn is_git_repo_location_var(key: &str) -> bool {
	GIT_REPO_LOCATION_ENV_VARS
		.iter()
		.any(|name| key.eq_ignore_ascii_case(name))
}

/// Whether `key` is one of [`GIT_REPO_LOCATION_ENV_VARS`]. Windows
/// environment lookups are case-insensitive, so `git_dir` binds there exactly
/// like `GIT_DIR`; POSIX names are case-sensitive.
#[cfg(not(windows))]
pub fn is_git_repo_location_var(key: &str) -> bool {
	GIT_REPO_LOCATION_ENV_VARS.contains(&key)
}

/// Whether a switch variable's value turns it on: present and not `""`,
/// `"0"` or `"false"` (any case).
pub fn flag_on(value: Option<&str>) -> bool {
	matches!(value, Some(value) if !value.is_empty() && value != "0" && !value.eq_ignore_ascii_case("false"))
}

/// Whether the command environment (the names of its exported variables)
/// points git at another repository or injects config; the in-process
/// `worktree add` reads neither.
pub fn env_redirected<'a>(mut exported: impl Iterator<Item = &'a str>) -> bool {
	exported.any(|name| {
		is_git_repo_location_var(name)
			|| name
				.get(..10)
				.is_some_and(|prefix| prefix.eq_ignore_ascii_case("GIT_CONFIG"))
	})
}

/// Lock reason git records for `--lock` without `--reason`.
const DEFAULT_LOCK_REASON: &str = "added with --lock";

/// Long options of `git worktree add`; each also has a `--no-` form.
const LONG_OPTIONS: [&str; 10] = [
	"force",
	"orphan",
	"detach",
	"checkout",
	"lock",
	"reason",
	"quiet",
	"track",
	"guess-remote",
	"relative-paths",
];

/// Behavior the `git` builtin layers over the binary.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GitLayers {
	/// Serve `git worktree add` through copy-on-write clones (`PI_SMART_GIT`).
	pub smart_worktree: bool,
	/// Refuse commands that discard or move shared work (`PI_GIT_GUARD`).
	pub guard:          bool,
}

impl GitLayers {
	/// The layers `var` (an environment lookup) turns on ([`flag_on`]).
	pub fn from_env<'a>(var: impl Fn(&str) -> Option<&'a str>) -> Self {
		Self {
			smart_worktree: flag_on(var("PI_SMART_GIT")),
			guard:          flag_on(var("PI_GIT_GUARD")),
		}
	}

	/// Whether any layer is on (otherwise `git` is the plain binary).
	pub const fn any(self) -> bool {
		self.smart_worktree || self.guard
	}
}

/// A parsed `git [-C <dir>]… worktree add` invocation.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct AddRequest {
	/// `-C` directories, applied in order.
	dirs:           Vec<String>,
	path:           String,
	commit_ish:     Option<String>,
	/// Branch named by `-b`/`-B`.
	new_branch:     Option<String>,
	/// `-B`: reset `new_branch` when it exists instead of refusing.
	reset:          bool,
	detach:         bool,
	quiet:          bool,
	/// `--lock` reason, written to the worktree's `locked` file.
	lock:           Option<String>,
	/// `--[no-]track`; `None` defers to `branch.autoSetupMerge`.
	track:          Option<bool>,
	/// `--[no-]guess-remote`; `None` defers to `worktree.guessRemote`.
	guess_remote:   Option<bool>,
	/// `--[no-]relative-paths`; `None` defers to `worktree.useRelativePaths`.
	relative_paths: Option<bool>,
}

impl AddRequest {
	/// Parses git's argv; `None` for anything but a well-formed `worktree add`
	/// without `--orphan` or `--no-checkout`.
	pub fn parse(args: &[String]) -> Option<Self> {
		let mut args = args.iter();
		let mut request = Self::default();
		loop {
			match args.next()?.as_str() {
				"-C" => request.dirs.push(args.next()?.clone()),
				// Pagers never start without a terminal; the rest only affect
				// advice and optional index refreshes.
				"-P" | "--no-pager" | "-p" | "--paginate" | "--no-optional-locks" | "--no-advice" => {},
				"worktree" => break,
				_ => return None,
			}
		}
		if args.next()? != "add" {
			return None;
		}

		let mut create_branch = None;
		let mut reset_branch = None;
		let (mut checkout, mut lock, mut orphan) = (true, false, false);
		let mut reason = None;
		let mut operands = Vec::new();
		while let Some(arg) = args.next() {
			if arg == "--" || arg == "--end-of-options" {
				operands.extend(args.by_ref().cloned());
			} else if let Some(long) = arg.strip_prefix("--") {
				let (name, inline) = match long.split_once('=') {
					Some((name, value)) => (name, Some(value)),
					None => (long, None),
				};
				let (option, negated) = long_option(&LONG_OPTIONS, name)?;
				if option == "reason" && !negated {
					reason = Some(match inline {
						Some(value) => value.to_owned(),
						None => args.next()?.clone(),
					});
					continue;
				}
				if inline.is_some() {
					return None;
				}
				match option {
					// Force only matters for targets already in use, which git
					// handles.
					"force" => {},
					"orphan" => orphan = !negated,
					"detach" => request.detach = !negated,
					"checkout" => checkout = !negated,
					"lock" => lock = !negated,
					"reason" => reason = None,
					"quiet" => request.quiet = !negated,
					"track" => request.track = Some(!negated),
					"guess-remote" => request.guess_remote = Some(!negated),
					"relative-paths" => request.relative_paths = Some(!negated),
					_ => unreachable!("LONG_OPTIONS entry without a handler"),
				}
			} else if let Some(shorts) = arg.strip_prefix('-').filter(|shorts| !shorts.is_empty()) {
				for (at, flag) in shorts.char_indices() {
					match flag {
						'f' => {},
						'd' => request.detach = true,
						'q' => request.quiet = true,
						'b' | 'B' => {
							let rest = &shorts[at + 1..];
							let name = if rest.is_empty() {
								args.next()?.clone()
							} else {
								rest.to_owned()
							};
							*(if flag == 'b' {
								&mut create_branch
							} else {
								&mut reset_branch
							}) = Some(name);
							break;
						},
						_ => return None,
					}
				}
			} else {
				operands.push(arg.clone());
			}
		}

		// git rejects these combinations; `--orphan` and `--no-checkout` leave
		// states pi-vcs does not produce.
		let modes = usize::from(create_branch.is_some())
			+ usize::from(reset_branch.is_some())
			+ usize::from(request.detach);
		if modes > 1 || orphan || !checkout || (reason.is_some() && !lock) {
			return None;
		}
		request.reset = reset_branch.is_some();
		request.new_branch = create_branch.or(reset_branch);
		request.lock = lock.then(|| reason.unwrap_or_else(|| DEFAULT_LOCK_REASON.to_owned()));

		let mut operands = operands.into_iter();
		request.path = operands.next()?;
		request.commit_ish = operands.next();
		operands.next().is_none().then_some(request)
	}

	/// Creates the worktree in-process, or reports that git must. `native`
	/// tells whether a path is a plain host filesystem object (pi-vfs
	/// `Fs::is_native_local`): pi-vcs works on those only.
	///
	/// Planning and cloning are synchronous filesystem work: run it off the
	/// shell's thread. It is not abandoned on cancellation: a
	/// half-registered worktree is worse than a late one.
	pub fn create(self, cwd: &Path, native: &dyn Fn(&Path) -> bool) -> Outcome {
		let Ok(Some(plan)) = self.plan(cwd, native) else {
			return Outcome::External;
		};
		// A failed branch update changes nothing, so git can report the refusal
		// (invalid name, concurrent update) in its own words.
		if let Some(branch) = &plan.branch
			&& plan
				.repo
				.create_branch(&plan.target, &branch.start, branch.reset)
				.is_err()
		{
			return Outcome::External;
		}
		match plan.add() {
			Ok(created) => Outcome::Created(created),
			Err(err) => Outcome::Failed(err.to_string()),
		}
	}

	/// Decides how pi-vcs reproduces this request; `None` hands it to git.
	fn plan(self, cwd: &Path, native: &dyn Fn(&Path) -> bool) -> pi_vcs::Result<Option<Plan>> {
		// `-` and `@{…}` name branches through reflogs, which git expands itself.
		if self.track == Some(true)
			|| self
				.commit_ish
				.as_deref()
				.is_some_and(|rev| rev == "-" || rev.contains("@{"))
		{
			return Ok(None);
		}
		let dir = self
			.dirs
			.iter()
			.fold(cwd.to_owned(), |dir, next| dir.join(next));
		let Some(path) = physical_path(&dir.join(&self.path)) else {
			return Ok(None);
		};
		if !dir.is_dir() || !native(&dir) || !native(&path) || !vacant(&path) {
			return Ok(None);
		}
		let Some(repo) = GitRepo::discover(&dir)? else {
			return Ok(None);
		};
		if repo.is_reftable()
			|| !native(repo.root())
			// A cloned submodule keeps a `.git` pointer that is wrong from the
			// new location; git leaves submodules unpopulated instead.
			|| repo.root().join(".gitmodules").exists()
			|| config_true(&repo, "core.bare")?
			|| resolve_flag(&repo, self.relative_paths, "worktree.useRelativePaths")?
		{
			return Ok(None);
		}
		let worktrees = repo.worktrees()?;
		// A registered worktree whose directory is gone needs git's `-f`
		// handling.
		if worktrees.iter().any(|entry| entry.path == path) {
			return Ok(None);
		}
		let checked_out = |branch: &str| {
			let full = format!("refs/heads/{branch}");
			worktrees
				.iter()
				.any(|entry| entry.branch.as_deref() == Some(full.as_str()))
		};
		let branch_exists = |branch: &str| repo.ref_exists(&format!("refs/heads/{branch}"));
		// Whether creating a branch at `start` stays untracked, as pi-vcs creates
		// it.
		let untracked = |start: &str| match self.track {
			Some(false) => Ok(true),
			_ => creates_untracked_branch(&repo, start),
		};

		let (branch, target, detach, preparing) = if let Some(name) = self.new_branch {
			let start = self.commit_ish.unwrap_or_else(|| "HEAD".to_owned());
			let was = if branch_exists(&name)? {
				if !self.reset || checked_out(&name) {
					return Ok(None);
				}
				Some(repo.short_id(&format!("refs/heads/{name}"))?)
			} else {
				None
			};
			if !untracked(&start)? {
				return Ok(None);
			}
			let preparing = match was {
				Some(was) => Preparing::Resetting { branch: name.clone(), was },
				None => Preparing::NewBranch(name.clone()),
			};
			let reset = matches!(preparing, Preparing::Resetting { .. });
			(Some(BranchStep { start, reset }), name, false, preparing)
		} else if self.detach {
			(None, self.commit_ish.unwrap_or_else(|| "HEAD".to_owned()), true, Preparing::Detached)
		} else if let Some(commit_ish) = self.commit_ish {
			if branch_exists(&commit_ish)? {
				if checked_out(&commit_ish) {
					return Ok(None);
				}
				(None, commit_ish.clone(), false, Preparing::Checkout(commit_ish))
			} else {
				// Not a local branch: git detaches at the commit, or DWIMs a
				// remote-tracking branch of that name when nothing resolves.
				(None, commit_ish, true, Preparing::Detached)
			}
		} else {
			// git names the branch after the worktree directory as spelled.
			let Some(name) = Path::new(&self.path)
				.file_name()
				.and_then(|name| name.to_str())
			else {
				return Ok(None);
			};
			let name = name.to_owned();
			if branch_exists(&name)? {
				if checked_out(&name) {
					return Ok(None);
				}
				(None, name.clone(), false, Preparing::Checkout(name))
			} else {
				if resolve_flag(&repo, self.guess_remote, "worktree.guessRemote")?
					|| !untracked("HEAD")?
				{
					return Ok(None);
				}
				let branch = BranchStep { start: "HEAD".to_owned(), reset: false };
				(Some(branch), name.clone(), false, Preparing::NewBranch(name))
			}
		};
		// Covers unborn HEAD and names that are not commits (trees, blobs,
		// typos).
		let start = branch
			.as_ref()
			.map_or(target.as_str(), |branch| branch.start.as_str());
		if repo.commit_details(start).is_err() {
			return Ok(None);
		}
		Ok(Some(Plan {
			repo,
			path,
			branch,
			target,
			detach,
			preparing,
			lock: self.lock,
			quiet: self.quiet,
		}))
	}
}

/// Resolves a long option spelling — exact, or a unique abbreviation as git's
/// parse-options accepts — among `options` to its name and whether it was
/// negated.
fn long_option(options: &[&'static str], spelled: &str) -> Option<(&'static str, bool)> {
	let spellings = || {
		options.iter().copied().flat_map(|option| {
			[(option, false), (option, true)].map(|(option, negated)| {
				let name = if negated {
					format!("no-{option}")
				} else {
					option.to_owned()
				};
				(name, option, negated)
			})
		})
	};
	if let Some((_, option, negated)) = spellings().find(|(name, ..)| name == spelled) {
		return Some((option, negated));
	}
	let mut prefixed =
		spellings().filter(|(name, ..)| !spelled.is_empty() && name.starts_with(spelled));
	let (_, option, negated) = prefixed.next()?;
	prefixed.next().is_none().then_some((option, negated))
}

/// What the builtin did with a `worktree add` request.
pub enum Outcome {
	/// Not reproducible in-process; the git binary runs instead.
	External,
	/// pi-vcs failed after starting; reported as a git `fatal:` error
	/// ([`FATAL_EXIT`]).
	Failed(String),
	/// Created: print [`Created::report`], then run [`Created::hook_args`].
	Created(Created),
}

/// Branch update preceding the worktree, as `git branch [-f]` would make it.
struct BranchStep {
	start: String,
	/// `-B` on an existing branch: move it rather than create it.
	reset: bool,
}

/// A resolved in-process `worktree add`.
struct Plan {
	repo:      GitRepo,
	path:      PathBuf,
	branch:    Option<BranchStep>,
	/// Branch to check out, or the commit-ish to detach at.
	target:    String,
	detach:    bool,
	preparing: Preparing,
	lock:      Option<String>,
	quiet:     bool,
}

impl Plan {
	/// Creates and optionally locks the worktree.
	fn add(self) -> pi_vcs::Result<Created> {
		self
			.repo
			.worktree_add(&self.path, &self.target, WorktreeAddOptions {
				detach:       self.detach,
				clone:        WorktreeClone::Auto,
				keep_changes: false,
			})?;
		let linked = GitRepo::require(&self.path)?;
		if let Some(reason) = &self.lock {
			// git's `write_file` terminates non-empty content with a newline.
			let content = if reason.is_empty() {
				String::new()
			} else {
				format!("{reason}\n")
			};
			std::fs::write(linked.info().git_dir.join("locked"), content)?;
		}
		Ok(Created {
			head:      linked.head_sha()?.unwrap_or_default(),
			oneline:   linked.log_onelines(1)?.pop().unwrap_or_default(),
			hook:      linked.hook_path("post-checkout")?,
			path:      self.path,
			preparing: self.preparing,
			quiet:     self.quiet,
		})
	}
}

/// Parenthesized detail of git's `Preparing worktree (…)` line.
enum Preparing {
	NewBranch(String),
	Resetting { branch: String, was: String },
	Checkout(String),
	Detached,
}

/// A worktree pi-vcs created, awaiting git's report and hook.
pub struct Created {
	path:      PathBuf,
	preparing: Preparing,
	/// Full id of the new worktree's HEAD.
	head:      String,
	/// `<short-id> <subject>` of the new worktree's HEAD.
	oneline:   String,
	hook:      Option<PathBuf>,
	quiet:     bool,
}

/// What `git worktree add` prints for a [`Created`] worktree.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Report {
	/// The `Preparing worktree (…)` line.
	pub stderr: String,
	/// The `HEAD is now at …` line.
	pub stdout: String,
}

impl Created {
	/// What `git worktree add` prints (nothing under `-q`). The shell prints
	/// it, then runs [`Created::hook_args`].
	pub fn report(&self) -> Report {
		if self.quiet {
			return Report::default();
		}
		let detail = match &self.preparing {
			Preparing::NewBranch(branch) => format!("new branch '{branch}'"),
			Preparing::Resetting { branch, was } => {
				format!("resetting branch '{branch}'; was at {was}")
			},
			Preparing::Checkout(branch) => format!("checking out '{branch}'"),
			Preparing::Detached => {
				format!("detached HEAD {}", self.oneline.split(' ').next().unwrap_or_default())
			},
		};
		Report {
			stderr: format!("Preparing worktree ({detail})\n"),
			stdout: format!("HEAD is now at {}\n", self.oneline),
		}
	}

	/// git's arguments (without `git`) that run `post-checkout` as git does,
	/// in the new worktree; `None` without a hook (status 0). The shell runs
	/// them with stdout sent to stderr, and their status becomes the
	/// command's.
	pub fn hook_args(self) -> Option<Vec<String>> {
		self.hook.as_ref()?;
		let null_oid = "0".repeat(self.head.len());
		Some(vec![
			"-C".to_owned(),
			self.path.to_string_lossy().into_owned(),
			"hook".to_owned(),
			"run".to_owned(),
			"--ignore-missing".to_owned(),
			"post-checkout".to_owned(),
			"--".to_owned(),
			null_oid,
			self.head,
			"1".to_owned(),
		])
	}
}

/// Whether git creates a branch from `start` without upstream tracking,
/// which is all `GitRepo::create_branch` does.
fn creates_untracked_branch(repo: &GitRepo, start: &str) -> pi_vcs::Result<bool> {
	if matches!(repo.config_get("branch.autoSetupMerge")?.as_deref(), Some("always" | "inherit")) {
		return Ok(false);
	}
	// `@{upstream}` forms and remote-tracking branches set up tracking by
	// default.
	Ok(!start.contains("@{")
		&& !start.starts_with("refs/remotes/")
		&& !repo.ref_exists(&format!("refs/remotes/{start}"))?)
}

/// A command-line switch when given, else the git boolean `key`.
fn resolve_flag(repo: &GitRepo, flag: Option<bool>, key: &str) -> pi_vcs::Result<bool> {
	flag.map_or_else(|| config_true(repo, key), Ok)
}

/// Reads a git boolean; valueless and unparsable entries count as unset.
fn config_true(repo: &GitRepo, key: &str) -> pi_vcs::Result<bool> {
	Ok(repo.config_get(key)?.is_some_and(|value| {
		matches!(value.to_ascii_lowercase().as_str(), "true" | "yes" | "on")
			|| value.parse::<i64>().is_ok_and(|number| number != 0)
	}))
}

/// Whether git may create a worktree at `path`: missing, or an empty directory.
fn vacant(path: &Path) -> bool {
	match std::fs::read_dir(path) {
		Ok(mut entries) => entries.next().is_none(),
		Err(err) => err.kind() == io::ErrorKind::NotFound,
	}
}

/// The absolute, symlink-free spelling git records for a worktree: the
/// deepest existing ancestor canonicalized, the missing tail appended.
/// `None` when the missing tail climbs (`missing/../x`).
#[cfg(not(windows))]
fn physical_path(path: &Path) -> Option<PathBuf> {
	let mut tail = Vec::new();
	for ancestor in path.ancestors() {
		if let Ok(real) = std::fs::canonicalize(ancestor) {
			return Some(tail.iter().rev().fold(real, |path, name| path.join(name)));
		}
		match ancestor.components().next_back()? {
			std::path::Component::Normal(name) => tail.push(name),
			_ => return None,
		}
	}
	None
}

/// Windows `canonicalize` yields verbatim (`\\?\`) paths git never writes;
/// `absolute` resolves `.` and `..` the way git's own normalization does.
#[cfg(windows)]
fn physical_path(path: &Path) -> Option<PathBuf> {
	std::path::absolute(path).ok()
}


