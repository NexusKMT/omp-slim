//! In-process local Git mutations.

use std::{
	borrow::Cow,
	collections::{BTreeMap, BTreeSet},
	ffi::OsStr,
	fs,
	path::{Path, PathBuf},
	process::{Command, Stdio},
};

use gix::bstr::{BString, ByteSlice};

use super::{
	GitRepo,
	filter::WorktreeFilter,
	normalize_path,
	open::{load_index_or_empty, load_index_or_head, status_with_fresh_index, status_with_index},
	read::literal_pathspec,
};
use crate::{
	error::{Error, Result},
	types::{
		CleanOptions, CommitAuthor, CommitOptions, DetachGitDirResult, ResetMode, RestoreOptions,
		WorktreeAddOptions, WorktreeAddResult, WorktreeClone,
	},
};

const INDEX_WRITE: gix::index::write::Options = gix::index::write::Options {
	extensions: gix::index::write::Extensions::None,
	skip_hash:  false,
};
/// Apply a ref update, synthesizing a committer for the reflog entry when no
/// identity is configured. Reflog lines require a signature, but git never
/// fails branch/reset/stash ref updates over missing identity — only
/// `git commit` demands one — so parity requires a fallback here.
pub(crate) fn update_reference(
	repo: &gix::Repository,
	op: &'static str,
	name: &str,
	id: gix::hash::ObjectId,
	expected: gix::refs::transaction::PreviousValue,
	message: &str,
	force_create_reflog: bool,
) -> Result<()> {
	let name: gix::refs::FullName = name.try_into().map_err(|err| Error::backend(op, err))?;
	let edit = gix::refs::transaction::RefEdit {
		change: gix::refs::transaction::Change::Update {
			log: gix::refs::transaction::LogChange {
				mode: gix::refs::transaction::RefLog::AndReference,
				force_create_reflog,
				message: message.into(),
			},
			expected,
			new: gix::refs::Target::Object(id),
		},
		name,
		deref: false,
	};
	let now;
	let committer = if let Some(signature) = repo
		.committer()
		.transpose()
		.map_err(|err| Error::backend(op, err))?
	{
		signature
	} else {
		now = format!(
			"{} +0000",
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.map_or(0, |elapsed| elapsed.as_secs())
		);
		gix::actor::SignatureRef { name: "omp".into(), email: "omp@localhost".into(), time: &now }
	};
	repo
		.edit_references_as(Some(edit), Some(committer))
		.map_err(|err| Error::backend(op, err))?;
	Ok(())
}

impl GitRepo {
	/// Stage worktree files, or every change when `files` is empty.
	///
	/// Empty `files` matches `git add -A`: refresh tracked paths and add
	/// untracked files that survive the standard ignore stack (nested
	/// `.gitignore`, exclude files). Content goes through the worktree-to-git
	/// filter pipeline (`.gitattributes` `text`/`eol`, `core.autocrlf`, clean
	/// drivers) so the index blob matches what `git add` would store — a
	/// `*.cmd text eol=crlf` file stages as LF even though the checkout is
	/// CRLF. When `core.precomposeUnicode` is set,
	/// a worktree path that is a unicode-composition equivalent of an
	/// existing index path (macOS NFD dirent vs NFC index name) is stored
	/// under the index name. Unrelated names that share an inode (hardlinks)
	/// and distinct NFC/NFD files when precompose is off stay separate.
	pub fn stage_files(&self, files: &[String]) -> Result<()> {
		let repo = self.gix()?;
		let mut index = load_index_or_head(&repo, "git add")?;
		// Whole seconds since the epoch before any file is stat'ed (see
		// `stage_one`).
		let staging_started = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.map_or(0, |elapsed| elapsed.as_secs());
		let all = files.is_empty();
		let mut requested: BTreeSet<String> = files
			.iter()
			.map(|path| normalize_stage_path(path))
			.collect();
		if precompose_unicode_enabled(&repo) {
			requested = remap_composed_index_paths(self.root(), &index, requested);
		}
		let mut selected = collect_stage_paths(self, &requested, all)?;
		for entry in index.entries() {
			let path = entry.path(&index).to_str_lossy().into_owned();
			if (all
				|| requested
					.iter()
					.any(|wanted| stage_path_matches(&path, wanted)))
				&& fs::symlink_metadata(self.root().join(&path)).is_ok()
			{
				selected.insert(path);
			}
		}
		index.remove_entries(|_, path, _| {
			let path = path.to_str_lossy();
			(all
				|| requested
					.iter()
					.any(|wanted| stage_path_matches(&path, wanted)))
				&& !selected.contains(path.as_ref())
		});
		let (mut filter, filter_index) = repo
			.filter_pipeline(None)
			.map_err(|err| Error::backend("git add", err))?;
		// Hash every selected path first, then rewrite the index in one pass:
		// removing entries path by path rescans the whole index each time.
		let mut replaced = std::collections::HashSet::<BString>::new();
		let mut staged = Vec::new();
		for path in selected {
			match stage_one(self.root(), &mut filter, &filter_index, &path, staging_started)? {
				Staged::Entry(entry) => {
					replaced.insert(path.into());
					staged.push(entry);
				},
				Staged::Removed => {
					replaced.insert(path.into());
				},
				Staged::Kept => {},
			}
		}
		index.remove_entries(|_, path, _| replaced.contains(path));
		// A kept entry's stat as new as the old index is racy: only that
		// index's timestamp makes git re-check the file's content, and the
		// index written here is newer, so the stat is dropped to keep the
		// check (git smudges such entries when it writes an index).
		let racy_from = index.timestamp();
		for entry in index.entries_mut() {
			if entry.stat.is_racy(racy_from, Default::default()) {
				entry.stat = gix::index::entry::Stat::default();
			}
		}
		for entry in staged {
			index.dangerously_push_entry(
				entry.stat,
				entry.id,
				gix::index::entry::Flags::empty(),
				entry.mode,
				entry.path.as_bstr(),
			);
		}
		index.sort_entries();
		index
			.write(INDEX_WRITE)
			.map_err(|err| Error::backend("git add", err))
	}

	/// Reset selected index entries to HEAD while preserving the worktree.
	pub fn unstage(&self, files: &[String]) -> Result<()> {
		let repo = self.gix()?;
		let head = head_tree(&repo)?;
		let head_index = index_for_tree(&repo, head.as_ref())?;
		let mut current = load_index_or_head(&repo, "git reset")?;
		copy_index_paths(&mut current, &head_index, files);
		current
			.write(INDEX_WRITE)
			.map_err(|err| Error::backend("git reset", err))
	}

	/// Create a commit and return its object id. With `commit.gpgSign` enabled
	/// the object is written by `git commit-tree -S` so Git runs the
	/// configured signer; a signer failure leaves HEAD unchanged.
	pub fn commit_create(&self, message: &str, options: &CommitOptions) -> Result<String> {
		let repo = self.gix()?;
		// Git rejects a malformed value before doing any work; reading it as
		// `false` would silently write unsigned commits.
		let sign = repo
			.config_snapshot()
			.try_boolean("commit.gpgSign")
			.transpose()
			.map_err(|err| Error::backend("git commit read commit.gpgSign", err))?
			.unwrap_or(false);
		run_commit_hook(self, "pre-commit", &[])?;
		let mut head = repo
			.head()
			.map_err(|err| Error::backend("git commit", err))?;
		let old_commit = head
			.try_peel_to_id()
			.map_err(|err| Error::backend("git commit", err))?
			.map(|id| id.detach());
		let index = load_index_or_head(&repo, "git commit")?;
		let tree = if options.files.is_empty() {
			write_index_tree(&repo, &index)?
		} else {
			let base = index_for_tree(
				&repo,
				old_commit
					.as_ref()
					.map(|id| commit_tree(&repo, id))
					.transpose()?
					.as_ref(),
			)?;
			let mut partial = base;
			copy_index_paths(&mut partial, &index, &options.files);
			write_index_tree(&repo, &partial)?
		};
		let (parents, inherited_author) = if options.amend {
			let id = old_commit
				.ok_or_else(|| Error::backend("git commit", "cannot amend an unborn HEAD"))?;
			let commit = repo
				.find_commit(id)
				.map_err(|err| Error::backend("git commit", err))?;
			let parents: Vec<gix::hash::ObjectId> =
				commit.parent_ids().map(|id| id.detach()).collect();
			let author = commit
				.author()
				.map_err(|err| Error::backend("git commit", err))?
				.to_owned()
				.map_err(|err| Error::backend("git commit", err))?;
			(parents, Some(author))
		} else {
			(old_commit.into_iter().collect(), None)
		};
		if !options.allow_empty {
			if let Some(parent) = parents.first() {
				if commit_tree(&repo, parent)? == tree {
					return Err(Error::backend("git commit", "nothing to commit, working tree clean"));
				}
			} else if tree == repo.empty_tree().id {
				return Err(Error::backend("git commit", "nothing to commit, working tree clean"));
			}
		}
		let committer = repo
			.committer()
			.ok_or_else(|| Error::backend("git commit", "committer identity is not configured"))?
			.map_err(|err| Error::backend("git commit", err))?;
		let override_author = options.author.as_ref().map(signature_for).transpose()?;
		let mut author_time = gix::date::parse::TimeBuf::default();
		let author = if let Some(author) = override_author.as_ref() {
			author.to_ref(&mut author_time)
		} else if let Some(author) = inherited_author.as_ref() {
			author.to_ref(&mut author_time)
		} else {
			repo
				.author()
				.ok_or_else(|| Error::backend("git commit", "author identity is not configured"))?
				.map_err(|err| Error::backend("git commit", err))?
		};
		let message_path = self.info().git_dir.join("COMMIT_EDITMSG");
		fs::write(&message_path, message)?;
		run_commit_hook(self, "commit-msg", &[message_path.as_os_str()])?;
		let message = fs::read_to_string(&message_path)
			.map_err(|err| Error::backend("git commit read commit-msg result", err))?;
		let id = if sign {
			sign_commit(self, &message, tree, &parents, author, committer)?
		} else {
			repo
				.new_commit_as(committer, author, message, tree, parents)
				.map_err(|err| Error::backend("git commit", err))?
				.id
		};
		let expected = old_commit
			.map_or(gix::refs::transaction::PreviousValue::MustNotExist, |old| {
				gix::refs::transaction::PreviousValue::MustExistAndMatch(old.into())
			});
		repo
			.edit_reference(gix::refs::transaction::RefEdit {
				change: gix::refs::transaction::Change::Update {
					log: gix::refs::transaction::LogChange {
						mode:                gix::refs::transaction::RefLog::AndReference,
						force_create_reflog: false,
						message:             if options.amend {
							"commit (amend)"
						} else {
							"commit"
						}
						.into(),
					},
					expected,
					new: gix::refs::Target::Object(id),
				},
				name:   "HEAD"
					.try_into()
					.map_err(|err| Error::backend("git commit", err))?,
				deref:  true,
			})
			.map_err(|err| Error::backend("git commit", err))?;
		let _ = run_commit_hook(self, "post-commit", &[]);
		Ok(id.to_hex().to_string())
	}

