//! Shared-checkout guard layered into the `git` builtin.
//!
//! Opt-in: active only when `PI_GIT_GUARD` is truthy in the session or process
//! environment (the coding agent sets it from its `bash.gitGuard` setting).
//! `PI_GIT_GUARD_OVNFS` supplies the ovnfs command for separate-checkout hints.
//!
//! Agents sharing one checkout lose work when one of them runs a git command
//! that discards uncommitted changes or moves HEAD. The guard judges every
//! `git` the shell dispatches — after expansion, in the directory it actually
//! runs in — by whose checkout that is.
//!
//! An ovnfs checkout (marked by repository-local `ovnfs.checkout`), a linked
//! worktree (`git worktree add`) of a repository with a main checkout, and a
//! submodule inside either belong to one line of work. There every command
//! runs, except that `stash pop`, `apply`, `drop`, `branch`, and `clear` refuse
//! entries saved on another branch or a detached HEAD, since every worktree
//! shares one stash list; and a command that discards uncommitted changes first
//! records them on [`DISCARDED_REF`]'s reflog, or is refused when it would also
//! discard changes inside submodules, which that record cannot hold.
//!
//! Any other checkout — a repository's main worktree, a clone, or one git is
//! redirected to — may be shared by concurrent sessions, and there the guard
//! refuses:
//!
//! - `stash`, except the read-only `stash list` and `stash show` and `stash
//!   create`, which writes only an object;
//! - `reset --hard`, and `reset` to a commit other than HEAD's;
//! - `switch`, and `checkout` of a branch or commit;
//! - `checkout` of paths and working-tree `restore`, unless a merge, rebase,
//!   cherry-pick, or revert is underway, where they pick conflict sides — and
//!   even then not forced (`-f`, `--force`, `--discard-changes`) or over the
//!   whole tree (`.`, `:/`, `*`).
//!
//! Index-only commands always run: `reset [<path>…]` and `restore --staged`
//! only unstage. Git started by path (`/usr/bin/git`) or by another program
//! (`xargs git`, `sh -c`) never reaches the builtin and is not judged.

use std::{
	borrow::Cow,
	path::{Path, PathBuf},
};

use pi_vcs::git::GitRepo;

use super::is_git_repo_location_var;

/// Exit status of a refused command; git's own for a refused operation.
pub const REFUSED_EXIT: u8 = 1;

/// Ref whose reflog records uncommitted changes before a command in a
/// one-agent checkout discards them. Git expires entries other than the
/// latest with every reflog (`gc.reflogExpireUnreachable`, 30 days).
const DISCARDED_REF: &str = "refs/omp/discarded";

/// Where to take a command the guard refuses in a shared checkout.
const OWN_WORKTREE: &str = "In a worktree of your own (git worktree add <path> [<branch>]) it \
                            runs, and uncommitted changes it would discard are saved first.";

fn own_checkout_hint(ovnfs: Option<&str>) -> Cow<'static, str> {
	match ovnfs.map(str::trim).filter(|command| !command.is_empty()) {
		Some(command) => Cow::Owned(format!(
			"In an ovnfs checkout of your own ({command} new --name <name>) it runs, and uncommitted \
			 changes it would discard are saved first. Add --rev <rev> to start at a clean commit or \
			 branch. Use {command} run --rev HEAD -- <command> for a clean-commit check without \
			 touching this checkout; --take SRC:PATH mixes in paths from the folder (.), the index \
			 (empty SRC), or another revision."
		)),
		None => Cow::Borrowed(OWN_WORKTREE),
	}
}

/// A judged `git` invocation, detached from the shell so its repository reads
/// can run off the shell's thread.
pub struct Review(Judgment);

/// What the builtin does with a judged command.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
	/// Run git.
	Run,
	/// Print this note to stderr, then run git.
	RunNoted(String),
	/// Print this message instead of running git.
	Refuse(String),
}

impl Review {
	/// Judges `args` (git's arguments, without `git`) as git would run them
	/// in `cwd` with the exported variables named by `exported`.
	pub fn of<'a>(
		cwd: &Path,
		exported: impl Iterator<Item = &'a str> + Clone,
		args: &[String],
	) -> Self {
		let Some(invocation) = Invocation::parse(args) else {
			return Self(Judgment::Allow);
		};
		let verdict = classify(invocation.sub, invocation.args);
		if verdict == Verdict::Allow {
			return Self(Judgment::Allow);
		}
		Self(Judgment::Check(invocation.sub, verdict, Site {
			dir:        invocation
				.dirs
				.iter()
				.fold(cwd.to_owned(), |dir, next| dir.join(next)),
			// GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, … retarget git as
			// `--git-dir` does.
			redirected: invocation.redirected || exported.clone().any(is_git_repo_location_var),
			// Configuration passed through the environment (`GIT_CONFIG_COUNT`)
			// may turn on `submodule.recurse`.
			recurse:    recurse_option(invocation.sub, invocation.args)
				.or(invocation.recurse)
				.or_else(|| {
					exported
						.clone()
						.any(|name| name == "GIT_CONFIG_COUNT")
						.then_some(true)
				}),
			command:    args.join(" "),
		}))
	}

	/// Whether git runs, reading and saving repository state as the verdict
	/// needs. `ovnfs` selects the separate-checkout hint. Blocks on repository
	/// I/O: run it off the shell's thread.
	pub fn decide(self, ovnfs: Option<&str>) -> Decision {
		let Judgment::Check(sub, verdict, site) = self.0 else {
			return Decision::Run;
		};
		match Place::of(&site) {
			Place::Private(repo) => in_private(&repo, sub, verdict, &site),
			place => in_shared(&place, sub, verdict, &site.dir)
				.map_or(Decision::Run, |refusal| Decision::Refuse(refusal.message(ovnfs))),
		}
	}
}

