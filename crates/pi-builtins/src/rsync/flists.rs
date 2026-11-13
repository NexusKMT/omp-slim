//! The file-list registry shared by the sender, generator, and receiver threads.
//!
//! Every published list is a *segment*: the whole list without incremental recursion, or
//! the initial list plus one segment per announced directory with it. Entries are
//! addressed by their global index (`segment.ndx_start + position`, positions in sorted
//! order). Between two consecutive segments there is one unused index
//! (`ndx_start - 1` of the later segment); [`Flists::entry`] and [`Flists::update`]
//! resolve that gap index to the segment's parent directory, matching how upstream
//! addresses `dir_flist->files[parent_ndx]`.
//!
//! [`FileList::parent_ndx`] holds the GLOBAL index of the directory whose contents the
//! segment carries (-1 for none); the registry also keeps upstream's `dir_flist`
//! ordering (all directory entries, segment by segment in sorted order, including
//! directories later cleared as duplicates) so the wire's `NDX_FLIST_OFFSET - dir_ndx`
//! values map to entries via [`Flists::dir_ndx`].
//!
//! [`Flists::release`] frees a finished segment's non-directory entries (upstream
//! `flist_free`); directory entries stay readable because upstream allocates them in the
//! long-lived `dir_flist` pool. Indices of a released segment stay valid.
//!
//! Lock order: [`Flists::hlinks`] before the registry state (the receiver's hard-link
//! matcher updates earlier segments while holding it). Closures passed to
//! `with_segment*`/`update` run under the state lock and must not call back into
//! `Flists` or lock `hlinks`.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use crate::rsync::flist::{FileEntry, FileList};
use crate::rsync::hlink::HlinkMatcher;

/// Locks `mutex`, recovering the guard if a previous holder panicked (every
/// engine thread's shared state: registries, counters, caches, log sinks).
pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
	mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// One published list.
struct Segment {
	/// The live list; after release only its metadata remains here.
	list: FileList,
	/// Number of entries the segment had when published.
	len: usize,
	released: bool,
	/// Directory entries kept after release, by position.
	kept_dirs: Vec<(usize, FileEntry)>,
	/// `--iconv`: transmission position → sorted position, and its inverse.
	wire_order: Option<(Vec<u32>, Vec<u32>)>,
}

impl Segment {
	fn get(&self, pos: usize) -> Option<&FileEntry> {
		if self.released {
			let i = self.kept_dirs.binary_search_by_key(&pos, |(p, _)| *p).ok()?;
			Some(&self.kept_dirs[i].1)
		} else {
			self.list.entries.get(pos)
		}
	}

	fn get_mut(&mut self, pos: usize) -> Option<&mut FileEntry> {
		if self.released {
			let i = self.kept_dirs.binary_search_by_key(&pos, |(p, _)| *p).ok()?;
			Some(&mut self.kept_dirs[i].1)
		} else {
			self.list.entries.get_mut(pos)
		}
	}
}

#[derive(Default)]
struct State {
	segments: Vec<Segment>,
	/// upstream dir_flist: global indices of directory entries.
	dirs: Vec<i32>,
	eof: bool,
}

impl State {
	/// Segment holding global index `ndx` as a real entry (not a gap index).
	fn locate(&self, ndx: i32) -> Option<(usize, usize)> {
		// Segments are published with increasing ndx_start.
		let seg = self.segments.partition_point(|s| s.list.ndx_start <= ndx).checked_sub(1)?;
		let s = &self.segments[seg];
		let pos = usize::try_from(ndx - s.list.ndx_start).ok()?;
		(pos < s.len).then_some((seg, pos))
	}

	/// `ndx` as an entry, or a gap index resolved to the following segment's parent dir.
	fn resolve(&self, ndx: i32) -> Option<(usize, usize)> {
		if let Some(found) = self.locate(ndx) {
			return Some(found);
		}
		let next = self.segments.iter().find(|s| s.list.ndx_start.checked_sub(1) == Some(ndx))?;
		let parent = next.list.parent_ndx;
		if parent < 0 || parent == ndx {
			return None;
		}
		self.locate(parent)
	}
}

