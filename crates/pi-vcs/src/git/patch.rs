//! Patch application, hunk staging, stash, and cherry-pick for
//! [`GitRepo`](super::GitRepo).
//!
//! Patch joins deliberately preserve binary-patch terminators (issue #8899).
//! Cherry-picks are fail-clean: unlike `git cherry-pick`, conflicts do not put
//! markers or unmerged entries in the checkout, and only the picked paths are
//! rewritten — the pick is refused when one of them carries local changes,
//! while unrelated dirty paths stay as they are. Stash pop is likewise
//! preflighted so a rejected restore leaves no trace (issue #4175).

use std::{
	collections::{BTreeMap, BTreeSet},
	fs,
	path::{Component, Path, PathBuf},
};

use gix::{
	bstr::{BStr, ByteSlice},
	index::entry::{Flags, Mode, Stage, Stat},
	merge::tree::TreatAsUnresolved,
	objs::tree::EntryKind,
	refs::transaction::PreviousValue,
};

use super::{
	GitRepo,
	filter::WorktreeFilter,
	mutate::update_reference,
	open::{load_index_or_head, status_with_index},
};
use crate::{
	error::{Error, Result},
	types::{ApplyOptions, DiffOptions, HunkSelection, HunkSelectionError, HunkSpec},
};

#[derive(Clone, Debug, PartialEq, Eq)]
struct FileEntry {
	id:            gix::ObjectId,
	mode:          Mode,
	/// Index entry carries git's intent-to-add flag (`git add -N`): the path
	/// is promised but has no staged content yet.
	intent_to_add: bool,
}
impl FileEntry {
	const fn new(id: gix::ObjectId, mode: Mode) -> Self {
		Self { id, mode, intent_to_add: false }
	}
}

#[derive(Clone, Debug)]
struct FilePatch {
	old_path: Option<String>,
	new_path: Option<String>,
	old_mode: Option<Mode>,
	new_mode: Option<Mode>,
	old_oid:  Option<String>,
	new_oid:  Option<String>,
	hunks:    Vec<Hunk>,
	binary:   Vec<BinaryBlock>,
	raw:      String,
}

#[derive(Clone, Debug)]
struct Hunk {
	old_start: usize,
	old_count: usize,
	new_start: usize,
	new_count: usize,
	lines:     Vec<HunkLine>,
	raw:       String,
}

#[derive(Clone, Debug)]
struct HunkLine {
	kind:       u8,
	data:       Vec<u8>,
	no_newline: bool,
}

#[derive(Clone, Debug)]
struct BinaryBlock {
	kind:    BinaryKind,
	size:    usize,
	encoded: Vec<String>,
}

#[derive(Clone, Copy, Debug)]
enum BinaryKind {
	Literal,
	Delta,
}

#[derive(Debug)]
enum ApplyFailure {
	Context(String),
	Invalid(String),
}

impl ApplyFailure {
	fn into_error(self) -> Error {
		let message = match self {
			Self::Context(message) | Self::Invalid(message) => message,
		};
		Error::PatchFailed { message }
	}
}

impl GitRepo {
	/// Apply a git-format patch to the worktree or index.
	pub fn apply_patch(&self, patch_text: &str, options: &ApplyOptions) -> Result<()> {
		if patch_text.trim().is_empty() {
			return Ok(());
		}
		let patches = parse_patch(patch_text).map_err(ApplyFailure::into_error)?;
		let repo = self.gix()?;
		if options.cached {
			let mut state = index_map_at(&repo, options.index_path.as_deref())?;
			apply_patches_to_map(&repo, &mut state, &patches, options)?;
			return write_index_map_at(&repo, &state, options.index_path.as_deref());
		}
		let mut filter = apply_filter(&repo, &patches, options.reverse)?;
		let mut state = patch_worktree_map(self, &repo, &mut filter, &patches, options.reverse)?;
		apply_patches_to_map(&repo, &mut state, &patches, options)?;
		write_patch_worktree(self, &repo, &mut filter, &patches, options.reverse, &state)
	}

	/// Check whether a patch applies without changing the index or worktree.
	pub fn can_apply_patch(&self, patch_text: &str, options: &ApplyOptions) -> Result<bool> {
		if patch_text.trim().is_empty() {
			return Ok(true);
		}
		let Ok(patches) = parse_patch(patch_text) else {
			return Ok(false);
		};
		let repo = self.gix()?.with_object_memory();
		let mut state = if options.cached {
			index_map_at(&repo, options.index_path.as_deref())?
		} else {
			let mut filter = apply_filter(&repo, &patches, options.reverse)?;
			patch_worktree_map(self, &repo, &mut filter, &patches, options.reverse)?
		};
		match apply_patches_to_map(&repo, &mut state, &patches, options) {
			Ok(()) => Ok(true),
			Err(Error::PatchFailed { .. } | Error::Conflict { .. }) => Ok(false),
			Err(err) => Err(err),
		}
	}

	/// Stage selected hunks from a supplied or freshly generated worktree diff.
	pub fn stage_hunks(&self, selections: &[HunkSelection], raw_diff: Option<&str>) -> Result<()> {
		if selections.is_empty() {
			return Ok(());
		}
		let owned;
		let raw_diff = if let Some(raw_diff) = raw_diff {
			raw_diff
		} else {
			owned = self.diff_text(&DiffOptions::default())?;
			&owned
		};
		let files = parse_patch(raw_diff).map_err(ApplyFailure::into_error)?;
		let mut by_path = BTreeMap::new();
		for file in &files {
			if let Some(path) = file.new_path.as_ref().or(file.old_path.as_ref()) {
				by_path.insert(path.as_str(), file);
			}
		}
		let mut parts = Vec::with_capacity(selections.len());
		for selection in selections {
			let Some(file) = by_path.get(selection.path.as_str()) else {
				return Err(Error::PatchFailed {
					message: format!("No diff found for {}", selection.path),
				});
			};
			if !file.binary.is_empty() {
				if !matches!(selection.hunks, HunkSpec::All) {
					return Err(Error::PatchFailed {
						message: format!("Cannot select hunks for binary file {}", selection.path),
					});
				}
				parts.push(file.raw.clone());
				continue;
			}
			if matches!(selection.hunks, HunkSpec::All) {
				parts.push(file.raw.clone());
				continue;
			}
			let selected = select_hunks(file, &selection.hunks);
			if selected.is_empty() {
				return Err(Error::PatchFailed {
					message: format!("No hunks selected for {}", selection.path),
				});
			}
			let header = extract_file_header(&file.raw);
			let mut part = header.to_owned();
			for hunk in selected {
				if !part.ends_with('\n') {
					part.push('\n');
				}
				part.push_str(&hunk.raw);
			}
			parts.push(part);
		}
		let patch = join_patches(&parts);
		self.apply_patch(&patch, &ApplyOptions {
			cached:     true,
			index_path: None,
			reverse:    false,
			three_way:  false,
		})
	}

