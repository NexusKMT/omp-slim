//! Universal offline tokenizer.
//!
//! Exact token counting (and, where meaningful, encoding) for six model
//! families, with all vocabulary data zstd-compressed and embedded in the
//! binary. No network, no files, no external tokenizer runtimes.
//!
//! | [`Encoding`] | family | mechanism |
//! |---|---|---|
//! | `O200kBase` | GPT-4o / o1 / GPT-5+ | byte-level BPE (tiktoken ranks) |
//! | `Cl100kBase` | GPT-3.5 / GPT-4 | byte-level BPE |
//! | `Qwen3` | Qwen 3.5 / 3.6 / 3.8 (248k vocab) | byte-level BPE + NFC |
//! | `DeepSeekV3` | `DeepSeek` V3 … V4 | byte-level BPE, 3-stage split chain |
//! | `KimiK2` | Kimi K2 … K3 | byte-level BPE (tiktoken ranks) |
//! | `Glm5` | GLM-5.x (exact), GLM-4.x (near-exact) | byte-level BPE, `ignore_merges` |
//!
//! Semantics are `encode_ordinary`: plain content, no special tokens, no
//! chat-template frame. This matches budget-estimation use where fragments
//! are summed.
//!
//! Input is encoding-generic ([`Utf`]): `&str`/`String` (UTF-8), `&[u16]`
//! (UTF-16, e.g. a JS string over napi) and `&[u32]` (UTF-32) tokenize
//! natively in their own code units — no UTF-8 transcode, no scratch
//! buffer. The pre-tokenizer scans a codepoint [`Cursor`], and rank tables
//! lazily expand per-flavor lookup views (`bpe.rs`). Valid text yields
//! flavor-invariant ids/counts; malformed units decode permissively as
//! U+FFFD (matching a lossy JS crossing).

mod bpe;
mod pretoken;
mod scan;
mod tables;
mod utf;
pub use self::{
	bpe::RankTable,
	utf::{Cursor, Unit, Utf},
};

/// A tokenizer family. Copy-cheap; all state is in lazily-initialized
/// process-wide tables (first use pays one zstd decode of ~0.5–1 MB).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Encoding {
	/// GPT-4o / o1 / GPT-5 (`OpenAI` default).
	O200kBase,
	/// GPT-3.5 / GPT-4 / older `OpenAI`.
	Cl100kBase,

	/// Qwen 3.5 / 3.6 / 3.8 (248,044-token vocabulary, NFC input).
	Qwen3,
	/// `DeepSeek` V3 / V3.1 / V3.2 / R1 / V4 (identical base BPE).
	DeepSeekV3,
	/// Kimi K2 / K2.5 / K3 (163,584-token base vocabulary).
	KimiK2,
	/// GLM-5 (154,820-token vocabulary; ID-preserving superset of GLM-4.x).
	Glm5,
}

impl Encoding {
	/// Exact content token count of `text` (no specials, no message frame),
	/// in any UTF flavor.
	pub fn count<T: Utf + ?Sized>(self, text: &T) -> u32 {
		tables::bpe_for(self).count(text.units())
	}

	/// Token ids for ordinary content, in any UTF flavor.
	pub fn encode<T: Utf + ?Sized>(self, text: &T) -> Vec<u32> {
		tables::bpe_for(self).encode(text.units())
	}
}

#[cfg(test)]
#[path = "tests"]
mod tests {
	#[path = "deepseek.rs"]
	mod deepseek;
	#[path = "glm.rs"]
	mod glm;
	#[path = "kimi.rs"]
	mod kimi;
	#[path = "openai.rs"]
	mod openai;
	#[path = "qwen.rs"]
	mod qwen;
	#[path = "rank_table.rs"]
	mod rank_table;
}
