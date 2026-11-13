//! Fuzzy file path discovery for autocomplete and @-mention resolution.
//!
//! Searches for files and directories whose paths match a query string via
//! subsequence scoring. Uses `pi-walker` for directory traversal and caching.

use std::{cmp::Ordering, collections::BinaryHeap, path::Path};

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::task;

/// Options for fuzzy file path search.
#[napi(object)]
pub struct FuzzyFindOptions<'env> {
	/// Fuzzy query to match against file paths (case-insensitive).
	pub query:       String,
	/// Directory to search.
	pub path:        String,
	/// Include hidden files (default: false).
	pub hidden:      Option<bool>,
	/// Respect .gitignore (default: true).
	pub gitignore:   Option<bool>,
	/// Reuse unchanged directory listings across calls (default: false).
	pub cache:       Option<bool>,
	/// Maximum number of matches to return (default: 100).
	pub max_results: Option<u32>,
	/// Abort signal for cancelling the operation.
	pub signal:      Option<Unknown<'env>>,
	/// Timeout in milliseconds for the operation.
	pub timeout_ms:  Option<u32>,
}

/// A single match in fuzzy find results.
#[napi(object)]
pub struct FuzzyFindMatch {
	/// Relative path from the search root (uses `/` separators).
	pub path:         String,
	/// Whether this entry is a directory.
	pub is_directory: bool,
	/// Match quality score (higher is better).
	pub score:        u32,
}

/// Result of fuzzy file path search.
#[napi(object)]
pub struct FuzzyFindResult {
	/// Matched entries (up to `maxResults`).
	pub matches:       Vec<FuzzyFindMatch>,
	/// Total number of matches found (may exceed `matches.len()`).
	pub total_matches: u32,
}

/// Write the subsequence-matching form of `value` (lowercase, without
/// whitespace and path punctuation) into `out`.
fn normalize_fuzzy_into<'a>(out: &'a mut String, value: &str) -> &'a str {
	out.clear();
	out.extend(
		value
			.chars()
			.filter(|ch| !ch.is_whitespace() && !matches!(ch, '/' | '\\' | '.' | '_' | '-'))
			.flat_map(char::to_lowercase),
	);
	out
}

/// Write `value.to_lowercase()` into `out`, allocating only for non-ASCII
/// text, whose context-dependent lowering (final sigma) `str` owns.
fn lowercase_into<'a>(out: &'a mut String, value: &str) -> &'a str {
	out.clear();
	if value.is_ascii() {
		out.push_str(value);
		out.make_ascii_lowercase();
	} else {
		out.push_str(&value.to_lowercase());
	}
	out
}

fn fuzzy_subsequence_score(query_chars: &[char], target: &str) -> u32 {
	if query_chars.is_empty() {
		return 1;
	}
	let mut query_index = 0usize;
	let mut gaps = 0u32;
	let mut last_match_index: Option<usize> = None;
	for (target_index, target_ch) in target.chars().enumerate() {
		if query_index >= query_chars.len() {
			break;
		}
		if query_chars[query_index] == target_ch {
			if let Some(last_index) = last_match_index
				&& target_index > last_index + 1
			{
				gaps = gaps.saturating_add(1);
			}
			last_match_index = Some(target_index);
			query_index += 1;
		}
	}
	if query_index != query_chars.len() {
		return 0;
	}
	let gap_penalty = gaps.saturating_mul(5);
	40u32.saturating_sub(gap_penalty).max(1)
}

/// The query in the forms every path is scored against.
struct FuzzyQuery {
	lower:      String,
	normalized: String,
	chars:      Vec<char>,
	/// A path-style query (contains '/') matches against the full relative
	/// path. Plain queries match by basename only, otherwise '@plan' surfaces
	/// every file whose ancestor directories contain 'plan'.
	has_slash:  bool,
}

impl FuzzyQuery {
	fn new(query: &str) -> Self {
		let lower = query.trim().to_lowercase();
		let mut normalized = String::new();
		normalize_fuzzy_into(&mut normalized, &lower);
		let chars = normalized.chars().collect();
		let has_slash = lower.contains('/');
		Self { lower, normalized, chars, has_slash }
	}
}

/// Buffers reused across scored paths, so scoring allocates only while they
/// grow to the longest path.
#[derive(Default)]
struct ScoreScratch {
	lower:      String,
	normalized: String,
}