	/// Cherry-pick one commit with a fail-clean three-way tree merge.
	pub fn cherry_pick(&self, rev: &str) -> Result<()> {
		let repo = self.gix()?;
		let picked_id = repo
			.rev_parse_single(rev)
			.map_err(|err| Error::backend("git cherry-pick resolve", err))?
			.detach();
		let picked = repo
			.find_commit(picked_id)
			.map_err(|err| Error::backend("git cherry-pick commit", err))?;
		let parent_id = picked.parent_ids().next().map(|id| id.detach());
		let head = repo
			.head_commit()
			.map_err(|err| Error::backend("git cherry-pick HEAD", err))?;
		let head_id = head.id().detach();
		let head_tree = head
			.tree_id()
			.map_err(|err| Error::backend("git cherry-pick HEAD tree", err))?;
		let parent_tree = if let Some(parent_id) = parent_id {
			repo
				.find_commit(parent_id)
				.map_err(|err| Error::backend("git cherry-pick parent", err))?
				.tree_id()
				.map_err(|err| Error::backend("git cherry-pick parent tree", err))?
				.detach()
		} else {
			repo.empty_tree().id().detach()
		};
		let picked_tree = picked
			.tree_id()
			.map_err(|err| Error::backend("git cherry-pick picked tree", err))?;
		let options = repo
			.tree_merge_options()
			.map_err(|err| Error::backend("git cherry-pick options", err))?;
		let labels = gix::merge::blob::builtin_driver::text::Labels {
			ancestor: Some("base".into()),
			current:  Some("HEAD".into()),
			other:    Some(rev.into()),
		};
		let mut outcome = repo
			.merge_trees(parent_tree, head_tree, picked_tree, labels, options)
			.map_err(|err| Error::backend("git cherry-pick merge", err))?;
		if outcome.has_unresolved_conflicts(TreatAsUnresolved::default()) {
			return Err(Error::Conflict { paths: Vec::new() });
		}
		let merged_tree = outcome
			.tree
			.write()
			.map_err(|err| Error::backend("git cherry-pick write tree", err))?
			.detach();
		if merged_tree == head_tree.detach() {
			return Err(Error::EmptyCherryPick { sha: picked_id.to_string() });
		}
		let head_map = tree_map(&repo, head_tree.detach())?;
		let merged = tree_map(&repo, merged_tree)?;
		let changed: BTreeSet<String> = head_map
			.keys()
			.chain(merged.keys())
			.filter(|path| head_map.get(*path) != merged.get(*path))
			.cloned()
			.collect();
		let unstaged = unstaged_changed_paths(&repo, &head_map, &changed)?;
		let mut filter = WorktreeFilter::staging(&repo, "git cherry-pick")?;
		// Picked paths with unstaged edits get `HEAD + edits + pick` in the
		// worktree, merged the same fail-clean way as the pick itself.
		let local_map;
		let worktree = if unstaged.is_empty() {
			&merged
		} else {
			let mut editor = repo
				.find_tree(head_tree)
				.map_err(|err| Error::backend("git cherry-pick HEAD tree", err))?
				.edit()
				.map_err(|err| Error::backend("git cherry-pick edit tree", err))?;
			for path in &unstaged {
				let mode = head_map.get(path).map_or(Mode::FILE, |entry| entry.mode);
				match read_worktree_entry(self, &mut filter, path, mode)? {
					Some((bytes, mode)) => {
						let id = repo
							.write_blob(bytes)
							.map_err(|err| Error::backend("git hash worktree blob", err))?
							.detach();
						editor
							.upsert(path.as_str(), entry_kind(mode), id)
							.map_err(|err| Error::backend("git cherry-pick edit tree", err))?;
					},
					None => {
						editor
							.remove(path.as_str())
							.map_err(|err| Error::backend("git cherry-pick edit tree", err))?;
					},
				}
			}
			let local_tree = editor
				.write()
				.map_err(|err| Error::backend("git cherry-pick write tree", err))?
				.detach();
			let labels = gix::merge::blob::builtin_driver::text::Labels {
				ancestor: Some("HEAD".into()),
				current:  Some("local changes".into()),
				other:    Some(rev.into()),
			};
			let options = repo
				.tree_merge_options()
				.map_err(|err| Error::backend("git cherry-pick options", err))?;
			let mut local = repo
				.merge_trees(head_tree, local_tree, merged_tree, labels, options)
				.map_err(|err| Error::backend("git cherry-pick merge", err))?;
			if local.has_unresolved_conflicts(TreatAsUnresolved::default()) {
				return Err(overwrite_error(&unstaged));
			}
			let tree = local
				.tree
				.write()
				.map_err(|err| Error::backend("git cherry-pick write tree", err))?
				.detach();
			local_map = tree_map(&repo, tree)?;
			&local_map
		};
		let author = picked
			.author()
			.map_err(|err| Error::backend("git cherry-pick author", err))?;
		let committer = repo
			.committer()
			.ok_or_else(|| Error::backend("git cherry-pick", "committer identity is not configured"))?
			.map_err(|err| Error::backend("git cherry-pick committer", err))?;
		let message = picked
			.message_raw()
			.map_err(|err| Error::backend("git cherry-pick message", err))?
			.to_str_lossy();
		repo
			.commit_as(committer, author, "HEAD", message.as_ref(), merged_tree, [head_id])
			.map_err(|err| Error::backend("git cherry-pick commit", err))?;
		checkout_changed_paths(self, &repo, &mut filter, &merged, worktree, &changed, &unstaged)
	}

	/// Clear cherry-pick state; fail-clean single-commit picks create none.
	pub const fn cherry_pick_abort(&self) -> Result<()> {
		Ok(())
	}

	/// Skip cherry-pick state; single-commit picks have no sequencer.
	pub const fn cherry_pick_skip(&self) -> Result<()> {
		Ok(())
	}

	/// Stash index, tracked worktree changes, and untracked files.
	pub fn stash_push(&self, message: Option<&str>) -> Result<bool> {
		let repo = self.gix()?;
		let head = repo
			.head_commit()
			.map_err(|err| Error::backend("git stash HEAD", err))?;
		let head_id = head.id().detach();
		let head_tree = head
			.tree_id()
			.map_err(|err| Error::backend("git stash HEAD tree", err))?
			.detach();
		let head_map = tree_map(&repo, head_tree)?;
		let index = index_map(&repo)?;
		let mut filter = WorktreeFilter::staging(&repo, "git stash")?;
		let tracked_worktree = tracked_worktree_map(self, &repo, &mut filter, &index)?;
		let untracked = untracked_worktree_map(self, &repo, &mut filter, &index)?;
		if index == head_map && tracked_worktree == index && untracked.is_empty() {
			return Ok(false);
		}
		let index_tree = write_tree_map(&repo, &index)?;
		let worktree_tree = write_tree_map(&repo, &tracked_worktree)?;
		let untracked_tree = write_tree_map(&repo, &untracked)?;
		let label = message.unwrap_or("WIP");
		let index_commit = repo
			.new_commit(format!("index on HEAD: {label}"), index_tree, [head_id])
			.map_err(|err| Error::backend("git stash index commit", err))?;
		let untracked_commit = repo
			.new_commit("untracked files on HEAD", untracked_tree, std::iter::empty::<gix::ObjectId>())
			.map_err(|err| Error::backend("git stash untracked commit", err))?;
		let stash_commit = repo
			.new_commit(label, worktree_tree, [
				head_id,
				index_commit.id().detach(),
				untracked_commit.id().detach(),
			])
			.map_err(|err| Error::backend("git stash commit", err))?;
		update_stash_ref(
			&repo,
			stash_commit.id().detach(),
			PreviousValue::Any,
			format!("On HEAD: {label}"),
			true,
		)?;
		write_worktree_map(self, &repo, &mut filter, &tracked_worktree, &head_map)?;
		write_index_map(&repo, &head_map)?;
		for path in untracked.keys() {
			remove_worktree_path(self, path)?;
		}
		Ok(true)
	}

	/// Try to pop the top stash without leaving partial conflict state.
	pub fn stash_try_pop(&self, reinstate_index: bool) -> Result<bool> {
		let repo = self.gix()?;
		let Some(stash_ref) = repo
			.try_find_reference("refs/stash")
			.map_err(|err| Error::backend("git stash resolve", err))?
		else {
			return Ok(false);
		};
		let stash_id = stash_ref.id().detach();
		let stash_log = fs::read(self.info().common_dir.join("logs/refs/stash")).ok();
		let stash = repo
			.find_commit(stash_id)
			.map_err(|err| Error::backend("git stash commit", err))?;
		let parents: Vec<_> = stash.parent_ids().map(|id| id.detach()).collect();
		if parents.len() < 2 {
			return Err(Error::backend("git stash pop", "stash commit has fewer than two parents"));
		}
		let base = repo
			.find_commit(parents[0])
			.map_err(|err| Error::backend("git stash base", err))?;
		let base_tree = base
			.tree_id()
			.map_err(|err| Error::backend("git stash base tree", err))?
			.detach();
		let stash_tree = stash
			.tree_id()
			.map_err(|err| Error::backend("git stash tree", err))?
			.detach();
		let current_index = index_map(&repo)?;
		let mut filter = WorktreeFilter::staging(&repo, "git stash")?;
		let current_worktree = tracked_worktree_map(self, &repo, &mut filter, &current_index)?;
		let current_tree = write_tree_map(&repo, &current_worktree)?;
		let Some(merged_worktree) = merge_tree_maps(&repo, base_tree, current_tree, stash_tree)?
		else {
			return Ok(false);
		};
		let merged_index = if reinstate_index {
			let stash_index = repo
				.find_commit(parents[1])
				.map_err(|err| Error::backend("git stash index", err))?;
			let stash_index_tree = stash_index
				.tree_id()
				.map_err(|err| Error::backend("git stash index tree", err))?
				.detach();
			let current_index_tree = write_tree_map(&repo, &current_index)?;
			let Some(merged) =
				merge_tree_maps(&repo, base_tree, current_index_tree, stash_index_tree)?
			else {
				return Ok(false);
			};
			Some(merged)
		} else {
			None
		};
		let untracked = if let Some(parent) = parents.get(2) {
			let untracked_commit = repo
				.find_commit(*parent)
				.map_err(|err| Error::backend("git stash untracked", err))?;
			let tree = untracked_commit
				.tree_id()
				.map_err(|err| Error::backend("git stash untracked tree", err))?;
			tree_map(&repo, tree.detach())?
		} else {
			BTreeMap::new()
		};
		for path in untracked.keys() {
			if self.root().join(path).symlink_metadata().is_ok() {
				return Ok(false);
			}
		}
		write_worktree_map(self, &repo, &mut filter, &current_worktree, &merged_worktree)?;
		for (path, entry) in &untracked {
			write_worktree_entry(self, &repo, &mut filter, path, entry)?;
		}
		if let Some(merged_index) = merged_index {
			write_index_map(&repo, &merged_index)?;
		}
		drop_stash(self, &repo, &stash_ref, stash_id, stash_log.as_deref())?;
		Ok(true)
	}
}