	/// Write a commit object for `tree` on top of `parents` without touching
	/// HEAD, the index, any ref, or the worktree (`git commit-tree`). No hooks
	/// run. Returns the new commit id.
	pub fn commit_tree(
		&self,
		tree: &str,
		parents: &[String],
		message: &str,
		author: Option<&CommitAuthor>,
	) -> Result<String> {
		let repo = self.gix()?;
		let tree = resolve_tree(&repo, tree)?;
		let parents = parents
			.iter()
			.map(|parent| resolve_commit(&repo, parent))
			.collect::<Result<Vec<_>>>()?;
		let committer = repo
			.committer()
			.ok_or_else(|| Error::backend("git commit-tree", "committer identity is not configured"))?
			.map_err(|err| Error::backend("git commit-tree", err))?;
		let override_author = author.map(signature_for).transpose()?;
		let mut author_time = gix::date::parse::TimeBuf::default();
		let author = if let Some(author) = override_author.as_ref() {
			author.to_ref(&mut author_time)
		} else {
			repo
				.author()
				.ok_or_else(|| Error::backend("git commit-tree", "author identity is not configured"))?
				.map_err(|err| Error::backend("git commit-tree", err))?
		};
		let commit = repo
			.new_commit_as(committer, author, message, tree, parents)
			.map_err(|err| Error::backend("git commit-tree", err))?;
		Ok(commit.id.to_hex().to_string())
	}

	/// Checkout a branch or detached revision without overwriting local changes.
	pub fn checkout(&self, rev: &str) -> Result<()> {
		let repo = self.gix()?;
		let (target, symbolic) = resolve_checkout_target(&repo, rev)?;
		checkout_tree(self, &repo, target, false)?;
		write_head(self.info().head_path.as_path(), symbolic.as_deref(), target)?;
		Ok(())
	}

	/// Create or force-move a local branch.
	pub fn create_branch(&self, name: &str, start: &str, force: bool) -> Result<()> {
		let repo = self.gix()?;
		let id = resolve_commit(&repo, start)?;
		let full = format!("refs/heads/{name}");
		if force && branch_is_checked_out(&self.info().common_dir, &full) {
			return Err(Error::backend(
				"git branch",
				format!(
					"cannot force update the branch '{name}' checked out at '{}'",
					self.root().display()
				),
			));
		}
		let constraint = if force {
			gix::refs::transaction::PreviousValue::Any
		} else {
			gix::refs::transaction::PreviousValue::MustNotExist
		};
		// git's reflog tells a `-f` move apart from a creation.
		let exists = force
			&& repo
				.try_find_reference(&full)
				.map_err(|e| Error::backend("git branch", e))?
				.is_some();
		let message = if exists {
			format!("branch: Reset to {start}")
		} else {
			format!("branch: Created from {start}")
		};
		update_reference(&repo, "git branch", &full, id, constraint, &message, false)?;
		Ok(())
	}

	/// Delete a local branch, returning false for missing or unsafe deletion.
	pub fn delete_branch(&self, name: &str, force: bool) -> Result<bool> {
		let repo = self.gix()?;
		let full = format!("refs/heads/{name}");
		if branch_is_checked_out(&self.info().common_dir, &full) {
			return Ok(false);
		}
		let Ok(mut reference) = repo.find_reference(&full) else {
			return Ok(false);
		};
		let id = match reference.peel_to_id() {
			Ok(id) => id.detach(),
			Err(_) => return Ok(false),
		};
		if !force {
			let Ok(head) = repo.head_commit() else {
				return Ok(false);
			};
			let mut walk = head
				.ancestors()
				.all()
				.map_err(|err| Error::backend("git branch", err))?;
			let merged = walk.any(|item| item.is_ok_and(|info| info.id == id));
			if !merged {
				return Ok(false);
			}
		}
		let edit = gix::refs::transaction::RefEdit {
			change: gix::refs::transaction::Change::Delete {
				expected: gix::refs::transaction::PreviousValue::MustExistAndMatch(id.into()),
				log:      gix::refs::transaction::RefLog::AndReference,
			},
			name:   full
				.try_into()
				.map_err(|err| Error::backend("git branch", err))?,
			deref:  false,
		};
		Ok(repo.edit_reference(edit).is_ok())
	}

	/// Create a branch at HEAD and switch to it without touching files.
	pub fn checkout_new_branch(&self, name: &str) -> Result<()> {
		self.create_branch(name, "HEAD", false)?;
		fs::write(&self.info().head_path, format!("ref: refs/heads/{name}\n"))?;
		Ok(())
	}

	/// Restore index and/or worktree paths from a selected source.
	pub fn restore(&self, options: &RestoreOptions) -> Result<()> {
		let repo = self.gix()?;
		let restore_worktree = options.worktree || !options.staged;
		let mut index = load_index_or_head(&repo, "git restore")?;
		if options.staged {
			let source = resolve_tree(&repo, options.source.as_deref().unwrap_or("HEAD"))?;
			let source_index = index_for_tree(&repo, Some(&source))?;
			copy_index_paths(&mut index, &source_index, &options.files);
			index
				.write(INDEX_WRITE)
				.map_err(|e| Error::backend("git restore", e))?;
		}
		if restore_worktree {
			let source_index = if let Some(source) = options.source.as_deref() {
				index_for_tree(&repo, Some(&resolve_tree(&repo, source)?))?
			} else {
				index
			};
			restore_index_paths(self.root(), &repo, &source_index, &options.files)?;
		}
		Ok(())
	}

	/// Write the checkout's uncommitted changes to tracked files as a stash
	/// commit, leaving the working tree, the index, and the stash list as they
	/// are. `None` when nothing is uncommitted. Git cannot record unmerged
	/// entries, so this fails mid-conflict.
	pub fn stash_create(&self) -> Result<Option<String>> {
		let create = ["stash", "create"].map(str::to_owned);
		let created = super::cli::run_sync(self.root(), &create, super::cli::COMMAND_TIMEOUT)?
			.into_checked(&create)?;
		let id = created.stdout.trim();
		Ok((!id.is_empty()).then(|| id.to_owned()))
	}

	/// Point `reference` at `id`, recording `message` on its reflog.
	pub fn record_ref(&self, reference: &str, id: &str, message: &str) -> Result<()> {
		let update =
			["update-ref", "--create-reflog", "-m", message, reference, id].map(str::to_owned);
		super::cli::run_sync(self.root(), &update, super::cli::COMMAND_TIMEOUT)?
			.into_checked(&update)?;
		Ok(())
	}

	/// Reset HEAD, index, and optionally the worktree to a target commit.
	pub fn reset(&self, mode: ResetMode, target: Option<&str>) -> Result<()> {
		let repo = self.gix()?;
		let id = resolve_commit(&repo, target.unwrap_or("HEAD"))?;
		if mode == ResetMode::Hard {
			checkout_tree(self, &repo, id, true)?;
		} else if mode == ResetMode::Mixed {
			self.read_tree(&id.to_hex().to_string(), None)?;
		}
		update_current_head(&repo, &self.info().head_path, id)?;
		Ok(())
	}