/// The file-list registry shared by sender/generator/receiver threads.
pub(crate) struct Flists {
	state: Mutex<State>,
	hlinks: Mutex<HlinkMatcher>,
}

impl Flists {
	pub(crate) fn new() -> Arc<Self> {
		Arc::new(Self {
			state: Mutex::new(State::default()),
			hlinks: Mutex::new(HlinkMatcher::new()),
		})
	}

	fn lock(&self) -> MutexGuard<'_, State> {
		lock(&self.state)
	}

	

	/// Publishes a segment (initial list or one inc-recursion directory list) and returns
	/// its index. `dirs` is its dir_flist contribution (global indices, in dir_flist order;
	/// directories later cleared as duplicates keep their slot, as upstream's do). Under
	/// `--iconv` (upstream `need_unsorted_flist`) `wire_order[t]` is the sorted position of
	/// the entry that travelled `t`-th: the peer then addresses entries by transmission
	/// position (see [`Flists::to_wire`]). An order of the wrong length is ignored.
	pub(crate) fn push_full(&self, list: FileList, dirs: Vec<i32>, wire_order: Option<Vec<u32>>) -> usize {
		let mut st = self.lock();
		let len = list.entries.len();
		let wire_order = wire_order.filter(|o| o.len() == len).map(|order| {
			let mut inverse = vec![0u32; len];
			for (t, &pos) in order.iter().enumerate() {
				if let Some(slot) = inverse.get_mut(pos as usize) {
					*slot = t as u32;
				}
			}
			(order, inverse)
		});
		st.segments.push(Segment { list, len, released: false, kept_dirs: Vec::new(), wire_order });
		st.dirs.extend(dirs);
		st.segments.len() - 1
	}

	/// No more segments (NDX_FLIST_EOF / non-inc). Other threads learn of new segments
	/// through their own channels (the generator: its receiver pipe), never by polling
	/// the registry.
	pub(crate) fn set_eof(&self) {
		self.lock().eof = true;
	}

	/// The entry index `ndx` stands for: itself when it is an entry, the segment's parent
	/// directory for a gap index (`ndx_start - 1`), None otherwise.
	pub(crate) fn resolve_ndx(&self, ndx: i32) -> Option<i32> {
		let st = self.lock();
		let (seg, pos) = st.resolve(ndx)?;
		Some(st.segments[seg].list.ndx_start + pos as i32)
	}

	pub(crate) fn is_eof(&self) -> bool {
		self.lock().eof
	}

	/// Segments published so far.
	pub(crate) fn len(&self) -> usize {
		self.lock().segments.len()
	}

	/// Global ndx → clone (a gap index `ndx_start - 1` yields that segment's parent dir).
	pub(crate) fn entry(&self, ndx: i32) -> Option<FileEntry> {
		let st = self.lock();
		let (seg, pos) = st.resolve(ndx)?;
		st.segments[seg].get(pos).cloned()
	}

	/// Mutates the entry at `ndx` (gap indices as in [`Flists::entry`]); false when absent
	/// or freed.
	pub(crate) fn update(&self, ndx: i32, f: impl FnOnce(&mut FileEntry)) -> bool {
		let mut st = self.lock();
		let Some((seg, pos)) = st.resolve(ndx) else {
			return false;
		};
		match st.segments[seg].get_mut(pos) {
			Some(e) => {
				f(e);
				true
			},
			None => false,
		}
	}

	/// The index the peer uses for local entry `ndx` (identity unless `--iconv`
	/// reordered the segment; gap and negative indices pass through).
	pub(crate) fn to_wire(&self, ndx: i32) -> i32 {
		let st = self.lock();
		match st.locate(ndx) {
			Some((seg, pos)) => match &st.segments[seg].wire_order {
				Some((_, inverse)) => st.segments[seg].list.ndx_start + inverse[pos] as i32,
				None => ndx,
			},
			None => ndx,
		}
	}

	/// The local index of the peer's index `wire_ndx` (inverse of [`Flists::to_wire`]).
	pub(crate) fn from_wire(&self, wire_ndx: i32) -> i32 {
		let st = self.lock();
		match st.locate(wire_ndx) {
			Some((seg, t)) => match &st.segments[seg].wire_order {
				Some((order, _)) => st.segments[seg].list.ndx_start + order[t] as i32,
				None => wire_ndx,
			},
			None => wire_ndx,
		}
	}

	/// The segment holding entry `ndx` (gap indices are not entries).
	pub(crate) fn segment_of(&self, ndx: i32) -> Option<usize> {
		self.lock().locate(ndx).map(|(seg, _)| seg)
	}

	/// Runs `f` on a live segment; None when unknown or released.
	pub(crate) fn with_segment<T>(&self, seg: usize, f: impl FnOnce(&FileList) -> T) -> Option<T> {
		let st = self.lock();
		let s = st.segments.get(seg)?;
		(!s.released).then(|| f(&s.list))
	}

	/// Frees a finished segment's entries (upstream flist_free), keeping indices valid.
	/// Directory entries survive (upstream keeps them in the dir_flist pool).
	pub(crate) fn release(&self, seg: usize) {
		let mut st = self.lock();
		let Some(s) = st.segments.get_mut(seg) else {
			return;
		};
		if s.released {
			return;
		}
		let entries = std::mem::take(&mut s.list.entries);
		s.kept_dirs = entries.into_iter().enumerate().filter(|(_, e)| e.is_dir()).collect();
		s.kept_dirs.shrink_to_fit();
		s.released = true;
	}

	/// Whether `seg` was released (unknown segments count as not released).
	pub(crate) fn is_released(&self, seg: usize) -> bool {
		self.lock().segments.get(seg).is_some_and(|s| s.released)
	}

	/// Entries the segment had when published.
	pub(crate) fn segment_len(&self, seg: usize) -> Option<usize> {
		self.lock().segments.get(seg).map(|s| s.len)
	}

	/// Global index of the segment's first entry.
	pub(crate) fn segment_start(&self, seg: usize) -> Option<i32> {
		self.lock().segments.get(seg).map(|s| s.list.ndx_start)
	}

	/// The segment's parent directory (global index, -1 none).
	pub(crate) fn segment_parent(&self, seg: usize) -> Option<i32> {
		self.lock().segments.get(seg).map(|s| s.list.parent_ndx)
	}

	/// Entries in unreleased segments (upstream `file_total`).
	pub(crate) fn file_total(&self) -> usize {
		self.lock().segments.iter().filter(|s| !s.released).map(|s| s.len).sum()
	}

	/// Index the next pushed segment's first entry gets (upstream flist_new rule).
	pub(crate) fn next_ndx_start(&self, inc_recurse: bool) -> i32 {
		let st = self.lock();
		match st.segments.last() {
			None => i32::from(inc_recurse),
			Some(s) => s.list.ndx_start + s.len as i32 + 1,
		}
	}

	/// Total entries in the last published segment's range end: the highest valid global
	/// index (−1 when nothing was published).
	pub(crate) fn last_ndx(&self) -> i32 {
		let st = self.lock();
		st.segments.last().map_or(-1, |s| s.list.ndx_start + s.len as i32 - 1)
	}

	/// Number of dir_flist entries.
	pub(crate) fn dir_count(&self) -> usize {
		self.lock().dirs.len()
	}

	/// dir_flist index → global ndx of that directory entry.
	pub(crate) fn dir_ndx(&self, dir_idx: usize) -> Option<i32> {
		self.lock().dirs.get(dir_idx).copied()
	}

	/// dir_flist index → clone of the directory entry.
	pub(crate) fn dir_entry(&self, dir_idx: usize) -> Option<FileEntry> {
		let st = self.lock();
		let ndx = *st.dirs.get(dir_idx)?;
		let (seg, pos) = st.locate(ndx)?;
		st.segments[seg].get(pos).cloned()
	}

	/// The segment whose parent directory is `dir_global_ndx`.
	pub(crate) fn segment_for_dir(&self, dir_global_ndx: i32) -> Option<usize> {
		if dir_global_ndx < 0 {
			return None;
		}
		self.lock().segments.iter().position(|s| s.list.parent_ndx == dir_global_ndx)
	}

	/// The receiver-side hard-link matcher shared across segments (lock before any other
	/// `Flists` call that may be nested inside it — see the module docs).
	pub(crate) fn hlinks(&self) -> &Mutex<HlinkMatcher> {
		&self.hlinks
	}
}