/// Join patch parts verbatim, adding one final newline only when absent.
pub fn join_patches(parts: &[String]) -> String {
	let capacity = parts
		.iter()
		.map(|part| part.len() + usize::from(!part.ends_with('\n')))
		.sum();
	let mut joined = String::with_capacity(capacity);
	for part in parts {
		joined.push_str(part);
		if !part.ends_with('\n') {
			joined.push('\n');
		}
	}
	joined
}

/// Validate hunk selections against a raw git diff.
pub fn validate_hunk_selections(
	raw_diff: &str,
	selections: &[HunkSelection],
) -> Vec<HunkSelectionError> {
	let Ok(files) = parse_patch(raw_diff) else {
		return Vec::new();
	};
	let mut by_path = BTreeMap::new();
	for file in &files {
		if let Some(path) = file.new_path.as_ref().or(file.old_path.as_ref()) {
			by_path.insert(path.as_str(), file);
		}
	}
	let mut errors = Vec::new();
	for selection in selections {
		let Some(file) = by_path.get(selection.path.as_str()) else {
			continue;
		};
		if matches!(selection.hunks, HunkSpec::All) {
			continue;
		}
		if !file.binary.is_empty() {
			errors.push(HunkSelectionError {
				path:    selection.path.clone(),
				message: format!("Cannot select hunks for binary file {}", selection.path),
			});
		} else if select_hunks(file, &selection.hunks).is_empty() {
			errors.push(HunkSelectionError {
				path:    selection.path.clone(),
				message: format!("No hunks selected for {}", selection.path),
			});
		}
	}
	errors
}

fn parse_patch(text: &str) -> std::result::Result<Vec<FilePatch>, ApplyFailure> {
	let starts: Vec<_> = text
		.match_indices("diff --git ")
		.filter(|(idx, _)| *idx == 0 || text.as_bytes()[idx - 1] == b'\n')
		.map(|(idx, _)| idx)
		.collect();
	if starts.is_empty() {
		return Err(ApplyFailure::Invalid("patch has no diff --git header".into()));
	}
	let mut files = Vec::with_capacity(starts.len());
	for (position, start) in starts.iter().copied().enumerate() {
		let end = starts.get(position + 1).copied().unwrap_or(text.len());
		files.push(parse_file_patch(&text[start..end])?);
	}
	Ok(files)
}

fn parse_file_patch(raw: &str) -> std::result::Result<FilePatch, ApplyFailure> {
	let lines: Vec<&str> = raw.split_inclusive('\n').collect();
	let first = lines
		.first()
		.map_or_default(|line| line.trim_end_matches('\n'));
	let paths = first
		.strip_prefix("diff --git ")
		.ok_or_else(|| ApplyFailure::Invalid("invalid diff header".into()))?;
	let (old_token, new_token) = split_diff_paths(paths)?;
	let mut patch = FilePatch {
		old_path: Some(strip_side_path(old_token, 'a')),
		new_path: Some(strip_side_path(new_token, 'b')),
		old_mode: None,
		new_mode: None,
		old_oid:  None,
		new_oid:  None,
		hunks:    Vec::new(),
		binary:   Vec::new(),
		raw:      raw.to_owned(),
	};
	let mut index = 1;
	while index < lines.len() {
		let line = lines[index].trim_end_matches('\n');
		if let Some(value) = line.strip_prefix("old mode ") {
			patch.old_mode = parse_mode(value);
		} else if let Some(value) = line.strip_prefix("new mode ") {
			patch.new_mode = parse_mode(value);
		} else if let Some(value) = line.strip_prefix("new file mode ") {
			patch.old_path = None;
			patch.new_mode = parse_mode(value);
		} else if let Some(value) = line.strip_prefix("deleted file mode ") {
			patch.new_path = None;
			patch.old_mode = parse_mode(value);
		} else if let Some(value) = line.strip_prefix("rename from ") {
			patch.old_path = Some(unquote_path(value));
		} else if let Some(value) = line.strip_prefix("rename to ") {
			patch.new_path = Some(unquote_path(value));
		} else if let Some(value) = line.strip_prefix("index ") {
			let ids = value.split_whitespace().next().unwrap_or_default();
			if let Some((old, new)) = ids.split_once("..") {
				patch.old_oid = Some(old.to_owned());
				patch.new_oid = Some(new.to_owned());
			}
			if let Some(mode) = value.split_whitespace().nth(1).and_then(parse_mode) {
				patch.old_mode.get_or_insert(mode);
				patch.new_mode.get_or_insert(mode);
			}
		} else if let Some(value) = line.strip_prefix("--- ") {
			patch.old_path = parse_marker_path(value, 'a');
		} else if let Some(value) = line.strip_prefix("+++ ") {
			patch.new_path = parse_marker_path(value, 'b');
		} else if line.starts_with("@@") {
			let (hunk, next) = parse_hunk(&lines, index)?;
			patch.hunks.push(hunk);
			index = next;
			continue;
		} else if line == "GIT binary patch" {
			index += 1;
			while index < lines.len() {
				let header = lines[index].trim_end_matches('\n');
				let Some((kind, size)) = parse_binary_header(header) else {
					break;
				};
				index += 1;
				let mut encoded = Vec::new();
				while index < lines.len() {
					let data = lines[index].trim_end_matches('\n');
					if data.is_empty() {
						index += 1;
						break;
					}
					if parse_binary_header(data).is_some() {
						break;
					}
					encoded.push(data.to_owned());
					index += 1;
				}
				patch.binary.push(BinaryBlock { kind, size, encoded });
			}
			continue;
		}
		index += 1;
	}
	if patch.hunks.is_empty()
		&& patch.binary.is_empty()
		&& patch.old_path == patch.new_path
		&& patch.old_mode == patch.new_mode
	{
		return Err(ApplyFailure::Invalid("patch contains no change".into()));
	}
	Ok(patch)
}

fn split_diff_paths(paths: &str) -> std::result::Result<(&str, &str), ApplyFailure> {
	if paths.starts_with('"') {
		return Err(ApplyFailure::Invalid("quoted paths in diff headers are unsupported".into()));
	}
	paths
		.split_once(' ')
		.ok_or_else(|| ApplyFailure::Invalid("invalid diff paths".into()))
}

fn unquote_path(path: &str) -> String {
	path.trim_matches('"').to_owned()
}

fn strip_side_path(token: &str, side: char) -> String {
	let prefix = format!("{side}/");
	unquote_path(token.strip_prefix(&prefix).unwrap_or(token))
}

fn parse_marker_path(value: &str, side: char) -> Option<String> {
	let path = value.split('\t').next().unwrap_or(value);
	if path == "/dev/null" {
		None
	} else {
		Some(strip_side_path(path, side))
	}
}

fn parse_mode(value: &str) -> Option<Mode> {
	let bits = u32::from_str_radix(value.trim(), 8).ok()?;
	Mode::from_bits(bits)
}

fn parse_hunk(lines: &[&str], start: usize) -> std::result::Result<(Hunk, usize), ApplyFailure> {
	let header = lines[start].trim_end_matches('\n');
	let (old_start, old_count, new_start, new_count) = parse_hunk_header(header)?;
	let mut body: Vec<HunkLine> = Vec::new();
	let mut raw = String::from(lines[start]);
	let mut index = start + 1;
	while index < lines.len() {
		let line = lines[index];
		let bare = line.trim_end_matches('\n');
		if bare.starts_with("@@") || bare.starts_with("diff --git ") || bare == "GIT binary patch" {
			break;
		}
		let Some(kind @ (b' ' | b'+' | b'-')) = bare.as_bytes().first().copied() else {
			if bare == "\\ No newline at end of file" {
				let Some(previous) = body.last_mut() else {
					return Err(ApplyFailure::Invalid("orphan no-newline marker".into()));
				};
				previous.no_newline = true;
				raw.push_str(line);
				index += 1;
				continue;
			}
			break;
		};
		body.push(HunkLine { kind, data: bare.as_bytes()[1..].to_vec(), no_newline: false });
		raw.push_str(line);
		index += 1;
	}
	let actual_old = body.iter().filter(|line| line.kind != b'+').count();
	let actual_new = body.iter().filter(|line| line.kind != b'-').count();
	if actual_old != old_count || actual_new != new_count {
		return Err(ApplyFailure::Invalid(format!("hunk count mismatch in {header}")));
	}
	Ok((Hunk { old_start, old_count, new_start, new_count, lines: body, raw }, index))
}