fn score_fuzzy_path(
	path: &str,
	is_directory: bool,
	query: &FuzzyQuery,
	scratch: &mut ScoreScratch,
) -> u32 {
	if query.lower.is_empty() {
		return if is_directory { 11 } else { 1 };
	}

	let file_name = Path::new(path)
		.file_name()
		.and_then(|name| name.to_str())
		.unwrap_or(path);
	let lower_file_name = lowercase_into(&mut scratch.lower, file_name);

	let mut score = if lower_file_name == query.lower {
		120
	} else if lower_file_name.starts_with(&query.lower) {
		100
	} else if lower_file_name.contains(&query.lower) {
		80
	} else if !query.has_slash {
		let normalized_file_name = normalize_fuzzy_into(&mut scratch.normalized, file_name);
		let file_name_fuzzy = fuzzy_subsequence_score(&query.chars, normalized_file_name);
		if file_name_fuzzy > 0 {
			50 + file_name_fuzzy
		} else {
			0
		}
	} else if lowercase_into(&mut scratch.lower, path).contains(&query.lower) {
		60
	} else {
		let normalized_file_name = normalize_fuzzy_into(&mut scratch.normalized, file_name);
		let file_name_fuzzy = fuzzy_subsequence_score(&query.chars, normalized_file_name);
		if file_name_fuzzy > 0 {
			50 + file_name_fuzzy
		} else {
			let normalized_path = normalize_fuzzy_into(&mut scratch.normalized, path);
			let path_fuzzy = if normalized_path == query.normalized {
				40
			} else {
				fuzzy_subsequence_score(&query.chars, normalized_path)
			};
			if path_fuzzy > 0 { 30 + path_fuzzy } else { 0 }
		}
	};

	if is_directory && score > 0 {
		score += 10;
	}

	score
}

/// Directory depth of a relative match path (trailing slash ignored).
/// Used as a sort tie-break so equally scored matches surface shallow paths
/// first — `@scripts` should rank cwd-root `scripts/` above
/// `packages/*/scripts/`.
fn path_depth(path: &str) -> usize {
	path.trim_end_matches('/').matches('/').count()
}

/// A scored match carrying its precomputed depth, ordered worst-first.
///
/// The ordering is the exact inverse of the final result comparator (score
/// descending, then `path_depth` ascending, then `path` ascending), so the
/// greatest element of a `BinaryHeap<RankedMatch>` is the candidate that must
/// be evicted first, and `into_sorted_vec` yields the final best-first order.
struct RankedMatch {
	depth: usize,
	entry: FuzzyFindMatch,
}

impl RankedMatch {
	/// How a scored `path` (a directory's without its trailing '/') ranks
	/// against this retained match, under the same ordering as [`Ord`], without
	/// building its result path.
	fn cmp_candidate(&self, path: &str, is_directory: bool, depth: usize, score: u32) -> Ordering {
		self
			.entry
			.score
			.cmp(&score)
			.then_with(|| depth.cmp(&self.depth))
			.then_with(|| {
				path
					.bytes()
					.chain(is_directory.then_some(b'/'))
					.cmp(self.entry.path.bytes())
			})
	}
}

impl Ord for RankedMatch {
	fn cmp(&self, other: &Self) -> Ordering {
		other
			.entry
			.score
			.cmp(&self.entry.score)
			.then_with(|| self.depth.cmp(&other.depth))
			.then_with(|| self.entry.path.cmp(&other.entry.path))
	}
}

impl PartialOrd for RankedMatch {
	fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
		Some(self.cmp(other))
	}
}

impl PartialEq for RankedMatch {
	fn eq(&self, other: &Self) -> bool {
		self.cmp(other) == Ordering::Equal
	}
}

impl Eq for RankedMatch {}

/// Bounded collector retaining at most `capacity` best matches while counting
/// every hit, so `totalMatches` stays exact even when it exceeds `maxResults`.
struct TopMatches {
	capacity: usize,
	total:    u64,
	heap:     BinaryHeap<RankedMatch>,
}

impl TopMatches {
	fn new(capacity: usize) -> Self {
		Self { capacity, total: 0, heap: BinaryHeap::with_capacity(capacity.min(256)) }
	}

