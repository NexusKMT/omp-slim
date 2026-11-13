//! The page arithmetic of the heap-sync `sbrk` (`wasi_heap_sync::__wrap_sbrk`): pure functions,
//! so they also build natively, where the unit tests below run. The design is in
//! `wasi_heap_sync`'s "The break".

/// When the break must pass the current memory, grow at least this much in one `memory.grow`,
/// so the heap grows in a few large steps instead of 64 KiB-2 MiB ones. Every growth costs one
/// refresh on every thread, and V8 changes the page permissions of the whole memory on each
/// grow. 16 MiB is a small share of the 4 GiB maximum.
pub(crate) const GROW_AHEAD: usize = 16 << 20;

/// Wasm page size in bytes, for address math in `usize` (32 bits on wasm32).
pub(crate) const PAGE_BYTES: usize = 1 << 16;

/// The break never passes this page, 2^31 in bytes; see `wasi_heap_sync`'s "The break".
pub(crate) const HEAP_LIMIT_PAGES: usize = 1 << 15;

/// Pages needed to cover every byte below `addr`.
#[inline]
pub(crate) const fn pages_below(addr: usize) -> usize {
  addr.div_ceil(PAGE_BYTES)
}

/// The new break when `increment` bytes fit below `own_end` (the reserve's end, or the end of
/// the last region `sbrk` grew itself): no growth. `None` when the memory must grow.
#[inline]
pub(crate) fn fits(brk: usize, own_end: usize, increment: usize) -> Option<usize> {
  brk.checked_add(increment).filter(|&end| end <= own_end)
}

/// The pages `sbrk` grows for a request that does not [`fit`](fits).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Grow {
  /// The fewest pages that hold the request.
  pub need: usize,
  /// The pages tried first: `need` raised to [`GROW_AHEAD`], capped at [`HEAP_LIMIT_PAGES`].
  pub ahead: usize,
}

/// How much `sbrk` grows when `increment` bytes do not fit below `own_end`, with the memory at
/// `now` pages. `None` when the request cannot fit below 2^31: `sbrk` then fails without growing.
///
/// - `own_end` is the current memory end (nobody else grew the memory since `sbrk` last moved
///   `own_end`): the new pages extend `[brk, own_end)`, so only the part of the new break past
///   the memory end is grown, `pages_below(brk + increment) - now`. The reserve, or what is left
///   of the last grown region, is used before any page is grown.
/// - Otherwise another allocator grew the pages after `own_end`. `sbrk` returns one contiguous
///   block, and `[brk, own_end)` does not touch the new pages, so the block starts a new segment
///   at the memory end and the whole increment must be grown: `pages_below(increment)`.
pub(crate) fn grow_plan(brk: usize, own_end: usize, increment: usize, now: usize) -> Option<Grow> {
  // `checked_mul`: at 65536 pages the byte size is 2^32, past `usize` on wasm32.
  let need = if now.checked_mul(PAGE_BYTES) == Some(own_end) {
    pages_below(brk.checked_add(increment)?).checked_sub(now)?
  } else {
    pages_below(increment)
  };
  // Pages that can still be added below 2^31. A request that cannot fit fails before it grows.
  // `need == 0` only for a request that [`fits`], which the caller handles first.
  let room = HEAP_LIMIT_PAGES.saturating_sub(now);
  if need == 0 || need > room {
    return None;
  }
  Some(Grow {
    need,
    ahead: need.max(GROW_AHEAD / PAGE_BYTES).min(room),
  })
}