fn parse_hunk_header(
	header: &str,
) -> std::result::Result<(usize, usize, usize, usize), ApplyFailure> {
	let body = header
		.strip_prefix("@@ -")
		.and_then(|value| value.split_once(" @@").map(|pair| pair.0))
		.ok_or_else(|| ApplyFailure::Invalid(format!("invalid hunk header: {header}")))?;
	let (old, new) = body
		.split_once(" +")
		.ok_or_else(|| ApplyFailure::Invalid(format!("invalid hunk header: {header}")))?;
	let parse_range = |value: &str| -> Option<(usize, usize)> {
		let (start, count) = value.split_once(',').unwrap_or((value, "1"));
		Some((start.parse().ok()?, count.parse().ok()?))
	};
	let (old_start, old_count) = parse_range(old)
		.ok_or_else(|| ApplyFailure::Invalid(format!("invalid hunk range: {header}")))?;
	let (new_start, new_count) = parse_range(new)
		.ok_or_else(|| ApplyFailure::Invalid(format!("invalid hunk range: {header}")))?;
	Ok((old_start, old_count, new_start, new_count))
}

fn parse_binary_header(line: &str) -> Option<(BinaryKind, usize)> {
	let (kind, size) = line.split_once(' ')?;
	let kind = match kind {
		"literal" => BinaryKind::Literal,
		"delta" => BinaryKind::Delta,
		_ => return None,
	};
	Some((kind, size.parse().ok()?))
}

fn select_hunks<'a>(file: &'a FilePatch, spec: &HunkSpec) -> Vec<&'a Hunk> {
	match spec {
		HunkSpec::All => file.hunks.iter().collect(),
		HunkSpec::Indices(indices) => {
			let wanted: BTreeSet<_> = indices
				.iter()
				.map(|index| (*index).max(1) as usize)
				.collect();
			file
				.hunks
				.iter()
				.enumerate()
				.filter(|(index, _)| wanted.contains(&(index + 1)))
				.map(|(_, hunk)| hunk)
				.collect()
		},
		HunkSpec::Lines { start, end } => file
			.hunks
			.iter()
			.filter(|hunk| {
				let first = hunk.new_start as u32;
				let last = first
					.saturating_add(hunk.new_count as u32)
					.saturating_sub(1);
				first <= *end && last >= *start
			})
			.collect(),
	}
}

fn extract_file_header(raw: &str) -> &str {
	raw.find("\n@@").map_or(raw, |position| &raw[..=position])
}

fn apply_patches_to_map(
	repo: &gix::Repository,
	state: &mut BTreeMap<String, FileEntry>,
	patches: &[FilePatch],
	options: &ApplyOptions,
) -> Result<()> {
	for patch in patches {
		let (source_path, target_path, source_mode, target_mode) =
			patch_sides(patch, options.reverse);
		// A create patch may land on an intent-to-add entry: git treats the
		// promised path as absent and stages the real content over it.
		if source_path.is_none()
			&& target_path
				.and_then(|path| state.get(path))
				.is_some_and(|entry| !entry.intent_to_add)
		{
			return Err(Error::PatchFailed {
				message: format!("{} already exists", target_path.unwrap_or_default()),
			});
		}
		let source = source_path.and_then(|path| state.get(path).cloned());
		if source_path.is_some() && source.is_none() {
			return Err(Error::PatchFailed {
				message: format!("{} does not exist", source_path.unwrap_or_default()),
			});
		}
		if source_mode.is_some_and(|mode| source.as_ref().is_some_and(|entry| entry.mode != mode)) {
			return Err(Error::PatchFailed {
				message: format!("mode does not match for {}", source_path.unwrap_or_default()),
			});
		}
		if source
			.as_ref()
			.is_some_and(|entry| entry.mode == Mode::COMMIT)
			|| target_mode == Some(Mode::COMMIT)
		{
			let (preimage, postimage) = if options.reverse {
				(b'+', b'-')
			} else {
				(b'-', b'+')
			};
			// `git apply` reads a gitlink preimage only from the index; worktree
			// application drops gitlink hunks, so any directory stands for the old
			// commit. A pure rename has no hunk and keeps the source commit.
			let changed = !patch.hunks.is_empty();
			if options.cached
				&& changed
				&& let Some(entry) = &source
				&& entry.id != gitlink_id(patch, preimage)?
			{
				return Err(Error::PatchFailed {
					message: format!("gitlink does not match for {}", source_path.unwrap_or_default()),
				});
			}
			if let Some(path) = source_path
				&& target_path != Some(path)
			{
				state.remove(path);
			}
			if let Some(path) = target_path {
				validate_repo_path(path).map_err(ApplyFailure::into_error)?;
				let id = match &source {
					Some(entry) if !changed => entry.id,
					_ => gitlink_id(patch, postimage)?,
				};
				state.insert(path.to_owned(), FileEntry::new(id, Mode::COMMIT));
			}
			continue;
		}
		let source_bytes = match source.as_ref() {
			Some(entry) => blob_bytes(repo, entry.id)?,
			None => Vec::new(),
		};
		let direct = apply_file_bytes(patch, &source_bytes, options.reverse);
		let bytes = match direct {
			Ok(bytes) => bytes,
			Err(ApplyFailure::Context(_)) if options.three_way => {
				merge_patch_bytes(repo, patch, source.as_ref(), options.reverse)?
			},
			Err(err) => return Err(err.into_error()),
		};
		if let Some(path) = source_path
			&& target_path != Some(path)
		{
			state.remove(path);
		}
		if let Some(path) = target_path {
			validate_repo_path(path).map_err(ApplyFailure::into_error)?;
			let id = repo
				.write_blob(&bytes)
				.map_err(|err| Error::backend("git apply write blob", err))?
				.detach();
			let mode = target_mode
				.or_else(|| source.as_ref().map(|entry| entry.mode))
				.or(source_mode)
				.unwrap_or(Mode::FILE);
			state.insert(path.to_owned(), FileEntry::new(id, mode));
		}
	}
	Ok(())
}

fn gitlink_id(patch: &FilePatch, kind: u8) -> Result<gix::ObjectId> {
	let id = patch
		.hunks
		.iter()
		.flat_map(|hunk| &hunk.lines)
		.find(|line| line.kind == kind)
		.and_then(|line| line.data.strip_prefix(b"Subproject commit "))
		.ok_or_else(|| Error::PatchFailed { message: "gitlink patch lacks a commit id".into() })?;
	gix::ObjectId::from_hex(id)
		.map_err(|_| Error::PatchFailed { message: "gitlink patch has an invalid commit id".into() })
}

fn patch_sides(
	patch: &FilePatch,
	reverse: bool,
) -> (Option<&str>, Option<&str>, Option<Mode>, Option<Mode>) {
	if reverse {
		(patch.new_path.as_deref(), patch.old_path.as_deref(), patch.new_mode, patch.old_mode)
	} else {
		(patch.old_path.as_deref(), patch.new_path.as_deref(), patch.old_mode, patch.new_mode)
	}
}

fn apply_file_bytes(
	patch: &FilePatch,
	source: &[u8],
	reverse: bool,
) -> std::result::Result<Vec<u8>, ApplyFailure> {
	if !patch.binary.is_empty() {
		let block = if reverse {
			patch.binary.get(1).or_else(|| patch.binary.first())
		} else {
			patch.binary.first()
		}
		.ok_or_else(|| ApplyFailure::Invalid("binary patch has no data block".into()))?;
		return decode_binary_block(block, source);
	}
	if patch.hunks.is_empty() {
		return Ok(source.to_vec());
	}
	let source_lines = split_lines(source);
	// The image each hunk applies to is always `head` (rewritten so far)
	// followed by the untouched `source_lines[tail..]`. Ascending hunks land in
	// the tail and copy forward; one reaching back into rewritten lines
	// (overlapping hunks) materializes the image and splices into it.
	let mut head: Vec<Line<'_>> = Vec::with_capacity(source_lines.len());
	let mut tail = 0;
	let mut offset: isize = 0;
	for hunk in &patch.hunks {
		let (start, count, replacement, expected) = hunk_sides(hunk, reverse);
		let position = if count == 0 {
			start as isize
		} else {
			start.saturating_sub(1) as isize
		} + offset;
		if position < 0 {
			return Err(ApplyFailure::Context("hunk position precedes file".into()));
		}
		let position = position as usize;
		let applies = if position >= head.len() {
			let from = tail + (position - head.len());
			let end = from.saturating_add(expected.len());
			let applies = source_lines.get(from..end) == Some(&expected[..]);
			if applies {
				head.extend_from_slice(&source_lines[tail..from]);
				head.extend_from_slice(&replacement);
				tail = end;
			}
			applies
		} else {
			head.extend_from_slice(&source_lines[tail..]);
			tail = source_lines.len();
			let range = position..position + expected.len();
			let applies = head.get(range.clone()) == Some(&expected[..]);
			if applies {
				head.splice(range, replacement.iter().copied());
			}
			applies
		};
		if !applies {
			return Err(ApplyFailure::Context(format!("hunk at line {start} does not apply")));
		}
		offset += replacement.len() as isize - expected.len() as isize;
	}
	head.extend_from_slice(&source_lines[tail..]);
	let mut out = Vec::with_capacity(source.len());
	for line in head {
		out.extend_from_slice(line.data);
		if line.newline {
			out.push(b'\n');
		}
	}
	Ok(out)
}