	/// Remove untracked files and directories according to ignore mode.
	pub fn clean(&self, options: &CleanOptions) -> Result<()> {
		// `.` (and `./`) normalize to "" and mean "everything", so they drop out
		// of the restriction set. A literally empty string is rejected the way
		// git rejects it instead of silently widening to the whole worktree.
		let mut paths = BTreeSet::new();
		for raw in &options.paths {
			if raw.is_empty() {
				return Err(Error::backend("git clean", "empty string is not a valid pathspec"));
			}
			let normalized = normalize_stage_path(raw);
			if !normalized.is_empty() {
				paths.insert(normalized);
			}
		}

		// Fresh open: the cached handle snapshots config, so a
		// `core.excludesFile` configured after first use would be missed and
		// its excluded files deleted.
		let repo = self.gix_fresh()?;
		let mut platform =
			status_with_index(&repo, "git clean", load_index_or_head(&repo, "git clean")?)?
				.untracked_files(gix::status::UntrackedFiles::Files);
		let emit_ignored = options.include_ignored || options.ignored_only;
		let for_deletion = if emit_ignored {
			gix::dir::walk::ForDeletionMode::FindNonBareRepositoriesInIgnoredDirectories
		} else {
			gix::dir::walk::ForDeletionMode::IgnoredDirectoriesCanHideNestedRepositories
		};
		platform = platform.dirwalk_options(|opts| {
			let opts = opts
				.emit_empty_directories(true)
				.for_deletion(Some(for_deletion));
			if emit_ignored {
				opts.emit_ignored(Some(gix::dir::walk::EmissionMode::Matching))
			} else {
				opts
			}
		});

		let iter = platform
			.into_index_worktree_iter(
				paths
					.iter()
					.map(|path| literal_pathspec(path).into_bytes().into()),
			)
			.map_err(|e| Error::backend("git clean", e))?;

		for item in iter {
			let item = item.map_err(|e| Error::backend("git clean", e))?;
			let gix::status::index_worktree::Item::DirectoryContents { entry, .. } = item else {
				continue;
			};
			if entry.disk_kind == Some(gix::dir::entry::Kind::Repository) {
				continue;
			}
			let wanted = if options.ignored_only {
				matches!(entry.status, gix::dir::entry::Status::Ignored(_))
			} else if options.include_ignored {
				entry.status == gix::dir::entry::Status::Untracked
					|| matches!(entry.status, gix::dir::entry::Status::Ignored(_))
			} else {
				entry.status == gix::dir::entry::Status::Untracked
			};
			if !wanted {
				continue;
			}
			let full = self.root().join(entry.rela_path.to_str_lossy().as_ref());
			remove_existing(&full)?;
			prune_empty_parents(self.root(), full.parent(), &paths)?;
		}
		Ok(())
	}

	/// Replace an index file with the entries from `treeish`.
	pub fn read_tree(&self, treeish: &str, index_path: Option<&Path>) -> Result<()> {
		let repo = self.gix()?;
		let tree = resolve_tree(&repo, treeish)?;
		let mut index = repo
			.index_from_tree(&tree)
			.map_err(|e| Error::backend("git read-tree", e))?;
		if let Some(path) = index_path {
			index.set_path(path);
		}
		index
			.write(INDEX_WRITE)
			.map_err(|e| Error::backend("git read-tree", e))
	}

	/// Write an index as a tree object and return its object id.
	pub fn write_tree(&self, index_path: Option<&Path>) -> Result<String> {
		let repo = self.gix()?;
		let index = match index_path {
			Some(path) => gix::index::File::at(path, repo.object_hash(), false, Default::default())
				.map_err(|e| Error::backend("git write-tree", e))?,
			None => repo
				.open_index()
				.map_err(|e| Error::backend("git write-tree", e))?,
		};
		Ok(write_index_tree(&repo, &index)?.to_hex().to_string())
	}

	/// Set one repository-local configuration value while preserving formatting.
	pub fn config_set(&self, key: &str, value: &str) -> Result<()> {
		set_config_file(&self.info().common_dir.join("config"), key, value)
	}

	/// Add a remote idempotently when its URL already matches.
	pub fn remote_add(&self, name: &str, url: &str) -> Result<()> {
		let key = format!("remote.{name}.url");
		let repo = self.gix()?;
		if let Some(existing) = repo.config_snapshot().string(&key) {
			let existing = existing.to_str_lossy();
			if existing == url {
				return Ok(());
			}
			return Err(Error::backend(
				"git remote add",
				format!("remote {name} already exists with URL {existing}, expected {url}"),
			));
		}
		self.config_set(&key, url)
	}

	/// Create a linked worktree and materialize its checkout.
	pub fn worktree_add(
		&self,
		path: &Path,
		ref_name: &str,
		options: WorktreeAddOptions,
	) -> Result<WorktreeAddResult> {
		let repo = self.gix()?;
		let id = resolve_commit(&repo, ref_name)?;
		if path.exists() && fs::read_dir(path)?.next().is_some() {
			return Err(Error::backend(
				"git worktree add",
				"destination already exists and is not empty",
			));
		}
		if options.keep_changes {
			let source_head = repo
				.head_id()
				.map_err(|e| Error::backend("git worktree add", e))?
				.detach();
			if source_head != id {
				return Err(Error::backend(
					"git worktree add",
					"keeping uncommitted changes requires the target to be the source HEAD",
				));
			}
		}
		let head = if options.detach {
			id.to_hex().to_string()
		} else {
			let full = if ref_name.starts_with("refs/heads/") {
				ref_name.to_owned()
			} else {
				format!("refs/heads/{ref_name}")
			};
			if branch_is_checked_out(&self.info().common_dir, &full) {
				return Err(Error::backend(
					"git worktree add",
					format!("'{full}' is already checked out"),
				));
			}
			if repo
				.try_find_reference(&full)
				.map_err(|e| Error::backend("git worktree add", e))?
				.is_none()
			{
				update_reference(
					&repo,
					"git worktree add",
					full.as_str(),
					id,
					gix::refs::transaction::PreviousValue::MustNotExist,
					"branch: Created from worktree add",
					false,
				)?;
			}
			format!("ref: {full}")
		};

		let preferred = match options.clone {
			WorktreeClone::Off => None,
			WorktreeClone::Auto => Some(None),
			WorktreeClone::Prefer(kind) => Some(Some(kind)),
		};
		let mut clone_error = None;
		if let Some(preferred) = preferred {
			for kind in pi_iso::clone_candidates(preferred) {
				match self.worktree_add_cloned(path, id, &head, kind, options.keep_changes) {
					Ok(()) => {
						return Ok(WorktreeAddResult { cloned_with: Some(kind), clone_error });
					},
					Err(err) => {
						clone_error = Some(err.to_string());
						cleanup_worktree_add(path, &self.info().common_dir);
					},
				}
			}
		}

		fs::create_dir_all(path)?;
		let admin = register_worktree(path, &self.info().common_dir, &head)?;
		let linked = Self::require(path)?;
		let linked_repo = linked.gix()?;
		checkout_tree(&linked, &linked_repo, id, true)?;
		if options.keep_changes {
			self.seed_worktree_changes(path, &admin, id)?;
		}
		Ok(WorktreeAddResult { cloned_with: None, clone_error })
	}

	/// Replicate the source checkout's uncommitted state onto a worktree at
	/// `path` freshly checked out at the source `HEAD` (`head_commit`): copy
	/// every staged, dirty tracked, and untracked file (deleting what the
	/// source deleted), then install the source index so staged hunks stay
	/// staged, with its stat cache rebased onto the files now on disk.
	fn seed_worktree_changes(
		&self,
		path: &Path,
		admin: &Path,
		head_commit: gix::hash::ObjectId,
	) -> Result<()> {
		let repo = self.gix()?;
		let (dirty_tracked, untracked) = collect_clone_reconciliation_paths(&repo)?;
		// One snapshot of the source index decides which paths to copy and is
		// what gets installed, so a concurrent `git add` in the source cannot
		// split the two.
		let source_index = if self.info().git_dir.join("index").is_file() {
			Some(load_index_or_empty(&repo, "git worktree add")?)
		} else {
			None
		};
		// The checkout wrote `HEAD` content, so paths whose index entry differs
		// from `HEAD` (staged edits, additions, and deletions) need the source
		// bytes too, even when the source worktree matches its index.
		let staged = match &source_index {
			Some(source_index) => {
				let head_index = repo
					.index_from_tree(&commit_tree(&repo, &head_commit)?)
					.map_err(|err| Error::backend("git worktree add", err))?;
				index_diff_paths(source_index, &head_index)
			},
			None => BTreeSet::new(),
		};

		for relative in dirty_tracked.iter().chain(&untracked).chain(&staged) {
			copy_worktree_path(self.root(), path, relative.as_bstr())?;
		}
		let Some(mut index) = source_index else {
			return Ok(());
		};
		// The source stat cache describes the source files. Checkout filters
		// (e.g. `core.autocrlf`) can write clean files at a different size, and
		// git reports a size mismatch as modified without hashing the content.
		refresh_clean_index_stats(&mut index, path, &dirty_tracked)?;
		index.set_path(admin.join("index"));
		index
			.write(INDEX_WRITE)
			.map_err(|err| Error::backend("git worktree add", err))
	}