/// What the guard decided, or which repository read decides it.
enum Judgment {
	Allow,
	/// Decided by the checkout git runs in.
	Check(Sub, Verdict, Site),
}

/// Where git would run.
struct Site {
	/// The working directory with `-C` applied.
	dir:        PathBuf,
	/// Git is pointed at a repository other than the one found from `dir`.
	redirected: bool,
	/// `--[no-]recurse-submodules` or `-c submodule.recurse`, when given; the
	/// repository's `submodule.recurse` otherwise.
	recurse:    Option<bool>,
	/// Git's arguments, for the record of what discarded saved changes.
	command:    String,
}

/// The checkout a command runs in.
enum Place {
	/// Git is redirected away from the repository found from the directory.
	Redirected,
	/// The repository there cannot be read.
	Unreadable,
	/// No repository: git fails on its own.
	Outside,
	/// A checkout other sessions may be using.
	Shared(GitRepo),
	/// A checkout that belongs to one line of work.
	Private(GitRepo),
}

impl Place {
	fn of(site: &Site) -> Self {
		if site.redirected {
			return Self::Redirected;
		}
		match GitRepo::discover(&site.dir) {
			Ok(Some(repo)) if is_private(&repo) => Self::Private(repo),
			Ok(Some(repo)) => Self::Shared(repo),
			Ok(None) => Self::Outside,
			Err(_) => Self::Unreadable,
		}
	}
}

/// Whether `repo`'s checkout belongs to one line of work: an ovnfs checkout, a
/// worktree linked to a repository that has a main checkout of its own, or a
/// submodule inside either. Other checkouts may be shared, including every
/// worktree of a bare repository, where one of them is where a person works.
fn is_private(repo: &GitRepo) -> bool {
	if repo.config_has_local("ovnfs.checkout").unwrap_or(false) {
		return true;
	}
	let info = repo.info();
	if repo.is_linked_worktree() {
		return info
			.common_dir
			.file_name()
			.is_some_and(|name| name == ".git");
	}
	// A submodule's `.git` is a file pointing into its superproject's.
	info.git_entry_path.is_file()
		&& info.repo_root.parent().is_some_and(|parent| {
			matches!(GitRepo::discover(parent), Ok(Some(superproject)) if is_private(&superproject))
		})
}

/// Why `verdict`, run in `dir`, is refused in a checkout other sessions may be
/// using, if it is.
fn in_shared(place: &Place, sub: Sub, verdict: Verdict, dir: &Path) -> Option<Refusal> {
	let repo = match place {
		Place::Shared(repo) => Some(repo),
		// The repository found from the directory is not the one git changes.
		Place::Redirected => return Some(Refusal::Redirected(sub)),
		Place::Unreadable | Place::Outside | Place::Private(_) => None,
	};
	match verdict {
		Verdict::Allow => None,
		Verdict::Stash(_) => Some(Refusal::Stash),
		Verdict::Destructive => Some(Refusal::Destructive(sub)),
		Verdict::BranchMove => Some(Refusal::BranchMove(sub)),
		Verdict::ResetTo(rev, _) => match repo {
			Some(repo) => moves_head(repo, &rev).then_some(Refusal::CommitMove),
			// Outside a repository git fails on its own.
			None => matches!(place, Place::Unreadable).then_some(Refusal::CommitMove),
		},
		Verdict::ConflictOnly => outside_conflict(repo, sub),
		Verdict::CheckoutOne(operand) => {
			if repo.is_some_and(|repo| !names_path(repo, dir, &operand)) {
				Some(Refusal::BranchMove(sub))
			} else {
				outside_conflict(repo, sub)
			}
		},
	}
}

