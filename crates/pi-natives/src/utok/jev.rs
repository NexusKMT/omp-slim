//! Offline reconstruction of `TypeSafe` Jev's input-token counts (`jev-1.13`).
//!
//! Jev reports only `usage.input_tokens`, so this model was recovered from
//! counts alone: ~639k probes against the live System One API, split into a
//! vocabulary by difference measurements inside neutral padding, then fitted
//! until every recorded count matched (see `data/README.md`). Like the
//! Claude families it reconstructs counts, not token ids.
//!
//! Pipeline for one `state` string:
//!
//! 1. NFC-normalize, then split with Qwen3.5's pre-tokenizer (single digits,
//!    contractions split off, combining marks glued to letters): the same
//!    [`Splitter::Qwen`] scanner and `nfc` flag as [`Encoding::Qwen3`].
//! 2. A piece that is a whole-word entry costs 1. The whole-word vocabulary is
//!    (almost exactly) the o200k tokens that are also Qwen3.5 tokens, plus
//!    every base token.
//! 3. Any other piece is cut into [`WINDOW`]-byte windows, and each window runs
//!    tiktoken's byte-pair merge with o200k ranks, restricted to a ~54k-token
//!    base subset of o200k. Whole-piece hits in the base table are *not*
//!    short-circuited ([`RankTable::count_merged_in`]): `token` is a whole word
//!    but not a base token, so `tokenize` costs 3.
//!
//! Both sets are o200k subsets, so they are stored as rank bitsets over the
//! shared o200k table rather than as two more rank tables.
//!
//! Counts are state *content*: the request frame (question text, template,
//! 269 tokens for a minimal one-noul request) is excluded, matching the
//! other families' "no chat-template frame" semantics.
//!
//! [`Encoding::Qwen3`]: crate::utok::Encoding::Qwen3

use std::sync::LazyLock;

use crate::utok::{
	Encoding,
	bpe::{self, RankTable},
	pretoken::Splitter,
	tables,
	utf::Unit,
};

/// Longest byte span one merge run covers: longer pieces are merged in
/// independent windows (measured: a random consonant run matches unwindowed
/// merging through 513 bytes and diverges at 514, and a Lao word gains a token
/// once it crosses byte 512 mid-character).
const WINDOW: usize = 512;

/// Bytes per rank bitset: one bit per o200k rank (199,998 ranks).
const SET_BYTES: usize = 25_000;

struct Jev {
	o200k: &'static RankTable,
	/// Base set bits, then whole-word set bits; rank `r` is bit `r & 7` of
	/// byte `r >> 3` within its set.
	sets:  Box<[u8]>,
}

static JEV: LazyLock<Jev> = LazyLock::new(|| {
	let sets = zstd::decode_all(&include_bytes!("../../data/jev_sets.bin.zst")[..])
		.expect("utoken: zstd decode failed");
	assert_eq!(sets.len(), 2 * SET_BYTES, "utoken: bad jev set blob");
	Jev { o200k: &tables::bpe_for(Encoding::O200kBase).table, sets: sets.into_boxed_slice() }
});

impl Jev {
	#[inline]
	fn member(&self, set: usize, rank: u32) -> bool {
		let r = rank as usize;
		self.sets[set * SET_BYTES + (r >> 3)] >> (r & 7) & 1 != 0
	}
}

/// Jev input-token count of `units` (any UTF flavor) as state content,
/// excluding the request frame. Valid text counts flavor-invariantly.
pub fn content_token_count<U: Unit>(units: &[U]) -> u32 {
	const BASE: usize = 0;
	const WHOLE: usize = 1;
	let jev = &*JEV;
	let mut n = 0u32;
	bpe::for_each_piece(&Splitter::Qwen, true, units, &mut |piece| {
		n += if jev.o200k.rank(piece).is_some_and(|r| jev.member(WHOLE, r)) {
			1
		} else {
			piece
				.chunks(WINDOW)
				.map(|w| jev.o200k.count_merged_in(w, |r| jev.member(BASE, r)))
				.sum()
		};
	});
	n
}