	fn worktree_add_cloned(
		&self,
		path: &Path,
		id: gix::hash::ObjectId,
		head: &str,
		kind: pi_iso::BackendKind,
		keep_changes: bool,
	) -> Result<()> {
		let repo = self.gix()?;
		for key in ["core.sparseCheckout", "core.splitIndex"] {
			if repo.config_snapshot().string(key).is_some_and(|value| {
				!matches!(value.to_str_lossy().as_ref(), "false" | "no" | "off" | "0")
			}) {
				return Err(Error::backend("git worktree add", format!("{key} is enabled")));
			}
		}
		let source_index = self.info().git_dir.join("index");
		if !source_index.is_file() {
			return Err(Error::backend("git worktree add", "source index is missing"));
		}

		pi_iso::backend(kind)
			.clone_tree(self.root(), path, &[OsStr::new(".git")])
			.map_err(|err| Error::backend("git worktree add", err))?;
		let admin = register_worktree(path, &self.info().common_dir, head)?;
		fs::copy(&source_index, admin.join("index"))?;

		let (dirty_tracked, _) = collect_clone_reconciliation_paths(&repo)?;
		// Backends may clone entire subtrees atomically. Apply the same
		// nonrelocatable-directory policy to every backend's disposable copy,
		// independently of Git's ignore rules.
		let excluded = prune_nonrelocatable_clone_dirs(path)?;
		let linked = Self::require(path)?;
		let linked_repo = linked.gix()?;
		let mut current = load_index_or_empty(&linked_repo, "git worktree add")?;
		if keep_changes {
			// Environment artifacts are never portable, but tracked edits
			// beneath an excluded directory still belong to the user.
			if !excluded.is_empty() {
				for entry in current.entries() {
					let relative = entry.path(&current);
					if relative
						.to_path_lossy()
						.ancestors()
						.any(|parent| excluded.contains(parent))
					{
						copy_worktree_path(self.root(), path, relative)?;
					}
				}
			}
			// The clone already mirrors the source's live tree and the copied
			// index carries its staged state. Only the stat cache is stale
			// (new inodes); refresh it for entries the source reports clean so
			// dirty files still hash on the next status.
			refresh_clean_index_stats(&mut current, path, &dirty_tracked)?;
			return current
				.write(INDEX_WRITE)
				.map_err(|err| Error::backend("git worktree add", err));
		}
		let tree = commit_tree(&linked_repo, &id)?;
		let mut target = linked_repo
			.index_from_tree(&tree)
			.map_err(|err| Error::backend("git worktree add", err))?;

		let differing = index_diff_paths(&current, &target);
		let (write_paths, removed): (BTreeSet<BString>, BTreeSet<BString>) = differing
			.into_iter()
			.partition(|entry_path| target.entry_by_path(entry_path.as_bstr()).is_some());
		let mut delete = removed;
		delete.extend(
			dirty_tracked
				.iter()
				.filter(|entry_path| target.entry_by_path(entry_path.as_bstr()).is_none())
				.cloned(),
		);

		let mut write = write_paths;
		if !excluded.is_empty() {
			write.extend(target.entries().iter().filter_map(|entry| {
				let relative = entry.path(&target);
				relative
					.to_path_lossy()
					.ancestors()
					.any(|parent| excluded.contains(parent))
					.then(|| relative.to_owned())
			}));
		}
		write.extend(
			dirty_tracked
				.iter()
				.filter(|entry_path| target.entry_by_path(entry_path.as_bstr()).is_some())
				.cloned(),
		);

		for relative in &delete {
			let full = path.join(relative.to_path_lossy());
			match fs::remove_file(&full) {
				Ok(()) => prune_empty_parents(path, full.parent(), &BTreeSet::new())?,
				Err(err) if err.kind() == std::io::ErrorKind::NotFound => {},
				Err(err) => return Err(err.into()),
			}
		}

		// `remove_entries` keeps the path backing even when it drops every
		// entry, and gix's checkout asserts the two are empty together; a
		// clone that already matches the target tree must not enter it.
		let changed = if write.is_empty() {
			None
		} else {
			let mut changed = target.clone();
			changed.remove_entries(|_, entry_path, _| !write.contains(entry_path));
			let mut checkout_options = linked_repo
				.checkout_options(gix::worktree::stack::state::attributes::Source::IdMapping)
				.map_err(|err| Error::backend("git worktree add", err))?;
			checkout_options.overwrite_existing = true;
			let progress = gix::progress::Discard;
			let interrupt = std::sync::atomic::AtomicBool::new(false);
			let outcome = gix::worktree::state::checkout(
				&mut changed,
				path,
				linked_repo
					.objects
					.into_arc()
					.map_err(|err| Error::backend("git worktree add", err))?,
				&progress,
				&progress,
				&interrupt,
				checkout_options,
			)
			.map_err(|err| Error::backend("git worktree add", err))?;
			if !outcome.collisions.is_empty() || !outcome.errors.is_empty() {
				return Err(Error::backend(
					"git worktree add",
					format!(
						"checkout reported {} collisions and {} errors",
						outcome.collisions.len(),
						outcome.errors.len()
					),
				));
			}
			Some(changed)
		};

		for (entry, entry_path) in target.entries_mut_with_paths() {
			if let Some(written) = changed
				.as_ref()
				.and_then(|changed| changed.entry_by_path(entry_path))
			{
				entry.stat = written.stat;
			} else {
				let metadata = gix::index::fs::Metadata::from_path_no_follow(
					&path.join(entry_path.to_path_lossy()),
				)?;
				entry.stat = gix::index::entry::Stat::from_fs(&metadata)
					.map_err(|err| Error::backend("git worktree add", err))?;
			}
		}
		target
			.write(INDEX_WRITE)
			.map_err(|err| Error::backend("git worktree add", err))?;
		// The source can ignore paths that the target does not, and vice
		// versa. Only now are the target's ignore files and index in place.
		// Clean this fresh clone through the existing repository-safe walk;
		// keep target-ignored caches and never enter nested repositories.
		linked.clean(&CleanOptions::default())
	}

	/// Resolve the executable hook `name` as git's `find_hook` does: under
	/// `core.hooksPath` (a relative value resolves against the checkout root)
	/// or else the shared `hooks` directory, which linked worktrees read from
	/// the common dir. `None` when the hook is missing or not executable.
	pub fn hook_path(&self, name: &str) -> Result<Option<PathBuf>> {
		let dir = self
			.gix()?
			.config_snapshot()
			.string("core.hooksPath")
			.map_or_else(
				|| self.info().common_dir.join("hooks"),
				|value| self.root().join(value.to_str_lossy().as_ref()),
			);
		let hook = dir.join(name);
		Ok(hook_is_executable(&hook).then_some(hook))
	}

	/// Remove a linked worktree, returning false when dirty and not forced.
	pub fn worktree_remove(&self, path: &Path, force: bool) -> Result<bool> {
		let Some(linked) = Self::discover(path)? else {
			return Ok(false);
		};
		if !force && tracked_worktree_dirty(&linked)? {
			return Ok(false);
		}
		let admin = linked.info().git_dir.clone();
		fs::remove_dir_all(path)?;
		if admin.starts_with(self.info().common_dir.join("worktrees")) {
			fs::remove_dir_all(admin)?;
		}
		Ok(true)
	}

	/// Prune linked-worktree administration entries whose back-reference
	/// vanished.
	pub fn worktree_prune(&self) -> Result<()> {
		let root = self.info().common_dir.join("worktrees");
		let Ok(entries) = fs::read_dir(&root) else {
			return Ok(());
		};
		for entry in entries {
			let entry = entry?;
			let back = fs::read_to_string(entry.path().join("gitdir")).unwrap_or_default();
			if back.trim().is_empty() || !Path::new(back.trim()).exists() {
				fs::remove_dir_all(entry.path())?;
			}
		}
		Ok(())
	}
}

fn run_commit_hook(repository: &GitRepo, name: &str, args: &[&OsStr]) -> Result<()> {
	let Some(hook) = repository.hook_path(name)? else {
		return Ok(());
	};
	// Windows CreateProcess cannot execute a shebang script directly. Let Git
	// invoke the hook through its own shell, as `git commit` does.
	#[cfg(windows)]
	let mut command = {
		let _ = hook;
		let mut command = Command::new("git");
		command.args(["hook", "run", "--ignore-missing", name, "--"]);
		command
	};
	#[cfg(not(windows))]
	let mut command = Command::new(&hook);
	super::cli::detach_from_terminal(&mut command);
	let output = command
		.args(args)
		.current_dir(repository.root())
		.env("GIT_DIR", &repository.info().git_dir)
		.env("GIT_WORK_TREE", repository.root())
		.env("GIT_TERMINAL_PROMPT", "0")
		.stdin(Stdio::null())
		.output()
		.map_err(|err| Error::Cli {
			command:   format!("git commit ({name} hook)"),
			exit_code: 1,
			stdout:    String::new(),
			stderr:    err.to_string(),
		})?;
	if output.status.success() {
		return Ok(());
	}
	Err(Error::Cli {
		command:   format!("git commit ({name} hook)"),
		exit_code: output.status.code().unwrap_or(1),
		stdout:    String::from_utf8_lossy_owned(output.stdout),
		stderr:    String::from_utf8_lossy_owned(output.stderr),
	})
}