/// Whether `verdict` runs in a checkout of one line of work: it does, after
/// uncommitted changes it would discard are saved, unless it takes another
/// branch's stash entry or the save fails.
fn in_private(repo: &GitRepo, sub: Sub, verdict: Verdict, site: &Site) -> Decision {
	match verdict {
		Verdict::Allow | Verdict::Stash(Stash::Saves) | Verdict::BranchMove => Decision::Run,
		Verdict::Stash(Stash::Takes(op, entry)) => foreign_stash(repo, op, entry.as_deref())
			.map_or(Decision::Run, |refusal| Decision::Refuse(refusal.message(None))),
		Verdict::Stash(Stash::Clear) => foreign_stash(repo, "clear", None)
			.map_or(Decision::Run, |refusal| Decision::Refuse(refusal.message(None))),
		// `--soft` keeps the index and working tree. `--keep` keeps working-tree
		// changes but can drop staged ones, so it saves first.
		Verdict::ResetTo(_, true) => Decision::Run,
		Verdict::ResetTo(_, false) | Verdict::Destructive => save_then_run(repo, sub, site, false),
		Verdict::ConflictOnly => save_then_run(repo, sub, site, true),
		Verdict::CheckoutOne(operand) if names_path(repo, &site.dir, &operand) => {
			save_then_run(repo, sub, site, true)
		},
		Verdict::CheckoutOne(_) => Decision::Run,
	}
}

/// Whether `reset` to `rev` moves HEAD in `repo`.
fn moves_head(repo: &GitRepo, rev: &str) -> bool {
	match (repo.resolve_ref(rev), repo.head_sha()) {
		// Not a revision: git reads it as a path and only rewrites the index.
		(Ok(None), _) => false,
		(Ok(Some(target)), Ok(head)) => head.as_deref() != Some(target.as_str()),
		_ => true,
	}
}

/// Why a working-tree rewrite in `repo` is refused, if it is: it runs only
/// mid-merge, -rebase, -cherry-pick, or -revert. Without a readable repository
/// it is not mid-operation.
fn outside_conflict(repo: Option<&GitRepo>, sub: Sub) -> Option<Refusal> {
	(!repo.is_some_and(|repo| repo.operation_in_progress().unwrap_or(false)))
		.then_some(Refusal::OutsideConflict(sub))
}

/// Records `repo`'s uncommitted changes on [`DISCARDED_REF`] before the command
/// at `site` discards them. When git cannot write them, a `targeted` command
/// still runs mid-operation, where it picks a conflict side: git cannot record
/// unmerged entries.
fn save_then_run(repo: &GitRepo, sub: Sub, site: &Site, targeted: bool) -> Decision {
	// The record holds this repository's changes, not its submodules'. A
	// submodule's git directory outlives the `.gitmodules` a command restores.
	let info = repo.info();
	if recurses(repo, site.recurse)
		&& (!matches!(repo.submodule_paths(), Ok(paths) if paths.is_empty())
			|| info.git_dir.join("modules").is_dir()
			|| info.common_dir.join("modules").is_dir())
	{
		return Decision::Refuse(Refusal::Recursive(sub).message(None));
	}
	let id = match repo.stash_create() {
		Ok(None) => return Decision::Run,
		Ok(Some(id)) => id,
		Err(_) if targeted && repo.operation_in_progress().unwrap_or(false) => {
			return Decision::Run;
		},
		Err(err) => return Decision::Refuse(Refusal::Unsaved(sub, err.to_string()).message(None)),
	};
	// Once the changes are written, a failure to keep them is never exempt.
	if let Err(err) = repo.record_ref(DISCARDED_REF, &id, &format!("before git {}", site.command)) {
		return Decision::Refuse(Refusal::Unsaved(sub, err.to_string()).message(None));
	}
	let short = repo.short_id(&id).unwrap_or(id);
	Decision::RunNoted(format!(
		"git {}: saved your uncommitted changes as {short} on {DISCARDED_REF} first; git stash \
		 apply --index {short} brings them back.\n",
		sub.name()
	))
}

/// Whether git recurses into submodules: as `option` says when given, else as
/// `submodule.recurse` does. An unreadable setting counts as on.
fn recurses(repo: &GitRepo, option: Option<bool>) -> bool {
	option.unwrap_or_else(|| match repo.config_get("submodule.recurse") {
		Ok(None) => false,
		Ok(Some(value)) => {
			!matches!(value.to_ascii_lowercase().as_str(), "false" | "no" | "off" | "0")
		},
		Err(_) => true,
	})
}

/// Why `stash <op>` of `entry` (`stash@{0}` when `None`; every entry for
/// `clear`) is refused, if it is: an entry another branch or a detached HEAD
/// saved, or one whose saver is unknown, may be another session's.
fn foreign_stash(repo: &GitRepo, op: &'static str, entry: Option<&str>) -> Option<Refusal> {
	let target = StashTarget::of(entry);
	// A commit named outside the stash list is the caller's choice.
	if matches!(target, StashTarget::Commit) {
		return None;
	}
	let here = repo.current_branch().ok().flatten();
	let refuse = |entry: String, subject: Option<String>| {
		Some(Refusal::ForeignStash { op, entry, subject, here: here.clone() })
	};
	let (StashTarget::Entry(position), Ok(subjects)) = (target, repo.stash_subjects()) else {
		return refuse(entry.unwrap_or("stash@{0}").to_owned(), None);
	};
	let foreign = |subject: &&String| {
		!matches!(
			(saved_on(subject), here.as_deref()),
			(Saver::Branch(saver), Some(here)) if saver == here
		)
	};
	let (position, subject) = if op == "clear" {
		subjects
			.iter()
			.enumerate()
			.find(|(_, subject)| foreign(subject))?
	} else {
		// Past the end of the list git fails on its own.
		(position, subjects.get(position).filter(foreign)?)
	};
	refuse(format!("stash@{{{position}}}"), Some(subject.clone()))
}