/// One source or hunk line, borrowed: its bytes without the terminator and
/// whether a `\n` follows.
#[derive(Clone, Copy, PartialEq, Eq)]
struct Line<'a> {
	data:    &'a [u8],
	newline: bool,
}

fn hunk_sides(hunk: &Hunk, reverse: bool) -> (usize, usize, Vec<Line<'_>>, Vec<Line<'_>>) {
	let mut old = Vec::new();
	let mut new = Vec::new();
	for line in &hunk.lines {
		let content = Line { data: &line.data, newline: !line.no_newline };
		if line.kind != b'+' {
			old.push(content);
		}
		if line.kind != b'-' {
			new.push(content);
		}
	}
	if reverse {
		(hunk.new_start, hunk.new_count, old, new)
	} else {
		(hunk.old_start, hunk.old_count, new, old)
	}
}

fn split_lines(bytes: &[u8]) -> Vec<Line<'_>> {
	let mut lines = Vec::new();
	let mut rest = bytes;
	while !rest.is_empty() {
		if let Some(end) = rest.iter().position(|&byte| byte == b'\n') {
			lines.push(Line { data: &rest[..end], newline: true });
			rest = &rest[end + 1..];
		} else {
			lines.push(Line { data: rest, newline: false });
			break;
		}
	}
	lines
}

fn decode_binary_block(
	block: &BinaryBlock,
	base: &[u8],
) -> std::result::Result<Vec<u8>, ApplyFailure> {
	let mut compressed = Vec::new();
	for line in &block.encoded {
		let bytes = line.as_bytes();
		let Some(prefix) = bytes.first().copied() else {
			return Err(ApplyFailure::Invalid("empty binary data line".into()));
		};
		let decoded_len = match prefix {
			b'A'..=b'Z' => usize::from(prefix - b'A' + 1),
			b'a'..=b'z' => usize::from(prefix - b'a' + 27),
			_ => return Err(ApplyFailure::Invalid("invalid binary line length".into())),
		};
		let mut decoded = Vec::with_capacity((bytes.len().saturating_sub(1) / 5) * 4);
		for chunk in bytes[1..].chunks(5) {
			if chunk.len() != 5 {
				return Err(ApplyFailure::Invalid("truncated base85 group".into()));
			}
			let mut value = 0_u32;
			for byte in chunk {
				let digit = u32::from(decode_base85(*byte)?);
				value = value
					.checked_mul(85)
					.and_then(|value| value.checked_add(digit))
					.ok_or_else(|| ApplyFailure::Invalid("base85 overflow".into()))?;
			}
			decoded.extend_from_slice(&value.to_be_bytes());
		}
		if decoded_len > decoded.len() {
			return Err(ApplyFailure::Invalid("binary line length exceeds payload".into()));
		}
		compressed.extend_from_slice(&decoded[..decoded_len]);
	}
	let inflate_size = block.size;
	let mut inflated = vec![0; inflate_size];
	let mut decoder = gix::features::zlib::Inflate::default();
	let (status, consumed, written) = decoder
		.once(&compressed, &mut inflated)
		.map_err(|err| ApplyFailure::Invalid(format!("invalid zlib stream: {err}")))?;
	if status != gix::features::zlib::Status::StreamEnd || consumed != compressed.len() {
		return Err(ApplyFailure::Invalid("incomplete zlib stream".into()));
	}
	inflated.truncate(written);
	if inflated.len() != block.size {
		return Err(ApplyFailure::Invalid(format!(
			"binary payload size {} != {}",
			inflated.len(),
			block.size
		)));
	}
	match block.kind {
		BinaryKind::Literal => Ok(inflated),
		BinaryKind::Delta => apply_git_delta(base, &inflated),
	}
}

fn decode_base85(byte: u8) -> std::result::Result<u8, ApplyFailure> {
	const ALPHABET: &[u8; 85] =
		b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~";
	ALPHABET
		.iter()
		.position(|candidate| *candidate == byte)
		.map(|position| position as u8)
		.ok_or_else(|| ApplyFailure::Invalid(format!("invalid base85 byte {byte}")))
}

fn apply_git_delta(base: &[u8], delta: &[u8]) -> std::result::Result<Vec<u8>, ApplyFailure> {
	let mut cursor = 0;
	let base_size = read_delta_varint(delta, &mut cursor)?;
	let result_size = read_delta_varint(delta, &mut cursor)?;
	if base_size != base.len() {
		return Err(ApplyFailure::Context("binary delta base size mismatch".into()));
	}
	let mut result = Vec::with_capacity(result_size);
	while cursor < delta.len() {
		let command = delta[cursor];
		cursor += 1;
		if command & 0x80 != 0 {
			let mut offset = 0_usize;
			let mut size = 0_usize;
			for bit in 0..4 {
				if command & (1 << bit) != 0 {
					offset |= usize::from(
						*delta
							.get(cursor)
							.ok_or_else(|| ApplyFailure::Invalid("truncated delta copy offset".into()))?,
					) << (8 * bit);
					cursor += 1;
				}
			}
			for bit in 0..3 {
				if command & (1 << (4 + bit)) != 0 {
					size |= usize::from(
						*delta
							.get(cursor)
							.ok_or_else(|| ApplyFailure::Invalid("truncated delta copy size".into()))?,
					) << (8 * bit);
					cursor += 1;
				}
			}
			if size == 0 {
				size = 0x1_0000;
			}
			let end = offset
				.checked_add(size)
				.ok_or_else(|| ApplyFailure::Invalid("delta copy overflow".into()))?;
			let slice = base
				.get(offset..end)
				.ok_or_else(|| ApplyFailure::Invalid("delta copy exceeds base".into()))?;
			result.extend_from_slice(slice);
		} else if command != 0 {
			let count = usize::from(command);
			let end = cursor
				.checked_add(count)
				.ok_or_else(|| ApplyFailure::Invalid("delta insert overflow".into()))?;
			result.extend_from_slice(
				delta
					.get(cursor..end)
					.ok_or_else(|| ApplyFailure::Invalid("truncated delta insert".into()))?,
			);
			cursor = end;
		} else {
			return Err(ApplyFailure::Invalid("invalid zero delta opcode".into()));
		}
	}
	if result.len() != result_size {
		return Err(ApplyFailure::Invalid("delta result length mismatch".into()));
	}
	Ok(result)
}

fn read_delta_varint(data: &[u8], cursor: &mut usize) -> std::result::Result<usize, ApplyFailure> {
	let mut value = 0_usize;
	let mut shift = 0;
	loop {
		let byte = *data
			.get(*cursor)
			.ok_or_else(|| ApplyFailure::Invalid("truncated delta header".into()))?;
		*cursor += 1;
		value |= usize::from(byte & 0x7f)
			.checked_shl(shift)
			.ok_or_else(|| ApplyFailure::Invalid("delta varint overflow".into()))?;
		if byte & 0x80 == 0 {
			return Ok(value);
		}
		shift += 7;
		if shift >= usize::BITS {
			return Err(ApplyFailure::Invalid("delta varint overflow".into()));
		}
	}
}