	/// Count a hit on `path` (a directory's without its trailing '/'),
	/// building its result only when it is retained.
	fn push(&mut self, path: &str, is_directory: bool, score: u32) {
		self.total = self.total.saturating_add(1);
		if self.capacity == 0 {
			return;
		}
		let depth = path_depth(path);
		if self.heap.len() == self.capacity {
			// The root is the worst retained candidate; replace it only when the
			// new candidate outranks it under the final comparator.
			if self.heap.peek().is_none_or(|worst| {
				worst.cmp_candidate(path, is_directory, depth, score) != Ordering::Less
			}) {
				return;
			}
			self.heap.pop();
		}
		let mut result = String::with_capacity(path.len() + usize::from(is_directory));
		result.push_str(path);
		if is_directory {
			result.push('/');
		}
		self
			.heap
			.push(RankedMatch { depth, entry: FuzzyFindMatch { path: result, is_directory, score } });
	}

	/// Exact number of scoring hits, clamped to the `u32` wire type.
	const fn total_matches(&self) -> u32 {
		crate::utils::clamp_u32(self.total)
	}

	/// Retained matches ordered by score descending, then shallower paths, then
	/// path ascending.
	fn into_sorted_matches(self) -> Vec<FuzzyFindMatch> {
		self
			.heap
			.into_sorted_vec()
			.into_iter()
			.map(|ranked| ranked.entry)
			.collect()
	}
}

struct FuzzyFindConfig {
	query:       String,
	path:        String,
	hidden:      Option<bool>,
	gitignore:   Option<bool>,
	max_results: Option<u32>,
	cache:       Option<bool>,
}

fn score_entries(
	entries: &pi_walker::walk::Collection,
	query: &FuzzyQuery,
	max_results: usize,
	ct: &task::CancelToken,
) -> Result<TopMatches> {
	let mut scored = TopMatches::new(max_results);
	let mut scratch = ScoreScratch::default();
	for entry in entries.iter() {
		ct.heartbeat()?;
		let is_directory = entry.file_type == pi_walker::FileType::Dir;
		let path = entry.path_lossy();
		let score = score_fuzzy_path(&path, is_directory, query, &mut scratch);
		if score > 0 {
			scored.push(&path, is_directory, score);
		}
	}
	Ok(scored)
}

async fn fuzzy_find_async(
	fs: &pi_vfs::Fs,
	config: FuzzyFindConfig,
	ct: task::CancelToken,
) -> Result<FuzzyFindResult> {
	let root = pi_walker::fs::resolve_dir(fs, std::path::Path::new(&config.path))
		.await
		.map_err(task::walk_failure)?;
	let max_results = config.max_results.unwrap_or(100) as usize;
	if max_results == 0 {
		return Ok(FuzzyFindResult { matches: Vec::new(), total_matches: 0 });
	}

	let query = FuzzyQuery::new(&config.query);
	if !query.lower.is_empty() && query.normalized.is_empty() {
		return Ok(FuzzyFindResult { matches: Vec::new(), total_matches: 0 });
	}

	let opts = pi_walker::walk::Options {
		hidden: config.hidden.unwrap_or(false),
		gitignore: config.gitignore.unwrap_or(true),
		skip_git: true,
		skip_node_modules: true,
		follow_links: true,
		cache: config.cache.unwrap_or(false),
		..Default::default()
	};
	let entries =
		pi_walker::walk::collect(&pi_walker::Fs::new(fs, &root), &root, &opts, false, |_, entry| {
			match entry.file_type {
				pi_walker::FileType::File | pi_walker::FileType::Dir => {
					pi_walker::walk::Action::Continue
				},
				pi_walker::FileType::Symlink => pi_walker::walk::Action::Skip,
			}
		})
		.await
		.map_err(task::walk_failure)?;
	let scored = score_entries(&entries, &query, max_results, &ct)?;

	let total_matches = scored.total_matches();
	let matches = scored.into_sorted_matches();
	Ok(FuzzyFindResult { matches, total_matches })
}

/// Fuzzy file path search for autocomplete.
#[napi(js_name = "fuzzyFind")]
pub fn fuzzy_find<'env>(
	env: &'env Env,
	options: FuzzyFindOptions<'_>,
) -> Result<PromiseRaw<'env, FuzzyFindResult>> {
	let FuzzyFindOptions { query, path, hidden, gitignore, cache, max_results, timeout_ms, signal } =
		options;
	let ct = task::CancelToken::new(timeout_ms, signal);
	let config = FuzzyFindConfig { query, path, hidden, gitignore, max_results, cache };
	let cancel = ct.clone();
	task::filesystem_future(env, "fuzzy_find", ct, pi_vfs::Fs::native(), move |fs| async move {
		fuzzy_find_async(&fs, config, cancel).await
	})
}