/// The stash entry a `stash` subcommand names.
enum StashTarget {
	/// `stash@{n}`, `refs/stash@{n}`, or `n`.
	Entry(usize),
	/// A stash list entry not named by position (`stash@{yesterday}`).
	Unindexed,
	/// A commit outside the stash list.
	Commit,
}

impl StashTarget {
	fn of(entry: Option<&str>) -> Self {
		let Some(entry) = entry else {
			return Self::Entry(0);
		};
		if let Ok(position) = entry.parse() {
			return Self::Entry(position);
		}
		let Some(selector) = entry
			.strip_prefix("refs/stash")
			.or_else(|| entry.strip_prefix("stash"))
		else {
			return Self::Commit;
		};
		if selector.is_empty() {
			return Self::Entry(0);
		}
		if let Some(rest) = selector.strip_prefix("@{") {
			return rest
				.strip_suffix('}')
				.and_then(|position| position.parse().ok())
				.map_or(Self::Unindexed, Self::Entry);
		}
		// `stash^`, `stash~1`, `stash:<path>` reach into the list; any other
		// name only starts with `stash` (`stash-backup`).
		if selector.starts_with(['^', '~', ':', '@']) {
			Self::Unindexed
		} else {
			Self::Commit
		}
	}
}

/// What saved a stash entry, read from git's `WIP on <branch>: …` or `On
/// <branch>: …` subject.
#[derive(Debug, PartialEq, Eq)]
enum Saver<'a> {
	Branch(&'a str),
	Detached,
	Unknown,
}

fn saved_on(subject: &str) -> Saver<'_> {
	let saver = subject.split_once(": ").and_then(|(head, _)| {
		head
			.strip_prefix("WIP on ")
			.or_else(|| head.strip_prefix("On "))
	});
	match saver {
		Some("(no branch)") => Saver::Detached,
		Some(branch) if !branch.is_empty() => Saver::Branch(branch),
		_ => Saver::Unknown,
	}
}

/// Whether `checkout <operand>`, run in `dir`, restores a path: the operand
/// names no revision, and it is a glob or a file that exists there. Git takes
/// any other name as a branch to create from a remote-tracking one, through
/// whatever fetch refspec maps it, or fails on its own; and `A...B`, `A...`,
/// or `...B` as their merge base, even beside a file of that name.
fn names_path(repo: &GitRepo, dir: &Path, operand: &str) -> bool {
	!operand.contains("...")
		&& matches!(repo.resolve_ref(operand), Ok(None))
		&& (operand.contains(['*', '?', '[', '\\']) || dir.join(operand).symlink_metadata().is_ok())
}

/// A git subcommand the guard judges.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Sub {
	Stash,
	Reset,
	Checkout,
	Switch,
	Restore,
}

impl Sub {
	fn parse(name: &str) -> Option<Self> {
		Some(match name {
			"stash" => Self::Stash,
			"reset" => Self::Reset,
			"checkout" => Self::Checkout,
			"switch" => Self::Switch,
			"restore" => Self::Restore,
			_ => return None,
		})
	}