fn merge_patch_bytes(
	repo: &gix::Repository,
	patch: &FilePatch,
	current: Option<&FileEntry>,
	reverse: bool,
) -> Result<Vec<u8>> {
	let old_oid = if reverse {
		patch.new_oid.as_deref()
	} else {
		patch.old_oid.as_deref()
	}
	.ok_or_else(|| Error::PatchFailed {
		message: "3-way patch lacks an index base object".into(),
	})?;
	let base_id = resolve_object(repo, old_oid)?;
	let base = blob_bytes(repo, base_id)?;
	let theirs = apply_file_bytes(patch, &base, reverse).map_err(ApplyFailure::into_error)?;
	let ours = current.map_or_else(|| Ok(Vec::new()), |entry| blob_bytes(repo, entry.id))?;
	if ours == base {
		return Ok(theirs);
	}
	if theirs == base || ours == theirs {
		return Ok(ours);
	}
	let mode = current.map_or(Mode::FILE, |entry| entry.mode);
	let base_blob = repo
		.write_blob(&base)
		.map_err(|err| Error::backend("git apply 3-way base", err))?
		.detach();
	let ours_blob = repo
		.write_blob(&ours)
		.map_err(|err| Error::backend("git apply 3-way ours", err))?
		.detach();
	let theirs_blob = repo
		.write_blob(&theirs)
		.map_err(|err| Error::backend("git apply 3-way theirs", err))?
		.detach();
	let path = patch
		.new_path
		.as_deref()
		.or(patch.old_path.as_deref())
		.unwrap_or("file");
	let base_tree =
		write_tree_map(repo, &BTreeMap::from([(path.to_owned(), FileEntry::new(base_blob, mode))]))?;
	let ours_tree =
		write_tree_map(repo, &BTreeMap::from([(path.to_owned(), FileEntry::new(ours_blob, mode))]))?;
	let theirs_tree = write_tree_map(
		repo,
		&BTreeMap::from([(path.to_owned(), FileEntry::new(theirs_blob, mode))]),
	)?;
	let Some(merged) = merge_tree_maps(repo, base_tree, ours_tree, theirs_tree)? else {
		return Err(Error::Conflict { paths: vec![path.to_owned()] });
	};
	let entry = merged
		.get(path)
		.ok_or_else(|| Error::Conflict { paths: vec![path.to_owned()] })?;
	blob_bytes(repo, entry.id)
}

fn resolve_object(repo: &gix::Repository, spec: &str) -> Result<gix::ObjectId> {
	repo
		.rev_parse_single(spec)
		.map(|id| id.detach())
		.map_err(|err| Error::backend("git apply resolve base", err))
}

fn merge_tree_maps(
	repo: &gix::Repository,
	base: gix::ObjectId,
	ours: gix::ObjectId,
	theirs: gix::ObjectId,
) -> Result<Option<BTreeMap<String, FileEntry>>> {
	let options = repo
		.tree_merge_options()
		.map_err(|err| Error::backend("git merge options", err))?;
	let labels = gix::merge::blob::builtin_driver::text::Labels {
		ancestor: Some("base".into()),
		current:  Some("current".into()),
		other:    Some("stashed".into()),
	};
	let mut outcome = repo
		.merge_trees(base, ours, theirs, labels, options)
		.map_err(|err| Error::backend("git tree merge", err))?;
	if outcome.has_unresolved_conflicts(TreatAsUnresolved::default()) {
		return Ok(None);
	}
	let tree = outcome
		.tree
		.write()
		.map_err(|err| Error::backend("git merge write tree", err))?
		.detach();
	Ok(Some(tree_map(repo, tree)?))
}
fn drop_stash(
	repo: &GitRepo,
	gix_repo: &gix::Repository,
	stash_ref: &gix::Reference<'_>,
	stash_id: gix::ObjectId,
	log: Option<&[u8]>,
) -> Result<()> {
	let Some((previous, prior_log)) = log.and_then(previous_stash_from_log) else {
		return stash_ref
			.delete()
			.map_err(|err| Error::backend("git stash drop", err));
	};
	if previous.is_null() {
		return stash_ref
			.delete()
			.map_err(|err| Error::backend("git stash drop", err));
	}
	update_reference(
		gix_repo,
		"git stash drop",
		"refs/stash",
		previous,
		PreviousValue::MustExistAndMatch(gix::refs::Target::Object(stash_id)),
		"stash: drop",
		false,
	)?;
	let log_path = repo.info().common_dir.join("logs/refs/stash");
	fs::write(log_path, prior_log)?;
	Ok(())
}
fn update_stash_ref(
	repo: &gix::Repository,
	id: gix::ObjectId,
	expected: PreviousValue,
	message: String,
	force_create_reflog: bool,
) -> Result<()> {
	update_reference(
		repo,
		"git stash ref",
		"refs/stash",
		id,
		expected,
		&message,
		force_create_reflog,
	)
}

fn previous_stash_from_log(log: &[u8]) -> Option<(gix::ObjectId, &[u8])> {
	let end = log.iter().rposition(|byte| *byte != b'\n')? + 1;
	let start = log[..end]
		.iter()
		.rposition(|byte| *byte == b'\n')
		.map_or(0, |position| position + 1);
	let old_hex = log.get(start..end)?.split(|byte| *byte == b' ').next()?;
	let previous = gix::ObjectId::from_hex(old_hex).ok()?;
	Some((previous, &log[..start]))
}

fn blob_bytes(repo: &gix::Repository, id: gix::ObjectId) -> Result<Vec<u8>> {
	repo
		.find_blob(id)
		.map(|blob| blob.data.clone())
		.map_err(|err| Error::backend("git read blob", err))
}

fn index_map(repo: &gix::Repository) -> Result<BTreeMap<String, FileEntry>> {
	let index = load_index_or_head(repo, "git read index")?;
	Ok(index_state_map(&index))
}

fn index_map_at(
	repo: &gix::Repository,
	index_path: Option<&Path>,
) -> Result<BTreeMap<String, FileEntry>> {
	Ok(load_index_at(repo, index_path)?.map_or_default(|index| index_state_map(&index)))
}

/// The index at `index_path`, or the repository's when `None`; `None` when an
/// alternate index does not exist yet.
fn load_index_at(
	repo: &gix::Repository,
	index_path: Option<&Path>,
) -> Result<Option<gix::index::File>> {
	let Some(path) = index_path else {
		return load_index_or_head(repo, "git read index").map(Some);
	};
	match fs::metadata(path) {
		Ok(_) => gix::index::File::at(
			path,
			repo.object_hash(),
			false,
			gix::index::decode::Options::default(),
		)
		.map(Some)
		.map_err(|err| Error::backend("git read alternate index", err)),
		Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
		Err(err) => Err(err.into()),
	}
}

fn index_state_map(index: &gix::index::State) -> BTreeMap<String, FileEntry> {
	let mut map = BTreeMap::new();
	for entry in index.entries() {
		if entry.stage() == gix::index::entry::Stage::Unconflicted {
			let path = entry.path(index);
			map.insert(path.to_str_lossy().into_owned(), FileEntry {
				id:            entry.id,
				mode:          entry.mode,
				intent_to_add: entry.flags.contains(Flags::INTENT_TO_ADD),
			});
		}
	}
	map
}

fn tree_map(repo: &gix::Repository, tree: gix::ObjectId) -> Result<BTreeMap<String, FileEntry>> {
	let index = repo
		.index_from_tree(&tree)
		.map_err(|err| Error::backend("git read tree", err))?;
	let mut map = BTreeMap::new();
	for entry in index.entries() {
		let path = entry.path(&index);
		map.insert(path.to_str_lossy().into_owned(), FileEntry::new(entry.id, entry.mode));
	}
	Ok(map)
}

/// The worktree content, in blob form, of the paths `patches` read: each
/// patch's source, or its target when it creates one. Applying needs nothing
/// else, so the rest of the worktree is never read or hashed. Tracked paths
/// take their index mode (there is no executable bit on Windows), others the
/// mode the patch records. A directory at a source path is a gitlink, as git
/// reads it, whether or not the submodule is initialized.
fn patch_worktree_map(
	repo: &GitRepo,
	gix_repo: &gix::Repository,
	filter: &mut WorktreeFilter<'_>,
	patches: &[FilePatch],
	reverse: bool,
) -> Result<BTreeMap<String, FileEntry>> {
	let index = index_map(gix_repo)?;
	let mut state = BTreeMap::new();
	for patch in patches {
		let (source, target, source_mode, target_mode) = patch_sides(patch, reverse);
		let Some(path) = source.or(target) else {
			continue;
		};
		if state.contains_key(path) {
			continue;
		}
		if source == Some(path)
			&& fs::symlink_metadata(repo.root().join(path)).is_ok_and(|metadata| metadata.is_dir())
		{
			// Worktree application never reads the commit (see
			// `apply_patches_to_map`).
			let id = gix::ObjectId::null(gix_repo.object_hash());
			state.insert(path.to_owned(), FileEntry::new(id, Mode::COMMIT));
			continue;
		}
		let mode = index
			.get(path)
			.map(|entry| entry.mode)
			.or(source_mode)
			.or(target_mode)
			.unwrap_or(Mode::FILE);
		if let Some((bytes, mode)) = read_worktree_entry(repo, filter, path, mode)? {
			let id = gix_repo
				.write_blob(bytes)
				.map_err(|err| Error::backend("git hash patch source", err))?
				.detach();
			state.insert(path.to_owned(), FileEntry::new(id, mode));
		}
	}
	Ok(state)
}

/// `git apply` reads worktree files renormalized, except paths whose patch
/// preimage itself carries CRLF line endings: those are read verbatim
/// (`CONV_EOL_KEEP_CRLF`) so the CRLF context still matches.
fn apply_filter<'repo>(
	repo: &'repo gix::Repository,
	patches: &[FilePatch],
	reverse: bool,
) -> Result<WorktreeFilter<'repo>> {
	let mut filter = WorktreeFilter::renormalizing(repo, "git apply")?;
	filter.keep_verbatim(
		patches
			.iter()
			.filter(|patch| crlf_in_preimage(patch, reverse))
			.filter_map(|patch| patch_sides(patch, reverse).0.map(str::to_owned))
			.collect(),
	);
	Ok(filter)
}

