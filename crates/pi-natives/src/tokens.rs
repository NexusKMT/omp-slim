//! Token counting via tiktoken-rs and the ctok Claude reconstruction.
//!
//! Encodings:
//!
//!   - `O200kBase` — GPT-4o / o1 / GPT-5 (the modern `OpenAI` default).
//!   - `Cl100kBase` — GPT-3.5 / GPT-4 / older models.
//!   - `ClaudeV3` / `ClaudeV47` / `ClaudeV5` — offline reconstructions of
//!     Anthropic's `count_tokens` (see [`crate::ctok`]): v3 serves Claude 3
//!     through Opus 4.6, v4.7 serves Opus 4.7–4.9, v5 serves the 5-series.
//!
//! `o200k_base` is the default. For Claude models the ctok encodings count
//! exactly (message content, excluding the fixed per-message frame), so they
//! are the right choice wherever the model is known to be Claude.
//!
//! BPE tables and the ctok vocabularies are embedded in the binary; encoders
//! are built once on first use and reused thereafter.

use std::sync::LazyLock;

use napi::bindgen_prelude::Either;
use napi_derive::napi;
use pi_shell::rayon_global_pool_available;
use rayon::prelude::*;
use tiktoken_rs::{CoreBPE, cl100k_base, o200k_base};

use crate::ctok;

/// Tokenizer encoding to use.
#[napi(string_enum)]
pub enum Encoding {
	/// GPT-4o / o1 / GPT-5 (default).
	O200kBase,
	/// GPT-3.5 / GPT-4 / older.
	Cl100kBase,
	/// Claude 3 … Opus 4.6 (ctok v3 reconstruction).
	ClaudeV3,
	/// Claude Opus 4.7–4.9 (ctok v4.7 reconstruction).
	ClaudeV47,
	/// Claude Opus 5+ (ctok v5 reconstruction).
	ClaudeV5,
	/// Claude Sonnet/Fable 5+ (live-measured non-opus v5 frame).
	ClaudeV5Sonnet,
}

static O200K: LazyLock<CoreBPE> =
	LazyLock::new(|| o200k_base().expect("failed to initialize o200k_base BPE tables"));

static CL100K: LazyLock<CoreBPE> =
	LazyLock::new(|| cl100k_base().expect("failed to initialize cl100k_base BPE tables"));

/// A resolved counting backend: a BPE encoder or a ctok family.
enum Counter {
	Bpe(&'static CoreBPE),
	Claude(ctok::Family),
}

impl Counter {
	fn resolve(encoding: Option<Encoding>) -> Self {
		match encoding.unwrap_or(Encoding::O200kBase) {
			Encoding::O200kBase => Self::Bpe(&O200K),
			Encoding::Cl100kBase => Self::Bpe(&CL100K),
			Encoding::ClaudeV3 => Self::Claude(ctok::Family::V3),
			Encoding::ClaudeV47 => Self::Claude(ctok::Family::V47),
			Encoding::ClaudeV5 => Self::Claude(ctok::Family::V5),
			Encoding::ClaudeV5Sonnet => Self::Claude(ctok::Family::V5Sonnet),
		}
	}

	fn count(&self, text: &str) -> u32 {
		match self {
			Self::Bpe(bpe) => bpe.encode_ordinary(text).len() as u32,
			Self::Claude(family) => ctok::content_token_count(text, *family),
		}
	}
}

/// Count tokens in `input`.
///
/// `input` may be a single string or an array of strings; an array returns
/// the sum across all elements (encoded in parallel via rayon when the global
/// pool is available). Always returns a single token total — use this for any
/// aggregate budget question without paying a per-element napi crossing.
///
/// Measures user/model content, not wire-protocol tokens: BPE encodings use
/// ordinary encoding (no special-token handling) and the Claude encodings
/// count message content without the fixed per-message frame. Defaults to
/// `o200k_base`; pass a `Claude*` encoding for exact Claude counts.
#[napi]
pub fn count_tokens(input: Either<String, Vec<String>>, encoding: Option<Encoding>) -> u32 {
	let counter = Counter::resolve(encoding);
	match input {
		Either::A(text) => counter.count(&text),
		Either::B(texts) if rayon_global_pool_available() => {
			texts.par_iter().map(|s| counter.count(s)).sum()
		},
		Either::B(texts) => texts.iter().map(|s| counter.count(s)).sum(),
	}
}