	const fn name(self) -> &'static str {
		match self {
			Self::Stash => "stash",
			Self::Reset => "reset",
			Self::Checkout => "checkout",
			Self::Switch => "switch",
			Self::Restore => "restore",
		}
	}

	/// Short and long options whose value may be the next argument.
	const fn valued(self) -> (&'static [char], &'static [&'static str]) {
		match self {
			Self::Stash => (&[], &[]),
			Self::Reset => (&['U'], &["pathspec-from-file", "unified", "inter-hunk-context"]),
			Self::Checkout => (&['b', 'B', 'U'], &[
				"orphan",
				"conflict",
				"pathspec-from-file",
				"unified",
				"inter-hunk-context",
			]),
			Self::Switch => (&['c', 'C'], &["orphan", "conflict"]),
			Self::Restore => (&['s', 'U'], &[
				"source",
				"conflict",
				"pathspec-from-file",
				"unified",
				"inter-hunk-context",
			]),
		}
	}

	/// Long options git accepts, which it also accepts abbreviated.
	const fn long_options(self) -> &'static [&'static str] {
		match self {
			// Only the subcommand and its operands matter.
			Self::Stash => &[],
			Self::Reset => &[
				"auto-advance",
				"hard",
				"intent-to-add",
				"inter-hunk-context",
				"keep",
				"merge",
				"mixed",
				"patch",
				"pathspec-file-nul",
				"pathspec-from-file",
				"quiet",
				"recurse-submodules",
				"refresh",
				"soft",
				"unified",
			],
			Self::Checkout => &[
				"auto-advance",
				"conflict",
				"detach",
				"force",
				"guess",
				"ignore-other-worktrees",
				"ignore-skip-worktree-bits",
				"inter-hunk-context",
				"merge",
				"orphan",
				"ours",
				"overlay",
				"overwrite-ignore",
				"patch",
				"pathspec-file-nul",
				"pathspec-from-file",
				"progress",
				"quiet",
				"recurse-submodules",
				"theirs",
				"track",
				"unified",
			],
			Self::Switch => &[
				"conflict",
				"create",
				"detach",
				"discard-changes",
				"force",
				"force-create",
				"guess",
				"ignore-other-worktrees",
				"merge",
				"orphan",
				"overwrite-ignore",
				"progress",
				"quiet",
				"recurse-submodules",
				"track",
			],
			Self::Restore => &[
				"conflict",
				"ignore-skip-worktree-bits",
				"ignore-unmerged",
				"inter-hunk-context",
				"merge",
				"ours",
				"overlay",
				"patch",
				"pathspec-file-nul",
				"pathspec-from-file",
				"progress",
				"quiet",
				"recurse-submodules",
				"source",
				"staged",
				"theirs",
				"unified",
				"worktree",
			],
		}
	}
}

/// `git [<global options>] <sub> <args>…` with a guarded subcommand.
struct Invocation<'a> {
	/// `-C` directories, applied in order.
	dirs:       Vec<&'a str>,
	/// `--git-dir`/`--work-tree` point git at another repository.
	redirected: bool,
	/// `-c submodule.recurse=<bool>`, the last one winning.
	recurse:    Option<bool>,
	sub:        Sub,
	args:       &'a [String],
}

impl<'a> Invocation<'a> {
	/// `None` when the subcommand is not guarded, or there is none.
	fn parse(args: &'a [String]) -> Option<Self> {
		let mut dirs = Vec::new();
		let mut redirected = false;
		let mut recurse = None;
		let mut at = 0;
		while let Some(arg) = args.get(at) {
			at += 1;
			match arg.as_str() {
				"-C" => {
					dirs.push(args.get(at)?.as_str());
					at += 1;
				},
				"--git-dir" | "--work-tree" => {
					redirected = true;
					at += 1;
				},
				"-c" => {
					let setting = args.get(at)?.to_ascii_lowercase();
					if let Some(value) = setting.strip_prefix("submodule.recurse") {
						recurse = Some(!matches!(value, "=false" | "=no" | "=off" | "=0"));
					}
					at += 1;
				},
				"--config-env" => {
					// Its value comes from the environment; assume it turns
					// recursion on.
					let setting = args.get(at)?.to_ascii_lowercase();
					if setting.starts_with("submodule.recurse=") {
						recurse = Some(true);
					}
					at += 1;
				},
				arg if arg
					.to_ascii_lowercase()
					.starts_with("--config-env=submodule.recurse=") =>
				{
					recurse = Some(true);
				},
				"--namespace" | "--super-prefix" | "--attr-source" => at += 1,
				arg if arg.starts_with("--git-dir=") || arg.starts_with("--work-tree=") => {
					redirected = true;
				},
				arg if arg.starts_with('-') => {},
				name => {
					return Some(Self {
						dirs,
						redirected,
						recurse,
						sub: Sub::parse(name)?,
						args: &args[at..],
					});
				},
			}
		}
		None
	}
}