/// Mirrors git's `check_old_for_crlf`: a complete preimage line (context, or
/// removed — added when reversed) ending in CRLF.
fn crlf_in_preimage(patch: &FilePatch, reverse: bool) -> bool {
	let removed = if reverse { b'+' } else { b'-' };
	patch.hunks.iter().flat_map(|hunk| &hunk.lines).any(|line| {
		(line.kind == b' ' || line.kind == removed) && !line.no_newline && line.data.ends_with(b"\r")
	})
}

fn tracked_worktree_map(
	repo: &GitRepo,
	gix_repo: &gix::Repository,
	filter: &mut WorktreeFilter<'_>,
	index: &BTreeMap<String, FileEntry>,
) -> Result<BTreeMap<String, FileEntry>> {
	let mut map = BTreeMap::new();
	for (path, entry) in index {
		if let Some((bytes, mode)) = read_worktree_entry(repo, filter, path, entry.mode)? {
			let id = gix_repo
				.write_blob(bytes)
				.map_err(|err| Error::backend("git hash worktree blob", err))?
				.detach();
			map.insert(path.clone(), FileEntry::new(id, mode));
		}
	}
	Ok(map)
}

fn untracked_worktree_map(
	repo: &GitRepo,
	gix_repo: &gix::Repository,
	filter: &mut WorktreeFilter<'_>,
	index: &BTreeMap<String, FileEntry>,
) -> Result<BTreeMap<String, FileEntry>> {
	let mut walk_index = load_index_or_head(gix_repo, "git read index for untracked files")?;
	for entry in walk_index.entries_mut() {
		entry.flags.insert(Flags::UPTODATE);
	}
	let options = gix_repo
		.dirwalk_options()
		.map_err(|err| Error::backend("git untracked options", err))?;
	let walk = gix_repo
		.dirwalk_iter(
			walk_index,
			std::iter::empty::<gix::bstr::BString>(),
			Default::default(),
			options,
		)
		.map_err(|err| Error::backend("git untracked walk", err))?;
	let mut map = BTreeMap::new();
	for item in walk {
		let item = item.map_err(|err| Error::backend("git untracked walk", err))?;
		if item.entry.status != gix::dir::entry::Status::Untracked
			|| !matches!(
				item.entry.disk_kind,
				Some(gix::dir::entry::Kind::File | gix::dir::entry::Kind::Symlink)
			) {
			continue;
		}
		let path = item.entry.rela_path.to_str_lossy().into_owned();
		if index.contains_key(&path) {
			continue;
		}
		if let Some((bytes, mode)) = read_worktree_entry(repo, filter, &path, Mode::FILE)? {
			let id = gix_repo
				.write_blob(bytes)
				.map_err(|err| Error::backend("git hash untracked blob", err))?
				.detach();
			map.insert(path, FileEntry::new(id, mode));
		}
	}
	Ok(map)
}

/// Read the worktree entry at repo-relative `rela_path` in its blob form:
/// symlink targets as-is, regular files through the clean filters.
fn read_worktree_entry(
	repo: &GitRepo,
	filter: &mut WorktreeFilter<'_>,
	rela_path: &str,
	index_mode: Mode,
) -> Result<Option<(Vec<u8>, Mode)>> {
	let path = &repo.root().join(rela_path);
	let metadata = match fs::symlink_metadata(path) {
		Ok(metadata) => metadata,
		Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
		Err(err) => return Err(err.into()),
	};
	if metadata.file_type().is_symlink() {
		let target = fs::read_link(path)?;
		#[cfg(unix)]
		let bytes = {
			use std::os::unix::ffi::OsStrExt;
			target.as_os_str().as_bytes().to_vec()
		};
		#[cfg(not(unix))]
		let bytes = target.to_string_lossy().as_bytes().to_vec();
		return Ok(Some((bytes, Mode::SYMLINK)));
	}
	if !metadata.is_file() {
		return Ok(None);
	}
	let mode = worktree_file_mode(&metadata, index_mode);
	Ok(Some((filter.worktree_to_git(rela_path, fs::read(path)?)?, mode)))
}

#[cfg(unix)]
fn worktree_file_mode(metadata: &fs::Metadata, _index_mode: Mode) -> Mode {
	use std::os::unix::fs::PermissionsExt;
	if metadata.permissions().mode() & 0o111 != 0 {
		Mode::FILE_EXECUTABLE
	} else {
		Mode::FILE
	}
}

#[cfg(not(unix))]
#[allow(clippy::missing_const_for_fn, reason = "matches non-const unix signature")]
fn worktree_file_mode(_metadata: &fs::Metadata, index_mode: Mode) -> Mode {
	index_mode
}

fn write_index_map(repo: &gix::Repository, map: &BTreeMap<String, FileEntry>) -> Result<()> {
	write_index_map_at(repo, map, None)
}

fn write_index_map_at(
	repo: &gix::Repository,
	map: &BTreeMap<String, FileEntry>,
	index_path: Option<&Path>,
) -> Result<()> {
	// Entries the map leaves as they were keep their stat data and flags:
	// zeroed stats make every later status re-hash each tracked file, and
	// sparse checkouts would lose their skip-worktree bits.
	let previous = load_index_at(repo, index_path)?;
	let mut state = gix::index::State::new(repo.object_hash());
	for (path, entry) in map {
		validate_repo_path(path).map_err(ApplyFailure::into_error)?;
		let rela_path = BStr::new(path.as_bytes());
		let unchanged = previous.as_ref().and_then(|index| {
			let old = index
				.entry_by_path_and_stage(rela_path, Stage::Unconflicted)
				.filter(|old| {
					old.id == entry.id
						&& old.mode == entry.mode
						&& old.flags.contains(Flags::INTENT_TO_ADD) == entry.intent_to_add
				})?;
			// A stat as new as the old index is racy: only that index's
			// timestamp makes git re-check the file's content, and the index
			// written here is newer, so the stat is dropped to keep the check
			// (git smudges such entries when it writes an index).
			let stat = if old.stat.is_racy(index.timestamp(), Default::default()) {
				Stat::default()
			} else {
				old.stat
			};
			Some((stat, old.flags))
		});
		let (stat, flags) = match unchanged {
			Some(kept) => kept,
			// INTENT_TO_ADD lives in the extended flag word; losing it here
			// would silently stage promised paths as empty files.
			None if entry.intent_to_add => (Stat::default(), Flags::EXTENDED | Flags::INTENT_TO_ADD),
			None => (Stat::default(), Flags::empty()),
		};
		state.dangerously_push_entry(stat, entry.id, flags, entry.mode, rela_path);
	}
	state.sort_entries();
	let mut index = gix::index::File::from_state(
		state,
		index_path.map_or_else(|| repo.index_path(), Path::to_owned),
	);
	index.remove_tree();
	index
		.write(gix::index::write::Options::default())
		.map_err(|err| Error::backend("git write index", err))
}

fn write_tree_map(
	repo: &gix::Repository,
	map: &BTreeMap<String, FileEntry>,
) -> Result<gix::ObjectId> {
	let empty = repo.empty_tree();
	let mut editor = empty
		.edit()
		.map_err(|err| Error::backend("git edit tree", err))?;
	for (path, entry) in map {
		validate_repo_path(path).map_err(ApplyFailure::into_error)?;
		editor
			.upsert(path.as_str(), entry_kind(entry.mode), entry.id)
			.map_err(|err| Error::backend("git edit tree", err))?;
	}
	editor
		.write()
		.map(|id| id.detach())
		.map_err(|err| Error::backend("git write tree", err))
}

fn entry_kind(mode: Mode) -> EntryKind {
	if mode == Mode::FILE_EXECUTABLE {
		EntryKind::BlobExecutable
	} else if mode == Mode::SYMLINK {
		EntryKind::Link
	} else if mode == Mode::COMMIT {
		EntryKind::Commit
	} else {
		EntryKind::Blob
	}
}

fn write_patch_worktree(
	repo: &GitRepo,
	gix_repo: &gix::Repository,
	filter: &mut WorktreeFilter<'_>,
	patches: &[FilePatch],
	reverse: bool,
	state: &BTreeMap<String, FileEntry>,
) -> Result<()> {
	for patch in patches {
		let (source, target, ..) = patch_sides(patch, reverse);
		if let Some(source) = source
			&& target != Some(source)
		{
			remove_worktree_path(repo, source)?;
		}
		if let Some(target) = target {
			let entry = state.get(target).ok_or_else(|| Error::PatchFailed {
				message: format!("missing applied path {target}"),
			})?;
			if entry.mode == Mode::COMMIT {
				// Like `git apply`, a gitlink only ensures its directory: an added
				// one is created empty, a checked-out submodule is left
				// untouched.
				validate_repo_path(target).map_err(ApplyFailure::into_error)?;
				fs::create_dir_all(repo.root().join(target))?;
			} else {
				write_worktree_entry(repo, gix_repo, filter, target, entry)?;
			}
		}
	}
	Ok(())
}