/// Write a signed commit object through `git commit-tree -S`, which runs the
/// signer configured by `gpg.format`/`gpg.program`/`user.signingKey`.
/// gitoxide cannot sign, so this is the one commit path that leaves the
/// process; HEAD is still updated in-process by the caller.
fn sign_commit(
	repository: &GitRepo,
	message: &str,
	tree: gix::hash::ObjectId,
	parents: &[gix::hash::ObjectId],
	author: gix::actor::SignatureRef<'_>,
	committer: gix::actor::SignatureRef<'_>,
) -> Result<gix::hash::ObjectId> {
	let mut args = vec![
		// The repository was opened with `Trust::Full`; without this override
		// git's ownership check rejects checkouts owned by another user
		// (host-mounted repositories in containers) that commit fine unsigned.
		"-c".to_owned(),
		"safe.directory=*".to_owned(),
		"commit-tree".to_owned(),
		"-S".to_owned(),
		tree.to_hex().to_string(),
	];
	for parent in parents {
		args.push("-p".to_owned());
		args.push(parent.to_hex().to_string());
	}
	// Raw `<seconds> <offset>` dates need the `@` marker: without it git falls
	// back to its approximate-date parser, which rejects timestamps under
	// nine digits.
	let author_date = format!("@{}", author.time);
	let committer_date = format!("@{}", committer.time);
	let env: [(&str, &OsStr); 6] = [
		("GIT_AUTHOR_NAME", &author.name.to_os_str_lossy()),
		("GIT_AUTHOR_EMAIL", &author.email.to_os_str_lossy()),
		("GIT_AUTHOR_DATE", author_date.as_ref()),
		("GIT_COMMITTER_NAME", &committer.name.to_os_str_lossy()),
		("GIT_COMMITTER_EMAIL", &committer.email.to_os_str_lossy()),
		("GIT_COMMITTER_DATE", committer_date.as_ref()),
	];
	// The message travels over stdin so it reaches git byte-for-byte, with no
	// file path to re-encode.
	let output = super::cli::run_sync_write(
		repository.root(),
		&args,
		super::cli::COMMAND_TIMEOUT,
		&super::cli::SyncWrite { stdin: message.as_bytes(), env: &env },
	)?
	.into_checked(&args)?;
	gix::hash::ObjectId::from_hex(output.stdout.trim().as_bytes())
		.map_err(|err| Error::backend("git commit-tree", err))
}

/// Mirrors git's `find_hook`: any failure to stat the hook (missing, or
/// `core.hooksPath` pointing at a non-directory such as `/dev/null`) means
/// "no hook", never a commit failure.
fn hook_is_executable(path: &Path) -> bool {
	let Ok(metadata) = fs::metadata(path) else {
		return false;
	};
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
	}
	#[cfg(not(unix))]
	{
		metadata.is_file()
	}
}

fn read_optional_file(path: &Path) -> Result<Option<Vec<u8>>> {
	match fs::read(path) {
		Ok(bytes) => Ok(Some(bytes)),
		Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
		Err(err) => Err(err.into()),
	}
}

/// Sever a copied linked worktree from its source metadata without copying
/// objects.
pub fn detach_git_dir(
	worktree_root: &Path,
	source_common_dir: &Path,
) -> Result<DetachGitDirResult> {
	let git_entry = worktree_root.join(".git");
	let meta = match fs::symlink_metadata(&git_entry) {
		Ok(meta) => meta,
		Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(DetachGitDirResult::NoGit),
		Err(e) => return Err(e.into()),
	};
	let source_common =
		fs::canonicalize(source_common_dir).unwrap_or_else(|_| normalize_path(source_common_dir));
	let original = GitRepo::require(worktree_root)?;
	let iso_common = fs::canonicalize(&original.info().common_dir)
		.unwrap_or_else(|_| normalize_path(&original.info().common_dir));
	if iso_common != source_common {
		return Ok(DetachGitDirResult::Independent);
	}
	let repo = original.gix()?;
	let head = read_optional_file(&original.info().head_path)?;
	let index = read_optional_file(&original.info().git_dir.join("index"))?;
	let refs = snapshot_refs(&repo)?;
	let config_values = [
		"user.name",
		"user.email",
		"core.fileMode",
		"core.splitIndex",
		"core.sparseCheckout",
		"core.sparseCheckoutCone",
	]
	.into_iter()
	.filter_map(|key| {
		repo
			.config_snapshot()
			.string(key)
			.map(|v| (key, v.to_str_lossy().into_owned()))
	})
	.collect::<Vec<_>>();
	let shared = copy_named_files(&original.info().git_dir, "sharedindex.")?;
	let sparse = read_optional_file(&original.info().git_dir.join("info/sparse-checkout"))?;
	let shallow = read_optional_file(&source_common.join("shallow"))?;
	let own_admin = if meta.is_file() {
		registered_admin(&git_entry)?
	} else {
		None
	};
	if meta.is_dir() {
		fs::remove_dir_all(&git_entry)?;
	} else {
		fs::remove_file(&git_entry)?;
	}
	if let Some(admin) = own_admin {
		fs::remove_dir_all(admin)?;
	}
	gix::init(worktree_root).map_err(|e| Error::backend("git init", e))?;
	let objects_info = git_entry.join("objects/info");
	fs::create_dir_all(&objects_info)?;
	let mut alternates = vec![source_common.join("objects")];
	if let Ok(chained) = fs::read_to_string(source_common.join("objects/info/alternates")) {
		for line in chained
			.lines()
			.map(str::trim)
			.filter(|line| !line.is_empty())
		{
			let path = Path::new(line);
			alternates.push(if path.is_absolute() {
				path.to_owned()
			} else {
				source_common.join("objects").join(path)
			});
		}
	}
	let alternate_text = alternates
		.iter()
		.map(|p| p.to_string_lossy())
		.collect::<Vec<_>>()
		.join("\n")
		+ "\n";
	fs::write(objects_info.join("alternates"), alternate_text)?;
	for (name, id) in refs {
		write_loose_ref(&git_entry, &name, id)?;
	}
	if let Some(head) = head {
		fs::write(git_entry.join("HEAD"), head)?;
	}
	for (key, value) in config_values {
		set_config_file(&git_entry.join("config"), key, &value)?;
	}
	if let Some(bytes) = shallow {
		fs::write(git_entry.join("shallow"), bytes)?;
	}
	if let Some(bytes) = sparse {
		fs::create_dir_all(git_entry.join("info"))?;
		fs::write(git_entry.join("info/sparse-checkout"), bytes)?;
	}
	for (name, bytes) in shared {
		fs::write(git_entry.join(name), bytes)?;
	}
	if let Some(bytes) = index {
		fs::write(git_entry.join("index"), bytes)?;
	} else if let Ok(detached) = GitRepo::require(worktree_root)
		&& resolve_commit(&detached.gix()?, "HEAD").is_ok()
	{
		detached.read_tree("HEAD", None)?;
	}
	Ok(DetachGitDirResult::Detached)
}

/// Author signature for an explicit [`CommitAuthor`]; a missing date means now.
fn signature_for(author: &CommitAuthor) -> Result<gix::actor::Signature> {
	let time = match &author.date {
		Some(date) => {
			gix::date::parse(date, None).map_err(|err| Error::backend("git commit", err))?
		},
		None => gix::date::Time::now_local_or_utc(),
	};
	Ok(gix::actor::Signature {
		name: author.name.clone().into(),
		email: author.email.clone().into(),
		time,
	})
}

fn resolve_commit(repo: &gix::Repository, spec: &str) -> Result<gix::hash::ObjectId> {
	let id = repo
		.rev_parse_single(spec)
		.map_err(|_| Error::ObjectNotFound { spec: spec.to_owned() })?;
	let object = id
		.object()
		.map_err(|_| Error::ObjectNotFound { spec: spec.to_owned() })?;
	object
		.peel_to_commit()
		.map(|commit| commit.id)
		.map_err(|_| Error::ObjectNotFound { spec: spec.to_owned() })
}

fn resolve_tree(repo: &gix::Repository, spec: &str) -> Result<gix::hash::ObjectId> {
	let id = repo
		.rev_parse_single(spec)
		.map_err(|_| Error::ObjectNotFound { spec: spec.to_owned() })?;
	let object = id
		.object()
		.map_err(|_| Error::ObjectNotFound { spec: spec.to_owned() })?;
	object
		.peel_to_tree()
		.map(|tree| tree.id)
		.map_err(|_| Error::ObjectNotFound { spec: spec.to_owned() })
}

fn commit_tree(repo: &gix::Repository, id: &gix::hash::ObjectId) -> Result<gix::hash::ObjectId> {
	let commit = repo
		.find_commit(*id)
		.map_err(|e| Error::backend("git commit", e))?;
	commit
		.tree_id()
		.map(|id| id.detach())
		.map_err(|e| Error::backend("git commit", e))
}

fn head_tree(repo: &gix::Repository) -> Result<Option<gix::hash::ObjectId>> {
	match repo
		.head()
		.map_err(|e| Error::backend("git reset", e))?
		.try_peel_to_id()
		.map_err(|e| Error::backend("git reset", e))?
	{
		Some(id) => Ok(Some(
			id.object()
				.map_err(|e| Error::backend("git reset", e))?
				.peel_to_commit()
				.map_err(|e| Error::backend("git reset", e))?
				.tree_id()
				.map_err(|e| Error::backend("git reset", e))?
				.detach(),
		)),
		None => Ok(None),
	}
}

