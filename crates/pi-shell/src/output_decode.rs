//! Decode child-process stdout/stderr into Unicode.
//!
//! Modern tools emit UTF-8 (Python with `PYTHONUTF8`, Node, Rust), and that is
//! the only encoding this build decodes: invalid sequences become U+FFFD, and
//! a sequence still incomplete at the end of a read is held for the next one.
//! Pipeline pipes and files are never decoded: binary data stays intact.

use std::{str, sync::Arc};

use crate::sys::{ByteDecoder, OutputDecoding};

const REPLACEMENT: &str = "\u{FFFD}";

/// Incremental decoder for one stdout/stderr stream.
pub struct OutputDecoder {
	pending: Vec<u8>,
}

impl Default for OutputDecoder {
	fn default() -> Self {
		Self::new()
	}
}

impl OutputDecoder {
	/// Decode as UTF-8, with invalid sequences as U+FFFD.
	pub const fn new() -> Self {
		Self { pending: Vec::new() }
	}

	/// Push the next pipe read. Returns text that is safe to emit now;
	/// an incomplete UTF-8 sequence stays buffered.
	pub fn push(&mut self, bytes: &[u8]) -> String {
		if bytes.is_empty() {
			return String::new();
		}
		// Common case: nothing held back and the read is valid UTF-8.
		if self.pending.is_empty()
			&& let Ok(text) = str::from_utf8(bytes)
		{
			return text.to_owned();
		}
		self.pending.extend_from_slice(bytes);
		self.drain(false)
	}

	/// Flush held bytes at EOF.
	pub fn finish(&mut self) -> String {
		self.drain(true)
	}

	/// Decodes `pending` with a cursor and compacts it once at the end, so a
	/// buffer with many invalid sequences costs linear time.
	fn drain(&mut self, eof: bool) -> String {
		let mut out = String::with_capacity(self.pending.len());
		let mut start = 0;
		while start < self.pending.len() {
			let err = match str::from_utf8(&self.pending[start..]) {
				Ok(text) => {
					out.push_str(text);
					start = self.pending.len();
					break;
				},
				Err(err) => err,
			};
			let valid_end = start + err.valid_up_to();
			// SAFETY: [start..valid_end] is valid UTF-8 by valid_up_to().
			out.push_str(unsafe { str::from_utf8_unchecked(&self.pending[start..valid_end]) });
			start = valid_end;
			if let Some(invalid_len) = err.error_len() {
				out.push_str(REPLACEMENT);
				start += invalid_len;
				continue;
			}
			// An incomplete sequence ends the buffer: hold it for the next
			// read, or resolve it at EOF.
			if eof {
				out.push_str(REPLACEMENT);
				start = self.pending.len();
			}
			break;
		}
		self.pending.drain(..start);
		out
	}
}

/// No host fallback exists: every external program's output is UTF-8.
pub fn external_output_decoding() -> Option<Arc<dyn OutputDecoding>> {
	None
}

impl ByteDecoder for OutputDecoder {
	fn push(&mut self, bytes: &[u8]) -> String {
		Self::push(self, bytes)
	}

	fn holds_bytes(&self) -> bool {
		!self.pending.is_empty()
	}

	fn finish(&mut self) -> String {
		Self::finish(self)
	}
}

/// Decodes the shell's capture pipe.
///
/// External programs reach the capture already decoded by their relays, so
/// bytes that are not UTF-8 there came through a builtin: `printf '\xeb'`,
/// `cut` through a character, or `cat` of a legacy file. Those become U+FFFD.
pub struct CaptureDecoder {
	decoder: OutputDecoder,
}

impl Default for CaptureDecoder {
	fn default() -> Self {
		Self::new()
	}
}

impl CaptureDecoder {
	pub const fn new() -> Self {
		Self { decoder: OutputDecoder::new() }
	}

	/// Push the next pipe read. Returns text that is safe to emit now.
	pub fn push(&mut self, bytes: &[u8]) -> String {
		self.decoder.push(bytes)
	}

	/// Never holds a partial line back.
	pub const fn holds_line(&self) -> bool {
		false
	}

	/// Nothing held back, so nothing to judge early.
	pub const fn flush_line(&mut self) -> String {
		String::new()
	}

	/// Flush held bytes at EOF.
	pub fn finish(&mut self) -> String {
		self.decoder.finish()
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn utf8_passthrough() {
		let mut decoder = OutputDecoder::new();
		assert_eq!(decoder.push("hello 中文\n".as_bytes()), "hello 中文\n");
		assert_eq!(decoder.finish(), "");
	}

	#[test]
	fn incomplete_utf8_is_held_then_flushed() {
		let mut decoder = OutputDecoder::new();
		// First byte of UTF-8 中 (E4 B8 AD).
		assert_eq!(decoder.push(&[0xe4]), "");
		assert_eq!(decoder.push(&[0xb8, 0xad]), "中");
		assert_eq!(decoder.finish(), "");
	}

	#[test]
	fn incomplete_utf8_at_eof_becomes_replacement() {
		let mut decoder = OutputDecoder::new();
		assert_eq!(decoder.push(&[0xe4]), "");
		assert_eq!(decoder.finish(), "\u{FFFD}");
	}

	#[test]
	fn invalid_utf8_becomes_replacement() {
		let mut decoder = OutputDecoder::new();
		assert_eq!(decoder.push(&[0xff]), "\u{FFFD}");
		assert_eq!(decoder.finish(), "");
	}

	#[test]
	fn invalid_sequences_between_text_keep_order_and_hold_the_tail() {
		let mut decoder = OutputDecoder::new();
		// Binary-ish output: invalid bytes between text, then the first byte of
		// a three-byte character that the next read completes.
		let mut bytes = Vec::new();
		for _ in 0..1000 {
			bytes.extend_from_slice(&[0xff, b'a', 0xc0, 0x80, b'b']);
		}
		bytes.push(0xe4);
		let decoded = decoder.push(&bytes);
		assert_eq!(decoded, "\u{FFFD}a\u{FFFD}\u{FFFD}b".repeat(1000));
		assert_eq!(decoder.push(&[0xb8, 0xad, b'\n']), "中\n");
		assert_eq!(decoder.finish(), "");
	}
}