/// One subcommand argument, read the way git's parse-options reads it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Arg<'a> {
	/// `--name` or `--name=value`, by name; an abbreviation by the name it
	/// stands for.
	Long(&'a str),
	/// `--no-name`, by the name it negates.
	Negated(&'a str),
	/// One letter of a short-option bundle: `-qf` yields `q`, then `f`.
	Short(char),
	/// A non-option argument before `--`.
	Operand(&'a str),
	/// An argument after `--`.
	Pathspec(&'a str),
}

/// Splits `sub`'s arguments into options and operands, skipping option values
/// so they are never mistaken for operands.
fn scan(sub: Sub, args: &[String]) -> Vec<Arg<'_>> {
	let (short_valued, long_valued) = sub.valued();
	let mut scanned = Vec::new();
	let mut options = true;
	let mut args = args.iter();
	while let Some(arg) = args.next() {
		if arg == "--" {
			scanned.extend(args.by_ref().map(|arg| Arg::Pathspec(arg)));
			break;
		}
		if !options {
			scanned.push(Arg::Operand(arg));
		} else if arg == "--end-of-options" {
			options = false;
		} else if let Some(long) = arg.strip_prefix("--") {
			let (spelled, inline) = long
				.split_once('=')
				.map_or((long, false), |(name, _)| (name, true));
			match super::long_option(sub.long_options(), spelled) {
				Some((name, true)) => scanned.push(Arg::Negated(name)),
				Some((name, false)) => {
					if !inline && long_valued.contains(&name) {
						args.next();
					}
					scanned.push(Arg::Long(name));
				},
				// Unknown or ambiguous: git refuses it on its own.
				None => scanned.push(Arg::Long(spelled)),
			}
		} else if let Some(bundle) = arg.strip_prefix('-').filter(|bundle| !bundle.is_empty()) {
			for (at, flag) in bundle.char_indices() {
				scanned.push(Arg::Short(flag));
				if short_valued.contains(&flag) {
					// The value is the rest of the bundle, else the next argument.
					if at + flag.len_utf8() == bundle.len() {
						args.next();
					}
					break;
				}
			}
		} else {
			scanned.push(Arg::Operand(arg));
		}
	}
	scanned
}

/// What a guarded command would do, judged from its arguments alone.
#[derive(Debug, PartialEq, Eq)]
enum Verdict {
	Allow,
	Stash(Stash),
	/// Discards the working tree or index wholesale; refused even mid-conflict.
	Destructive,
	/// `reset` to this revision without a pathspec: moves HEAD unless it names
	/// HEAD's commit. True for `--soft`, which discards no uncommitted change.
	ResetTo(String, bool),
	/// Rewrites working-tree files; allowed only mid-conflict.
	ConflictOnly,
	/// Switches branches or moves one; refused even mid-conflict.
	BranchMove,
	/// `checkout` with one operand and no pathspec: git switches to it when it
	/// names a commit and restores it as a path otherwise.
	CheckoutOne(String),
}

/// What a `stash` subcommand does to the working tree and the stash list.
#[derive(Debug, PartialEq, Eq)]
enum Stash {
	/// Moves uncommitted changes into the list (`push`, `save`, a bare
	/// `stash`), or adds a commit to it (`store`).
	Saves,
	/// `pop`, `apply`, `drop`, or `branch` of one entry: `stash@{0}` when
	/// `None`.
	Takes(&'static str, Option<String>),
	/// Drops every entry.
	Clear,
}

fn classify(sub: Sub, args: &[String]) -> Verdict {
	match sub {
		Sub::Stash => classify_stash(args),
		Sub::Reset => classify_reset(&scan(sub, args)),
		Sub::Checkout | Sub::Switch | Sub::Restore => classify_tree_write(sub, &scan(sub, args)),
	}
}

/// What `--[no-]recurse-submodules` says, the last one winning; `None` when
/// neither is given.
fn recurse_option(sub: Sub, args: &[String]) -> Option<bool> {
	scan(sub, args).iter().rev().find_map(|arg| match arg {
		Arg::Long("recurse-submodules") => Some(true),
		Arg::Negated("recurse-submodules") => Some(false),
		_ => None,
	})
}

/// `list`, `show`, and `create` touch neither the working tree nor the list.
fn classify_stash(args: &[String]) -> Verdict {
	// `branch <name> [<stash>]` names its entry second.
	let (op, entry_at) = match args.first().map(String::as_str) {
		Some("list" | "show" | "create") => return Verdict::Allow,
		Some("clear") => return Verdict::Stash(Stash::Clear),
		Some("pop") => ("pop", 0),
		Some("apply") => ("apply", 0),
		Some("drop") => ("drop", 0),
		Some("branch") => ("branch", 1),
		_ => return Verdict::Stash(Stash::Saves),
	};
	let entry = scan(Sub::Stash, &args[1..])
		.into_iter()
		.filter_map(|arg| match arg {
			Arg::Operand(operand) | Arg::Pathspec(operand) => Some(operand.to_owned()),
			Arg::Long(_) | Arg::Negated(_) | Arg::Short(_) => None,
		})
		.nth(entry_at);
	Verdict::Stash(Stash::Takes(op, entry))
}

/// `reset` moves HEAD only in its `reset [<mode>] <commit>` form: one revision
/// and no pathspec. With paths, a pathspec file, or `--patch` it rewrites index
/// entries only.
fn classify_reset(args: &[Arg<'_>]) -> Verdict {
	let flags = Flags::of(Sub::Reset, args);
	let mut operands = Vec::new();
	let mut pathspec = false;
	for arg in args {
		match *arg {
			Arg::Pathspec(_) => pathspec = true,
			Arg::Operand(operand) => operands.push(operand),
			Arg::Long(_) | Arg::Negated(_) | Arg::Short(_) => {},
		}
	}
	let index_only = pathspec || flags.any(&["patch", "pathspec-from-file"]);
	let mode = flags.last(&["hard", "soft", "mixed", "merge", "keep"]);
	match operands[..] {
		_ if mode == Some("hard") => Verdict::Destructive,
		[rev] if !index_only && !matches!(rev, "HEAD" | "@") => {
			// `--soft` discards no uncommitted change.
			Verdict::ResetTo(rev.to_owned(), mode == Some("soft"))
		},
		_ => Verdict::Allow,
	}
}

/// `checkout`, `switch`, and `restore` rewrite working-tree files or switch
/// branches — except `restore --staged` without `--worktree`, which only
/// unstages, and a bare `checkout`, which only reports.
fn classify_tree_write(sub: Sub, args: &[Arg<'_>]) -> Verdict {
	if sub == Sub::Checkout && args.is_empty() {
		return Verdict::Allow;
	}
	let flags = Flags::of(sub, args);
	let mut operands = Vec::new();
	let (mut new_branch, mut pathspec, mut whole_tree) = (false, false, false);
	for arg in args {
		match (sub, *arg) {
			(Sub::Checkout, Arg::Short('b' | 'B')) => new_branch = true,
			(Sub::Checkout, Arg::Operand(spec)) => {
				// `-` is the previous branch.
				new_branch |= spec == "-";
				whole_tree |= is_whole_tree(spec);
				operands.push(spec);
			},
			(Sub::Checkout | Sub::Restore, Arg::Pathspec(spec))
			| (Sub::Restore, Arg::Operand(spec)) => {
				whole_tree |= is_whole_tree(spec);
				pathspec = true;
			},
			_ => {},
		}
	}
	let forced = flags.on("force") || (sub == Sub::Switch && flags.on("discard-changes"));
	let branch = sub == Sub::Switch || new_branch || flags.any(&["orphan", "detach", "track"]);
	let paths = sub == Sub::Restore
		|| pathspec
		|| flags.any(&["ours", "theirs", "patch", "pathspec-from-file"]);
	if flags.on("staged") && !flags.on("worktree") {
		Verdict::Allow
	} else if forced || whole_tree {
		Verdict::Destructive
	} else if branch {
		Verdict::BranchMove
	} else if let [operand] = operands[..]
		&& !paths
	{
		Verdict::CheckoutOne(operand.to_owned())
	} else {
		Verdict::ConflictOnly
	}
}

/// A subcommand's flags as git reads them: of `--name`, `--no-name`, and the
/// short form, the last one given wins.
struct Flags<'a>(Vec<(&'a str, bool)>);

impl<'a> Flags<'a> {
	fn of(sub: Sub, args: &[Arg<'a>]) -> Self {
		Self(
			args
				.iter()
				.filter_map(|arg| match (sub, *arg) {
					(_, Arg::Long(name)) => Some((name, true)),
					(_, Arg::Negated(name)) => Some((name, false)),
					(Sub::Reset | Sub::Checkout | Sub::Restore, Arg::Short('p')) => {
						Some(("patch", true))
					},
					(Sub::Checkout | Sub::Switch, Arg::Short('f')) => Some(("force", true)),
					(Sub::Checkout, Arg::Short('2')) => Some(("ours", true)),
					(Sub::Checkout, Arg::Short('3')) => Some(("theirs", true)),
					(Sub::Checkout | Sub::Switch, Arg::Short('d')) => Some(("detach", true)),
					(Sub::Checkout | Sub::Switch, Arg::Short('t')) => Some(("track", true)),
					(Sub::Restore, Arg::Short('S')) => Some(("staged", true)),
					(Sub::Restore, Arg::Short('W')) => Some(("worktree", true)),
					_ => None,
				})
				.collect(),
		)
	}

	fn on(&self, name: &str) -> bool {
		self
			.0
			.iter()
			.rev()
			.find(|(flag, _)| *flag == name)
			.is_some_and(|&(_, on)| on)
	}

	fn any(&self, names: &[&str]) -> bool {
		names.iter().any(|name| self.on(name))
	}

	/// Which of `names`, mutually exclusive modes, was given last.
	fn last(&self, names: &[&str]) -> Option<&'a str> {
		self
			.0
			.iter()
			.rev()
			.find(|(flag, on)| *on && names.contains(flag))
			.map(|&(flag, _)| flag)
	}
}

/// Whether `spec` covers everything under the working directory or the
/// repository root: `.`, `*`, `:/`, or a path climbing out with `..`.
fn is_whole_tree(spec: &str) -> bool {
	let rest = spec
		.strip_prefix(":/")
		.or_else(|| spec.strip_prefix(":(top)"))
		.unwrap_or(spec);
	rest == "*" || rest.split('/').all(|part| matches!(part, "" | "." | ".."))
}

/// Why the guard refuses a command.
enum Refusal {
	Stash,
	Destructive(Sub),
	CommitMove,
	BranchMove(Sub),
	OutsideConflict(Sub),
	Redirected(Sub),
	/// `stash <op>` of `entry`, whose `subject` names its saver when read, in
	/// a worktree on branch `here` (`None` when detached).
	ForeignStash {
		op:      &'static str,
		entry:   String,
		subject: Option<String>,
		here:    Option<String>,
	},
	/// The uncommitted changes `sub` would discard could not be saved.
	Unsaved(Sub, String),
	/// `sub` would also discard changes inside submodules, which the save
	/// does not hold.
	Recursive(Sub),
}

impl Refusal {
	fn message(&self, ovnfs: Option<&str>) -> String {
		match self {
			Self::Stash => format!(
				"git stash is blocked by workspace policy — do not work around it.\nOther sessions \
				 may be using this checkout (it is not a private checkout): stash takes their \
				 uncommitted changes out of the working tree along with yours. git stash list, git \
				 stash show, and git stash create run here.\n{}\n",
				own_checkout_hint(ovnfs)
			),
			Self::Destructive(sub) => format!(
				"git {} is blocked: this form (--hard / --force / --discard-changes, or a whole-tree \
				 pathspec like `.`, `:/`, `*`) discards the working tree/index wholesale, and other \
				 sessions may be using this checkout (it is not a private checkout) — being \
				 mid-conflict does not make it safe.\nResolve conflicts with targeted forms instead: \
				 git checkout/restore --ours|--theirs <path>. Unstage with git reset <path> or git \
				 restore --staged <path>.\n{}\n",
				sub.name(),
				own_checkout_hint(ovnfs)
			),
			Self::CommitMove => format!(
				"git reset to another commit is blocked: it moves the branch checked out here, and \
				 other sessions may be using this checkout (it is not a private checkout).\nUnstaging \
				 is allowed — drop the commit argument: git reset [-q] [--] <path> (or bare git reset \
				 to unstage everything), or git restore --staged <path>.\n{}\n",
				own_checkout_hint(ovnfs)
			),
			Self::BranchMove(sub) => format!(
				"git {} to another branch or commit is blocked by workspace policy — do not work \
				 around it.\nOther sessions may be using this checkout (it is not a private \
				 checkout); switching branches moves HEAD and the working tree under them. A merge or \
				 rebase in progress does not make it safe. While resolving conflicts, git checkout -- \
				 <path> and git restore <path> still run; put -- before a path that shares its name \
				 with a branch. Inspect other revisions read-only with git show <rev>:<path> / git \
				 diff / git log.\n{}\n",
				sub.name(),
				own_checkout_hint(ovnfs)
			),
			Self::OutsideConflict(sub) => format!(
				"git {} is blocked by workspace policy — do not work around it.\nOther sessions may \
				 be using this checkout (it is not a private checkout); overwriting working-tree \
				 files discards uncommitted changes they may rely on. It is exempt only while a \
				 merge/rebase conflict is being resolved, and the repository is not in \
				 one.\nUnstaging is always allowed: git reset [<path>] / git restore --staged <path>. \
				 To undo working-tree edits here, edit forward; inspect history read-only with git \
				 diff/log/show.\n{}\n",
				sub.name(),
				own_checkout_hint(ovnfs)
			),
			Self::Redirected(sub) => format!(
				"git {} is blocked: the guard judges the checkout found from the working directory, \
				 and this command points git elsewhere (--git-dir / --work-tree / GIT_DIR / \
				 GIT_WORK_TREE / GIT_INDEX_FILE), so it cannot tell whose checkout it changes.\nRun \
				 it from inside the target checkout (cd or git -C) without overriding git's \
				 repository location.\n",
				sub.name()
			),
			Self::ForeignStash { op, entry, subject, here } => {
				let saver = match subject.as_deref().map(saved_on) {
					Some(Saver::Branch(branch)) => format!("was saved on {branch}"),
					Some(Saver::Detached) => "was saved on a detached HEAD".to_owned(),
					Some(Saver::Unknown) | None => "does not say which branch saved it".to_owned(),
				};
				let subject = subject
					.as_deref()
					.map_or_else(String::new, |subject| format!(" (\"{subject}\")"));
				let here = here.as_deref().map_or_else(
					|| "this worktree's HEAD is detached".to_owned(),
					|branch| format!("this worktree is on {branch}"),
				);
				let own = if *op == "clear" {
					"Drop your own entries one at a time: git stash drop stash@{n}."
				} else {
					"Name your own entry from git stash list (stash@{n}), or apply a commit by id: git \
					 stash apply <commit>."
				};
				format!(
					"git stash {op} is blocked: {entry}{subject} {saver}, and {here}. Every worktree \
					 of a repository shares one stash list, so the entry may be another session's \
					 work.\n{own}\n"
				)
			},
			Self::Unsaved(sub, error) => format!(
				"git {} is blocked: it would discard uncommitted changes, and saving them first \
				 failed: {}\nCommit them or save a patch first (git diff > <file>); a merge or rebase \
				 in progress ends with git merge --abort or git rebase --abort.\n",
				sub.name(),
				error.trim()
			),
			Self::Recursive(sub) => format!(
				"git {} is blocked: it recurses into submodules (--recurse-submodules or \
				 submodule.recurse), and uncommitted changes it discards there cannot be saved \
				 first.\nRun it without recursing (--no-recurse-submodules), or commit or save a \
				 patch of each submodule's changes first (git -C <submodule> diff > <file>).\n",
				sub.name()
			),
		}
	}
}