fn index_for_tree(
	repo: &gix::Repository,
	tree: Option<&gix::hash::ObjectId>,
) -> Result<gix::index::File> {
	match tree {
		Some(tree) => repo
			.index_from_tree(tree)
			.map_err(|e| Error::backend("git index", e)),
		None => Ok(gix::index::File::from_state(
			gix::index::State::new(repo.object_hash()),
			repo.index_path(),
		)),
	}
}

fn collect_stage_paths(
	repo: &GitRepo,
	requested: &BTreeSet<String>,
	all: bool,
) -> Result<BTreeSet<String>> {
	let untracked = if all || requested.contains("") {
		repo.ls_files(true, true)?
	} else {
		repo.ls_files_at_paths(true, true, requested)?
	};
	Ok(untracked.into_iter().collect())
}

fn normalize_stage_path(path: &str) -> String {
	let normalized = path.replace('\\', "/");
	let mut relative = normalized.as_str();
	while let Some(stripped) = relative.strip_prefix("./") {
		relative = stripped;
	}
	if relative == "." {
		String::new()
	} else {
		relative.trim_end_matches('/').to_owned()
	}
}

fn stage_path_matches(path: &str, wanted: &str) -> bool {
	wanted.is_empty() || path_matches(path, wanted)
}

fn remap_composed_index_paths(
	root: &Path,
	index: &gix::index::File,
	selected: BTreeSet<String>,
) -> BTreeSet<String> {
	let mut exact = BTreeSet::new();
	let mut by_composed = BTreeMap::new();
	let mut dir_by_composed: BTreeMap<String, String> = BTreeMap::new();
	for entry in index.entries() {
		let Ok(name) = entry.path(index).to_str() else {
			continue;
		};
		exact.insert(name.to_owned());
		by_composed
			.entry(precomposed(name).into_owned())
			.or_insert_with(|| name.to_owned());
		let mut start = 0;
		while let Some(slash) = name[start..].find('/') {
			let dir = &name[..start + slash];
			if !dir.is_empty() {
				dir_by_composed
					.entry(precomposed(dir).into_owned())
					.or_insert_with(|| dir.to_owned());
			}
			start += slash + 1;
		}
	}
	selected
		.into_iter()
		.map(|path| {
			if exact.contains(&path) {
				return path;
			}
			if let Some(alias) = by_composed.get(precomposed(&path).as_ref())
				&& alias != &path
			{
				let Ok(meta) = fs::symlink_metadata(root.join(&path)) else {
					return path;
				};
				let Ok(imeta) = fs::symlink_metadata(root.join(alias)) else {
					return path;
				};
				if same_worktree_file(&meta, &imeta) {
					return alias.clone();
				}
			}
			let composed = precomposed(&path);
			if let Some(alias_dir) = dir_by_composed.get(composed.as_ref())
				&& alias_dir != &path
			{
				let Ok(meta) = fs::symlink_metadata(root.join(&path)) else {
					return path;
				};
				let Ok(imeta) = fs::symlink_metadata(root.join(alias_dir)) else {
					return path;
				};
				if same_worktree_file(&meta, &imeta) {
					return alias_dir.clone();
				}
			}
			path
		})
		.collect()
}

fn precompose_unicode_enabled(repo: &gix::Repository) -> bool {
	repo
		.config_snapshot()
		.boolean("core.precomposeUnicode")
		.unwrap_or(false)
}

fn precomposed(path: &str) -> std::borrow::Cow<'_, str> {
	gix_utils::str::precompose(std::borrow::Cow::Borrowed(path))
}

#[cfg(unix)]
fn same_worktree_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
	use std::os::unix::fs::MetadataExt;
	left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(not(unix))]
#[allow(clippy::missing_const_for_fn, reason = "matches non-const unix signature")]
fn same_worktree_file(_: &fs::Metadata, _: &fs::Metadata) -> bool {
	false
}

/// The new index entry for a staged path.
struct StagedEntry {
	path: BString,
	stat: gix::index::entry::Stat,
	id:   gix::ObjectId,
	mode: gix::index::entry::Mode,
}

/// What staging a path does to its index entries.
enum Staged {
	/// Replace them with this entry.
	Entry(StagedEntry),
	/// Drop them: the path vanished or is untrackable (socket), as `git add`
	/// would.
	Removed,
	/// Leave them: a plain directory.
	Kept,
}

/// Write the filtered worktree content at `path` into the object database.
fn stage_one(
	root: &Path,
	filter: &mut gix::filter::Pipeline<'_>,
	filter_index: &gix::index::State,
	path: &str,
	staging_started: u64,
) -> Result<Staged> {
	use gix::objs::tree::EntryKind;
	let rela_path = path.as_bytes().as_bstr();
	// Stat before reading, as `git add` does, so the entry keeps a valid stat
	// cache: a write landing after the stat changes the file's stat and later
	// status calls re-hash it. A file last changed in the second staging
	// began could change again within that second and keep its stat, so its
	// stat is not recorded and the next status compares contents instead.
	let stat = gix::index::fs::Metadata::from_path_no_follow(&root.join(path))
		.ok()
		.and_then(|metadata| gix::index::entry::Stat::from_fs(&metadata).ok())
		.filter(|stat| u64::from(stat.mtime.secs) < staging_started)
		.unwrap_or_default();
	let Some((id, kind, _)) = filter
		.worktree_file_to_object(rela_path, filter_index)
		.map_err(|err| Error::backend("git add", err))?
	else {
		return Ok(Staged::Removed);
	};
	let mode = match kind {
		EntryKind::Blob => gix::index::entry::Mode::FILE,
		EntryKind::BlobExecutable => gix::index::entry::Mode::FILE_EXECUTABLE,
		EntryKind::Link => gix::index::entry::Mode::SYMLINK,
		EntryKind::Commit => gix::index::entry::Mode::COMMIT,
		EntryKind::Tree => return Ok(Staged::Kept),
	};
	Ok(Staged::Entry(StagedEntry { path: rela_path.to_owned(), stat, id, mode }))
}

fn copy_index_paths(dest: &mut gix::index::File, source: &gix::index::File, files: &[String]) {
	let all = files.is_empty();
	dest.remove_entries(|_, path, _| {
		all || files
			.iter()
			.any(|wanted| path_matches(&path.to_str_lossy(), wanted))
	});
	for entry in source.entries() {
		let path = entry.path(source);
		if all
			|| files
				.iter()
				.any(|wanted| path_matches(&path.to_str_lossy(), wanted))
		{
			dest.dangerously_push_entry(entry.stat, entry.id, entry.flags, entry.mode, path);
		}
	}
	dest.sort_entries();
}

#[derive(Default)]
struct TreeNode {
	files: Vec<(BString, gix::index::entry::Mode, gix::hash::ObjectId)>,
	dirs:  BTreeMap<BString, Self>,
}

fn write_index_tree(
	repo: &gix::Repository,
	index: &gix::index::File,
) -> Result<gix::hash::ObjectId> {
	let mut root = TreeNode::default();
	for entry in index
		.entries()
		.iter()
		.filter(|e| e.stage() == gix::index::entry::Stage::Unconflicted)
	{
		let parts: Vec<&[u8]> = entry.path(index).split(|b| *b == b'/').collect();
		let mut node = &mut root;
		for part in &parts[..parts.len().saturating_sub(1)] {
			node = node.dirs.entry(BString::from(*part)).or_default();
		}
		if let Some(name) = parts.last() {
			node
				.files
				.push((BString::from(*name), entry.mode, entry.id));
		}
	}
	write_tree_node(repo, root)
}

fn write_tree_node(repo: &gix::Repository, node: TreeNode) -> Result<gix::hash::ObjectId> {
	let mut entries = Vec::with_capacity(node.files.len() + node.dirs.len());
	for (name, mode, oid) in node.files {
		let mode = gix::objs::tree::EntryMode::try_from(mode.bits())
			.map_err(|m| Error::backend("git write-tree", format!("invalid mode {m:o}")))?;
		entries.push(gix::objs::tree::Entry { mode, filename: name, oid });
	}
	for (name, child) in node.dirs {
		entries.push(gix::objs::tree::Entry {
			mode:     gix::objs::tree::EntryKind::Tree.into(),
			filename: name,
			oid:      write_tree_node(repo, child)?,
		});
	}
	entries.sort();
	repo
		.write_object(&gix::objs::Tree { entries })
		.map(|id| id.detach())
		.map_err(|e| Error::backend("git write-tree", e))
}

fn resolve_checkout_target(
	repo: &gix::Repository,
	rev: &str,
) -> Result<(gix::hash::ObjectId, Option<String>)> {
	let branch = if rev.starts_with("refs/heads/") {
		Some(rev.to_owned())
	} else {
		let full = format!("refs/heads/{rev}");
		repo
			.try_find_reference(&full)
			.map_err(|e| Error::backend("git checkout", e))?
			.map(|_| full)
	};
	Ok((resolve_commit(repo, branch.as_deref().unwrap_or(rev))?, branch))
}