fn write_worktree_map(
	repo: &GitRepo,
	gix_repo: &gix::Repository,
	filter: &mut WorktreeFilter<'_>,
	previous: &BTreeMap<String, FileEntry>,
	next: &BTreeMap<String, FileEntry>,
) -> Result<()> {
	for path in previous.keys() {
		if !next.contains_key(path) {
			remove_worktree_path(repo, path)?;
		}
	}
	for (path, entry) in next {
		if previous.get(path) != Some(entry) || !repo.root().join(path).exists() {
			write_worktree_entry(repo, gix_repo, filter, path, entry)?;
		}
	}
	Ok(())
}

fn overwrite_error(paths: &BTreeSet<String>) -> Error {
	let list = paths
		.iter()
		.map(String::as_str)
		.collect::<Vec<_>>()
		.join("\n\t");
	Error::backend(
		"git cherry-pick",
		format!(
			"your local changes to the following files would be overwritten by the \
			 cherry-pick:\n\t{list}\nCommit or discard them, then retry."
		),
	)
}

/// Return the picked (`changed`) paths that carry unstaged edits, which the
/// caller merges with the pick. Refuses the pick when a picked path has staged
/// content differing from HEAD, is an untracked file the pick would create, or
/// the index has unmerged entries. Unrelated dirty paths are never inspected,
/// so the rest of the checkout stays as it is. Worktree checks go through gix
/// status, which honors the index stat cache and clean filters (LFS).
fn unstaged_changed_paths(
	repo: &gix::Repository,
	head: &BTreeMap<String, FileEntry>,
	changed: &BTreeSet<String>,
) -> Result<BTreeSet<String>> {
	let index = load_index_or_head(repo, "git cherry-pick index")?;
	if index
		.entries()
		.iter()
		.any(|entry| entry.stage() != gix::index::entry::Stage::Unconflicted)
	{
		return Err(Error::backend("git cherry-pick", "the index has unmerged entries"));
	}
	let staged = index_state_map(&index);
	let mut blocked: BTreeSet<String> = changed
		.iter()
		.filter(|path| staged.get(*path) != head.get(*path))
		.cloned()
		.collect();
	let mut unstaged = BTreeSet::new();
	let patterns: Vec<gix::bstr::BString> = changed
		.iter()
		.filter(|path| !blocked.contains(*path))
		.map(|path| format!(":(literal){path}").into())
		.collect();
	if !patterns.is_empty() {
		let iter = status_with_index(repo, "git cherry-pick status", index)?
			.untracked_files(gix::status::UntrackedFiles::Files)
			.into_iter(patterns)
			.map_err(|err| Error::backend("git cherry-pick status", err))?;
		for item in iter {
			let item = item.map_err(|err| Error::backend("git cherry-pick status", err))?;
			let gix::status::Item::IndexWorktree(change) = item else {
				continue;
			};
			use gix::status::index_worktree;
			let (path, edited) = match change {
				index_worktree::Item::Modification { rela_path, status, .. }
					if !matches!(
						status,
						gix::status::plumbing::index_as_worktree::EntryStatus::NeedsUpdate(_)
					) =>
				{
					(rela_path, true)
				},
				index_worktree::Item::DirectoryContents { entry, .. }
					if entry.status == gix::dir::entry::Status::Untracked =>
				{
					(entry.rela_path, false)
				},
				index_worktree::Item::Rewrite { dirwalk_entry, .. } => (dirwalk_entry.rela_path, false),
				_ => continue,
			};
			let path = path.to_str_lossy().into_owned();
			if !changed.contains(&path) {
				continue;
			}
			if edited {
				unstaged.insert(path);
			} else {
				blocked.insert(path);
			}
		}
	}
	if blocked.is_empty() {
		Ok(unstaged)
	} else {
		Err(overwrite_error(&blocked))
	}
}

/// Materialize `changed` paths into the worktree (from `worktree`) and index
/// (from the committed `merged` tree), keeping every other index entry and its
/// stat cache untouched. `unstaged` paths keep a zeroed stat so their local
/// edits still read as modified.
fn checkout_changed_paths(
	repo: &GitRepo,
	gix_repo: &gix::Repository,
	filter: &mut WorktreeFilter<'_>,
	merged: &BTreeMap<String, FileEntry>,
	worktree: &BTreeMap<String, FileEntry>,
	changed: &BTreeSet<String>,
	unstaged: &BTreeSet<String>,
) -> Result<()> {
	for path in changed {
		// A gitlink changes the index, not the initialized submodule directory.
		match worktree.get(path) {
			Some(entry) if entry.mode == Mode::COMMIT => {},
			Some(entry) => write_worktree_entry(repo, gix_repo, filter, path, entry)?,
			None => remove_worktree_path(repo, path)?,
		}
	}
	let mut index = load_index_or_head(gix_repo, "git cherry-pick index")?;
	index.remove_entries(|_, path, _| changed.contains(path.to_str_lossy().as_ref()));
	for path in changed {
		let Some(entry) = merged.get(path) else {
			continue;
		};
		let stat = if entry.mode == Mode::COMMIT || unstaged.contains(path) {
			Stat::default()
		} else {
			let metadata = gix::index::fs::Metadata::from_path_no_follow(&repo.root().join(path))?;
			Stat::from_fs(&metadata).map_err(|err| Error::backend("git cherry-pick index", err))?
		};
		index.dangerously_push_entry(
			stat,
			entry.id,
			Flags::empty(),
			entry.mode,
			BStr::new(path.as_bytes()),
		);
	}
	index.sort_entries();
	index.remove_tree();
	index
		.write(gix::index::write::Options::default())
		.map_err(|err| Error::backend("git write index", err))
}

/// Materialize `entry` at repo-relative `path`, regular files through the
/// smudge filters as a checkout would.
fn write_worktree_entry(
	repo: &GitRepo,
	gix_repo: &gix::Repository,
	filter: &mut WorktreeFilter<'_>,
	path: &str,
	entry: &FileEntry,
) -> Result<()> {
	validate_repo_path(path).map_err(ApplyFailure::into_error)?;
	let absolute = repo.root().join(path);
	if let Some(parent) = absolute.parent() {
		fs::create_dir_all(parent)?;
	}
	let bytes = blob_bytes(gix_repo, entry.id)?;
	if entry.mode == Mode::SYMLINK {
		let _ = fs::remove_file(&absolute);
		#[cfg(unix)]
		{
			use std::os::unix::{ffi::OsStrExt, fs::symlink};
			symlink(std::ffi::OsStr::from_bytes(&bytes), &absolute)?;
		}
		#[cfg(not(unix))]
		fs::write(&absolute, bytes)?;
		return Ok(());
	}
	fs::write(&absolute, filter.git_to_worktree(path, bytes)?)?;
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		let permissions = fs::Permissions::from_mode(if entry.mode == Mode::FILE_EXECUTABLE {
			0o755
		} else {
			0o644
		});
		fs::set_permissions(&absolute, permissions)?;
	}
	Ok(())
}

/// Remove `path` and the parent directories it leaves empty. A directory at
/// `path` is a gitlink: like git, only an empty (uninitialized) one is
/// removed, a checked-out submodule stays.
fn remove_worktree_path(repo: &GitRepo, path: &str) -> Result<()> {
	validate_repo_path(path).map_err(ApplyFailure::into_error)?;
	let absolute = repo.root().join(path);
	if fs::symlink_metadata(&absolute).is_ok_and(|metadata| metadata.is_dir()) {
		if fs::remove_dir(&absolute).is_err() {
			return Ok(());
		}
	} else {
		match fs::remove_file(&absolute) {
			Ok(()) => {},
			Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
			Err(err) => return Err(err.into()),
		}
	}
	let mut directory = absolute.parent();
	while let Some(current) = directory {
		if current == repo.root() {
			break;
		}
		match fs::remove_dir(current) {
			Ok(()) => directory = current.parent(),
			Err(_) => break,
		}
	}
	Ok(())
}

fn validate_repo_path(path: &str) -> std::result::Result<(), ApplyFailure> {
	let candidate = PathBuf::from(path);
	if candidate.is_absolute()
		|| candidate.components().any(|component| {
			matches!(component, Component::ParentDir | Component::RootDir | Component::Prefix(_))
		})
		|| path.is_empty()
	{
		return Err(ApplyFailure::Invalid(format!("unsafe patch path: {path}")));
	}
	Ok(())
}