fn checkout_tree(
	owner: &GitRepo,
	repo: &gix::Repository,
	commit: gix::hash::ObjectId,
	overwrite: bool,
) -> Result<()> {
	let tree = commit_tree(repo, &commit)?;
	let mut target = repo
		.index_from_tree(&tree)
		.map_err(|e| Error::backend("git checkout", e))?;
	let current = load_index_or_head(repo, "git checkout")?;
	let conflicts = checkout_conflicts(owner.root(), repo, &current, &target)?;
	if !overwrite && !conflicts.is_empty() {
		return Err(Error::Conflict { paths: conflicts });
	}
	let mut collisions = Vec::new();
	for entry in target.entries() {
		let path = entry.path(&target).to_str_lossy().into_owned();
		if current.entry_by_path(path.as_bytes().as_bstr()).is_none()
			&& fs::symlink_metadata(owner.root().join(&path)).is_ok()
		{
			collisions.push(path);
		}
	}
	if !collisions.is_empty() {
		return Err(Error::Conflict { paths: collisions });
	}
	let target_paths: BTreeSet<String> = target
		.entries()
		.iter()
		.map(|e| e.path(&target).to_str_lossy().into_owned())
		.collect();
	for entry in current.entries() {
		let path = entry.path(&current).to_str_lossy();
		if !target_paths.contains(path.as_ref()) {
			let full = owner.root().join(path.as_ref());
			if full.is_file() || fs::symlink_metadata(&full).is_ok() {
				fs::remove_file(full)?;
			}
		}
	}
	let mut opts = repo
		.checkout_options(gix::worktree::stack::state::attributes::Source::IdMapping)
		.map_err(|e| Error::backend("git checkout", e))?;
	opts.overwrite_existing = true;
	let progress = gix::progress::Discard;
	let interrupt = std::sync::atomic::AtomicBool::new(false);
	gix::worktree::state::checkout(
		&mut target,
		owner.root(),
		repo
			.objects
			.clone()
			.into_arc()
			.map_err(|e| Error::backend("git checkout", e))?,
		&progress,
		&progress,
		&interrupt,
		opts,
	)
	.map_err(|e| Error::backend("git checkout", e))?;
	target
		.write(INDEX_WRITE)
		.map_err(|e| Error::backend("git checkout", e))
}

fn checkout_conflicts(
	root: &Path,
	repo: &gix::Repository,
	current: &gix::index::File,
	target: &gix::index::File,
) -> Result<Vec<String>> {
	let mut conflicts = Vec::new();
	let mut filter = WorktreeFilter::staging(repo, "git checkout")?;
	for entry in current.entries() {
		let path = entry.path(current).to_str_lossy().into_owned();
		let target_entry = target.entry_by_path(path.as_bytes().as_bstr());
		if target_entry.is_some_and(|e| e.id == entry.id && e.mode == entry.mode) {
			continue;
		}
		if worktree_id(repo, &mut filter, root, &path, entry.mode)? != Some(entry.id) {
			conflicts.push(path);
		}
	}
	conflicts.sort();
	conflicts.dedup();
	Ok(conflicts)
}

/// Blob id the worktree entry at repo-relative `path` would be staged as —
/// regular files pass through the clean filters, so a CRLF checkout under
/// `core.autocrlf` matches its LF blob — or `None` when it is missing.
fn worktree_id(
	repo: &gix::Repository,
	filter: &mut WorktreeFilter<'_>,
	root: &Path,
	path: &str,
	mode: gix::index::entry::Mode,
) -> Result<Option<gix::hash::ObjectId>> {
	let absolute = root.join(path);
	if !absolute.exists() && fs::symlink_metadata(&absolute).is_err() {
		return Ok(None);
	}
	let data = if mode == gix::index::entry::Mode::SYMLINK {
		fs::read_link(&absolute)?
			.to_string_lossy()
			.into_owned()
			.into_bytes()
	} else {
		filter.worktree_to_git(path, fs::read(&absolute)?)?
	};
	Ok(Some(
		gix::objs::compute_hash(repo.object_hash(), gix::objs::Kind::Blob, &data)
			.map_err(|e| Error::backend("git checkout", e))?,
	))
}

fn write_head(path: &Path, symbolic: Option<&str>, id: gix::hash::ObjectId) -> Result<()> {
	fs::write(path, match symbolic {
		Some(name) => format!("ref: {name}\n"),
		None => format!("{}\n", id.to_hex()),
	})?;
	Ok(())
}

fn update_current_head(repo: &gix::Repository, path: &Path, id: gix::hash::ObjectId) -> Result<()> {
	let content = fs::read_to_string(path).unwrap_or_default();
	if let Some(name) = content.trim().strip_prefix("ref: ") {
		update_reference(
			repo,
			"git reset",
			name,
			id,
			gix::refs::transaction::PreviousValue::Any,
			"reset: moving to target",
			false,
		)?;
	} else {
		fs::write(path, format!("{}\n", id.to_hex()))?;
	}
	Ok(())
}

fn restore_index_paths(
	root: &Path,
	repo: &gix::Repository,
	index: &gix::index::File,
	files: &[String],
) -> Result<()> {
	let mut filter = WorktreeFilter::staging(repo, "git restore")?;
	for entry in index.entries() {
		let path = entry.path(index).to_str_lossy();
		if files.is_empty() || files.iter().any(|wanted| path_matches(&path, wanted)) {
			let object = repo
				.find_object(entry.id)
				.map_err(|e| Error::backend("git restore", e))?;
			let mut blob = object
				.try_into_blob()
				.map_err(|e| Error::backend("git restore", e))?;
			let full = root.join(path.as_ref());
			if let Some(parent) = full.parent() {
				fs::create_dir_all(parent)?;
			}
			fs::write(full, filter.git_to_worktree(&path, blob.take_data())?)?;
		}
	}
	Ok(())
}

fn path_matches(path: &str, wanted: &str) -> bool {
	let wanted = wanted.trim_end_matches('/');
	path == wanted
		|| path
			.strip_prefix(wanted)
			.is_some_and(|r| r.starts_with('/'))
}

fn set_config_file(path: &Path, key: &str, value: &str) -> Result<()> {
	let mut config = if path.exists() {
		gix::config::File::from_path_no_includes(path.to_owned(), gix::config::Source::Local)
			.map_err(|e| Error::backend("git config", e))?
	} else {
		gix::config::File::default()
	};
	config
		.set_raw_value(key, value)
		.map_err(|e| Error::backend("git config", e))?;
	let mut bytes = Vec::new();
	config.write_to(&mut bytes)?;
	fs::write(path, bytes)?;
	Ok(())
}

/// Paths whose entry differs between `left` and `right` (blob id or mode), or
/// that exist on only one side.
fn index_diff_paths(left: &gix::index::File, right: &gix::index::File) -> BTreeSet<BString> {
	let mut paths = BTreeSet::new();
	for entry in left.entries() {
		let entry_path = entry.path(left);
		if right
			.entry_by_path(entry_path)
			.is_none_or(|other| other.id != entry.id || other.mode != entry.mode)
		{
			paths.insert(entry_path.to_owned());
		}
	}
	for entry in right.entries() {
		let entry_path = entry.path(right);
		if left.entry_by_path(entry_path).is_none() {
			paths.insert(entry_path.to_owned());
		}
	}
	paths
}

/// Point the stat cache of every index entry outside `dirty` at the file now
/// under `root`, so entries whose content matches the index read as clean.
fn refresh_clean_index_stats(
	index: &mut gix::index::File,
	root: &Path,
	dirty: &BTreeSet<BString>,
) -> Result<()> {
	for (entry, entry_path) in index.entries_mut_with_paths() {
		if dirty.contains(entry_path) {
			continue;
		}
		let Ok(metadata) =
			gix::index::fs::Metadata::from_path_no_follow(&root.join(entry_path.to_path_lossy()))
		else {
			continue;
		};
		entry.stat = gix::index::entry::Stat::from_fs(&metadata)
			.map_err(|err| Error::backend("git worktree add", err))?;
	}
	Ok(())
}

fn collect_clone_reconciliation_paths(
	repo: &gix::Repository,
) -> Result<(BTreeSet<BString>, BTreeSet<BString>)> {
	let platform = status_with_fresh_index(repo, "git worktree add")?
		.untracked_files(gix::status::UntrackedFiles::Files);
	let iter = platform
		.into_iter(std::iter::empty::<gix::bstr::BString>())
		.map_err(|err| Error::backend("git worktree add", err))?;
	let mut dirty_tracked = BTreeSet::new();
	let mut untracked = BTreeSet::new();
	for item in iter {
		let item = item.map_err(|err| Error::backend("git worktree add", err))?;
		let gix::status::Item::IndexWorktree(change) = item else {
			continue;
		};
		use gix::status::index_worktree;
		match change {
			index_worktree::Item::Modification { rela_path, status, .. }
				if !matches!(
					status,
					gix::status::plumbing::index_as_worktree::EntryStatus::NeedsUpdate(_)
				) =>
			{
				dirty_tracked.insert(rela_path);
			},
			index_worktree::Item::DirectoryContents { entry, .. }
				if entry.status == gix::dir::entry::Status::Untracked =>
			{
				untracked.insert(entry.rela_path);
			},
			index_worktree::Item::Rewrite { source, dirwalk_entry, .. } => {
				dirty_tracked.insert(dirwalk_entry.rela_path);
				match source {
					index_worktree::RewriteSource::RewriteFromIndex { source_rela_path, .. } => {
						dirty_tracked.insert(source_rela_path);
					},
					index_worktree::RewriteSource::CopyFromDirectoryEntry {
						source_dirwalk_entry,
						..
					} => {
						untracked.insert(source_dirwalk_entry.rela_path);
					},
				}
			},
			_ => {},
		}
	}
	Ok((dirty_tracked, untracked))
}

/// Drop source-bound environments from a fresh clone, never following
/// symlinks or walking Git metadata. Return the removed directory paths so
/// target-tracked entries can be checked out even when both indexes agree.
fn prune_nonrelocatable_clone_dirs(root: &Path) -> Result<BTreeSet<PathBuf>> {
	let mut excluded = BTreeSet::new();
	let mut pending = vec![root.to_path_buf()];
	while let Some(dir) = pending.pop() {
		let marked = dir.join("pyvenv.cfg").is_file() || dir.join("CMakeCache.txt").is_file();
		if marked && dir != root {
			remove_existing(&dir)?;
			excluded.insert(
				dir.strip_prefix(root)
					.expect("cloned directory is under root")
					.to_path_buf(),
			);
			continue;
		}
		for entry in fs::read_dir(&dir)? {
			let entry = entry?;
			if entry.file_name() == ".git" {
				continue;
			}
			if marked {
				remove_existing(&entry.path())?;
			} else if entry.file_type()?.is_dir() {
				pending.push(entry.path());
			}
		}
		if marked {
			excluded.insert(PathBuf::new());
		}
	}
	Ok(excluded)
}

/// Carry one live source path without following symlinks, including a
/// deletion. Used both by ordinary-checkout seeding and by tracked files
/// restored after clone exclusions.
fn copy_worktree_path(source: &Path, target: &Path, relative: &gix::bstr::BStr) -> Result<()> {
	let relative = relative.to_path_lossy();
	let src = source.join(&relative);
	let dst = target.join(&relative);
	match fs::symlink_metadata(&src) {
		Ok(meta) if meta.file_type().is_symlink() => {
			remove_existing(&dst)?;
			if let Some(parent) = dst.parent() {
				fs::create_dir_all(parent)?;
			}
			copy_symlink(&src, &dst)?;
		},
		Ok(meta) if meta.is_file() => {
			remove_existing(&dst)?;
			if let Some(parent) = dst.parent() {
				fs::create_dir_all(parent)?;
			}
			fs::copy(&src, &dst)?;
		},
		Ok(_) => {},
		Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
			remove_existing(&dst)?;
			prune_empty_parents(target, dst.parent(), &BTreeSet::new())?;
		},
		Err(err) => return Err(err.into()),
	}
	Ok(())
}

fn git_metadata_path(path: &Path) -> Cow<'_, str> {
	let display = path.to_string_lossy();
	if cfg!(windows) {
		Cow::Owned(display.replace('\\', "/"))
	} else {
		display
	}
}

fn register_worktree(path: &Path, common: &Path, head: &str) -> Result<PathBuf> {
	fs::create_dir_all(path)?;
	let name = worktree_admin_name(common, path);
	let admin = common.join("worktrees").join(name);
	fs::create_dir_all(&admin)?;
	fs::write(path.join(".git"), format!("gitdir: {}\n", git_metadata_path(&admin)))?;
	fs::write(admin.join("gitdir"), format!("{}\n", git_metadata_path(&path.join(".git"))))?;
	fs::write(admin.join("commondir"), "../..\n")?;
	fs::write(admin.join("HEAD"), format!("{head}\n"))?;
	Ok(admin)
}

fn cleanup_worktree_add(path: &Path, common: &Path) {
	let admin = registered_admin(&path.join(".git")).ok().flatten();
	let _ = fs::remove_dir_all(path);
	if let Some(admin) = admin.filter(|admin| admin.starts_with(common.join("worktrees"))) {
		let _ = fs::remove_dir_all(admin);
	}
}

/// Remove a file, symlink, or directory tree at `path`; missing is fine.
fn remove_existing(path: &Path) -> Result<()> {
	match fs::symlink_metadata(path) {
		Ok(meta) if meta.is_dir() => fs::remove_dir_all(path)?,
		Ok(_) => fs::remove_file(path)?,
		Err(err) if err.kind() == std::io::ErrorKind::NotFound => {},
		Err(err) => return Err(err.into()),
	}
	Ok(())
}

/// Recreate the symlink at `src` as `dst` (a plain file holding the link
/// target on platforms without symlinks, matching git's `core.symlinks=false`).
fn copy_symlink(src: &Path, dst: &Path) -> Result<()> {
	let target = fs::read_link(src)?;
	#[cfg(unix)]
	std::os::unix::fs::symlink(&target, dst)?;
	#[cfg(not(unix))]
	fs::write(dst, target.to_string_lossy().as_bytes())?;
	Ok(())
}

/// Remove now-empty ancestors of a deleted entry, walking up from `parent`
/// and stopping at `root`, the first non-empty directory, or — when `scope`
/// is non-empty — the first directory outside every scoped pathspec.
fn prune_empty_parents(
	root: &Path,
	mut parent: Option<&Path>,
	scope: &BTreeSet<String>,
) -> Result<()> {
	while let Some(dir) = parent {
		if dir == root {
			break;
		}
		if !scope.is_empty() {
			let Ok(rel) = dir.strip_prefix(root) else {
				break;
			};
			let rel = rel.to_string_lossy().replace('\\', "/");
			let in_scope = scope.iter().any(|p| {
				*p == rel
					|| rel
						.strip_prefix(p.as_str())
						.is_some_and(|r| r.starts_with('/'))
			});
			if !in_scope {
				break;
			}
		}
		match fs::remove_dir(dir) {
			Ok(()) => parent = dir.parent(),
			Err(err)
				if matches!(
					err.kind(),
					std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
				) =>
			{
				break;
			},
			Err(err) => return Err(err.into()),
		}
	}
	Ok(())
}

fn worktree_admin_name(common: &Path, path: &Path) -> String {
	let base = path
		.file_name()
		.and_then(|s| s.to_str())
		.filter(|s| !s.is_empty())
		.unwrap_or("worktree");
	let mut name = base.to_owned();
	let mut n = 1;
	while common.join("worktrees").join(&name).exists() {
		name = format!("{base}{n}");
		n += 1;
	}
	name
}

fn branch_is_checked_out(common: &Path, full_ref: &str) -> bool {
	let expected = format!("ref: {full_ref}");
	if fs::read_to_string(common.join("HEAD")).is_ok_and(|head| head.trim() == expected) {
		return true;
	}
	let Ok(entries) = fs::read_dir(common.join("worktrees")) else {
		return false;
	};
	entries.filter_map(std::result::Result::ok).any(|entry| {
		fs::read_to_string(entry.path().join("HEAD")).is_ok_and(|head| head.trim() == expected)
	})
}

fn tracked_worktree_dirty(repo: &GitRepo) -> Result<bool> {
	let gix = repo.gix()?;
	let index = load_index_or_head(&gix, "git worktree remove")?;
	let mut filter = WorktreeFilter::staging(&gix, "git worktree remove")?;
	for entry in index.entries() {
		let path = entry.path(&index).to_str_lossy();
		if worktree_id(&gix, &mut filter, repo.root(), &path, entry.mode)? != Some(entry.id) {
			return Ok(true);
		}
	}
	Ok(false)
}

fn snapshot_refs(repo: &gix::Repository) -> Result<Vec<(String, gix::hash::ObjectId)>> {
	let platform = repo
		.references()
		.map_err(|e| Error::backend("git detach", e))?;
	let iter = platform
		.all()
		.map_err(|e| Error::backend("git detach", e))?;
	let mut out = Vec::new();
	for reference in iter {
		let mut reference = reference.map_err(|e| Error::backend("git detach", e))?;
		let name = reference.name().as_bstr().to_str_lossy().into_owned();
		if let Ok(id) = reference.peel_to_id() {
			out.push((name, id.detach()));
		}
	}
	Ok(out)
}

fn copy_named_files(dir: &Path, prefix: &str) -> Result<Vec<(String, Vec<u8>)>> {
	let mut out = Vec::new();
	let Ok(entries) = fs::read_dir(dir) else {
		return Ok(out);
	};
	for entry in entries {
		let entry = entry?;
		let name = entry.file_name().to_string_lossy().into_owned();
		if name.starts_with(prefix) {
			out.push((name, fs::read(entry.path())?));
		}
	}
	Ok(out)
}

fn registered_admin(git_entry: &Path) -> Result<Option<PathBuf>> {
	let text = fs::read_to_string(git_entry)?;
	let Some(raw) = text.trim().strip_prefix("gitdir:") else {
		return Ok(None);
	};
	let admin = normalize_path(
		&git_entry
			.parent()
			.unwrap_or_else(|| Path::new("."))
			.join(raw.trim()),
	);
	let back = fs::read_to_string(admin.join("gitdir")).unwrap_or_default();
	let real_back =
		fs::canonicalize(back.trim()).unwrap_or_else(|_| normalize_path(Path::new(back.trim())));
	let real_entry = fs::canonicalize(git_entry).unwrap_or_else(|_| normalize_path(git_entry));
	Ok((real_back == real_entry).then_some(admin))
}

fn write_loose_ref(git_dir: &Path, name: &str, id: gix::hash::ObjectId) -> Result<()> {
	let path = git_dir.join(name);
	if let Some(parent) = path.parent() {
		fs::create_dir_all(parent)?;
	}
	fs::write(path, format!("{}\n", id.to_hex()))?;
	Ok(())
}

