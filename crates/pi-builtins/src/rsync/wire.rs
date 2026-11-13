//! Integer, string, and file-index codecs of the rsync wire protocol.
//!
//! Every multi-byte integer is little-endian. Besides the fixed-width forms
//! (`shortint`, `int`, `longint`) protocol 30 introduced variable-length
//! integers whose first byte announces, through its count of leading one bits,
//! how many further bytes follow; the remaining low bits of that first byte
//! carry the most significant part of the value.

use std::fmt;
use std::io::{self, Read, Write};

use crate::rsync::consts::NDX_DONE;
use crate::rsync::exit::{RERR_PROTOCOL, RERR_STREAMIO};
use crate::rsync::log::Role;

/// Negotiated protocol facts every codec consults.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Proto {
	pub version: u32,
	pub compat: u32,
}

impl Proto {
	

	/// Whether the negotiated compatibility flags include `cf`.
	pub(crate) const fn has(self, cf: u32) -> bool {
		self.compat & cf != 0
	}
}

/// The diagnostic attached (as the inner error) to every io::Error raised by
/// the wire layers: upstream's exact message (no trailing newline), the exit
/// code it ends the run with, and the upstream exit site for the trailer.
#[derive(Debug)]
pub(crate) struct WireError {
	pub code: i32,
	pub message: String,
	pub site: Option<(&'static str, u32)>,
}

impl fmt::Display for WireError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(&self.message)
	}
}

impl std::error::Error for WireError {}

/// Builds an io::Error of `kind` carrying a [`WireError`].
pub(crate) fn wire_error(
	kind: io::ErrorKind,
	code: i32,
	message: impl Into<String>,
	site: Option<(&'static str, u32)>,
) -> io::Error {
	io::Error::new(kind, WireError { code, message: message.into(), site })
}

/// The [`WireError`] inside `err`, if the wire layers produced it.
pub(crate) fn wire_detail(err: &io::Error) -> Option<&WireError> {
	err.get_ref().and_then(|inner| inner.downcast_ref::<WireError>())
}

/// Recreates an equivalent io::Error (io::Error is not Clone).
pub(crate) fn clone_io_error(err: &io::Error) -> io::Error {
	match wire_detail(err) {
		Some(w) => wire_error(err.kind(), w.code, w.message.clone(), w.site),
		None => match err.raw_os_error() {
			Some(errno) => io::Error::from_raw_os_error(errno),
			None => match err.get_ref() {
				Some(inner) => io::Error::new(err.kind(), inner.to_string()),
				None => io::Error::from(err.kind()),
			},
		},
	}
}

/// `Interrupted` only ever means a raw `EINTR` (cancellation is reported with
/// another kind), so it is retried.
pub(crate) fn is_retryable(err: &io::Error) -> bool {
	err.kind() == io::ErrorKind::Interrupted
}

/// Reads exactly `buf.len()` bytes; EOF first is `UnexpectedEof`.
pub(crate) fn fill<R: Read + ?Sized>(r: &mut R, mut buf: &mut [u8]) -> io::Result<()> {
	while !buf.is_empty() {
		match r.read(buf) {
			Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
			Ok(n) => {
				let n = n.min(buf.len());
				buf = &mut buf[n..];
			}
			Err(e) if is_retryable(&e) => {}
			Err(e) => return Err(e),
		}
	}
	Ok(())
}

/// Writes all of `buf`.
pub(crate) fn put<W: Write + ?Sized>(w: &mut W, mut buf: &[u8]) -> io::Result<()> {
	while !buf.is_empty() {
		match w.write(buf) {
			Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
			Ok(n) => buf = &buf[n.min(buf.len())..],
			Err(e) if is_retryable(&e) => {}
			Err(e) => return Err(e),
		}
	}
	Ok(())
}

/// Number of bytes following a variable-length integer's lead byte.
fn extra_bytes(lead: u8) -> usize {
	(lead.leading_ones() as usize).min(6)
}

/// Mask selecting the value bits left in a lead byte announcing `extra` bytes.
fn lead_mask(extra: usize) -> u8 {
	((1u16 << (8 - extra)) - 1) as u8
}

/// Encodes the little-endian value bytes `le` with at least `min_bytes` bytes
/// of payload (lead byte included); returns the encoded length in `out`.
fn encode_var(le: &[u8], min_bytes: usize, out: &mut [u8; 9]) -> usize {
	let mut cnt = le.len();
	while cnt > min_bytes && le[cnt - 1] == 0 {
		cnt -= 1;
	}
	let top = le[cnt - 1];
	let bit = 1u32 << (7 - (cnt - min_bytes));
	if u32::from(top) >= bit {
		// The top byte does not fit beside the length marker: emit it whole.
		out[0] = !(bit - 1) as u8;
		out[1..=cnt].copy_from_slice(&le[..cnt]);
		cnt + 1
	} else {
		out[0] = if cnt > min_bytes { top | !(bit * 2 - 1) as u8 } else { top };
		out[1..cnt].copy_from_slice(&le[..cnt - 1]);
		cnt
	}
}

fn check_min_bytes(min_bytes: u8) -> io::Result<usize> {
	match min_bytes {
		1..=8 => Ok(usize::from(min_bytes)),
		_ => Err(io::Error::new(
			io::ErrorKind::InvalidInput,
			format!("varlong min_bytes {min_bytes} outside 1..=8"),
		)),
	}
}

fn overflow(what: &str, line: u32) -> io::Error {
	wire_error(
		io::ErrorKind::InvalidData,
		RERR_STREAMIO,
		format!("Overflow in {what}()"),
		Some(("io.c", line)),
	)
}

/// Little-endian rsync integer/string codecs over any reader.
pub(crate) trait ReadExt: Read {
	/// One byte.
	fn read_u8(&mut self) -> io::Result<u8> {
		let mut b = [0u8; 1];
		fill(self, &mut b)?;
		Ok(b[0])
	}

	/// Unsigned 16-bit integer.
	fn read_shortint(&mut self) -> io::Result<u16> {
		let mut b = [0u8; 2];
		fill(self, &mut b)?;
		Ok(u16::from_le_bytes(b))
	}

	/// Signed 32-bit integer.
	fn read_int(&mut self) -> io::Result<i32> {
		let mut b = [0u8; 4];
		fill(self, &mut b)?;
		Ok(i32::from_le_bytes(b))
	}

	/// Unsigned 32-bit integer.
	fn read_uint(&mut self) -> io::Result<u32> {
		let mut b = [0u8; 4];
		fill(self, &mut b)?;
		Ok(u32::from_le_bytes(b))
	}

	/// An `int`, or the marker -1 followed by a full 64-bit value.
	fn read_longint(&mut self) -> io::Result<i64> {
		let v = self.read_int()?;
		if v != -1 {
			return Ok(i64::from(v));
		}
		let mut b = [0u8; 8];
		fill(self, &mut b)?;
		Ok(i64::from_le_bytes(b))
	}

	/// Variable-length 32-bit integer.
	fn read_varint(&mut self) -> io::Result<i32> {
		let lead = self.read_u8()?;
		let extra = extra_bytes(lead);
		if extra == 0 {
			return Ok(i32::from(lead));
		}
		if extra > 4 {
			return Err(overflow("read_varint", 2040));
		}
		let mut b = [0u8; 5];
		fill(self, &mut b[..extra])?;
		b[extra] = lead & lead_mask(extra);
		let [le @ .., _] = b;
		Ok(i32::from_le_bytes(le))
	}

	/// Variable-length 64-bit integer with at least `min_bytes` bytes.
	fn read_varlong(&mut self, min_bytes: u8) -> io::Result<i64> {
		let min = check_min_bytes(min_bytes)?;
		let mut head = [0u8; 8];
		fill(self, &mut head[..min])?;
		let lead = head[0];
		let mut v = [0u8; 9];
		v[..min - 1].copy_from_slice(&head[1..min]);
		let extra = extra_bytes(lead);
		if extra == 0 {
			v[min - 1] = lead;
		} else {
			if min + extra > v.len() {
				return Err(overflow("read_varlong", 2077));
			}
			fill(self, &mut v[min - 1..min - 1 + extra])?;
			v[min + extra - 1] = lead & lead_mask(extra);
		}
		let [le @ .., _] = v;
		Ok(i64::from_le_bytes(le))
	}

	/// `read_varint` from protocol 30, `read_int` before.
	fn read_varint30(&mut self, proto: Proto) -> io::Result<i32> {
		if proto.version < 30 { self.read_int() } else { self.read_varint() }
	}

	/// `read_varlong` from protocol 30, `read_longint` before.
	fn read_varlong30(&mut self, proto: Proto, min_bytes: u8) -> io::Result<i64> {
		if proto.version < 30 { self.read_longint() } else { self.read_varlong(min_bytes) }
	}

	/// Exactly `len` bytes; fails with InvalidData when `len > limit`.
	fn read_bytes(&mut self, len: usize, limit: usize) -> io::Result<Vec<u8>> {
		if len > limit {
			return Err(wire_error(
				io::ErrorKind::InvalidData,
				RERR_PROTOCOL,
				format!("wire size out of range: {len} > {limit}"),
				None,
			));
		}
		// Grow as the bytes actually arrive so a lying length cannot force a
		// large allocation before the stream ends.
		const STEP: usize = 64 * 1024;
		let mut out = Vec::with_capacity(len.min(STEP));
		while out.len() < len {
			let start = out.len();
			let step = (len - start).min(STEP);
			out.resize(start + step, 0);
			fill(self, &mut out[start..])?;
		}
		Ok(out)
	}

	/// A string with a 1-byte length (< 0x80) or a 2-byte big-endian length
	/// with the high bit set (up to 0x7FFF), read into upstream's `bufsize`
	/// buffer: a length of `bufsize` or more fails with upstream's
	/// `over-long vstring received` text and the exit `code` at `site` the
	/// caller ends with.
	fn read_vstring(
		&mut self,
		bufsize: usize,
		code: i32,
		site: (&'static str, u32),
	) -> io::Result<Vec<u8>> {
		let first = self.read_u8()?;
		let len = if first & 0x80 != 0 {
			usize::from(first & 0x7F) * 0x100 + usize::from(self.read_u8()?)
		} else {
			usize::from(first)
		};
		if len >= bufsize {
			return Err(wire_error(
				io::ErrorKind::InvalidData,
				code,
				format!("over-long vstring received ({len} > {})", bufsize - 1),
				Some(site),
			));
		}
		self.read_bytes(len, bufsize)
	}
}

impl<R: Read + ?Sized> ReadExt for R {}

/// Little-endian rsync integer/string codecs over any writer. Each value is
/// handed to the writer in a single `write` sequence.
pub(crate) trait WriteExt: Write {
	/// One byte.
	fn write_u8(&mut self, v: u8) -> io::Result<()> {
		put(self, &[v])
	}

	/// Unsigned 16-bit integer.
	fn write_shortint(&mut self, v: u16) -> io::Result<()> {
		put(self, &v.to_le_bytes())
	}

	/// Signed 32-bit integer.
	fn write_int(&mut self, v: i32) -> io::Result<()> {
		put(self, &v.to_le_bytes())
	}

	/// An `int` for 0..=i32::MAX, else -1 followed by the full 64-bit value.
	fn write_longint(&mut self, v: i64) -> io::Result<()> {
		if (0..=i64::from(i32::MAX)).contains(&v) {
			return put(self, &(v as i32).to_le_bytes());
		}
		let mut b = [0xFFu8; 12];
		b[4..].copy_from_slice(&v.to_le_bytes());
		put(self, &b)
	}

	/// Variable-length 32-bit integer.
	fn write_varint(&mut self, v: i32) -> io::Result<()> {
		let mut out = [0u8; 9];
		let n = encode_var(&v.to_le_bytes(), 1, &mut out);
		put(self, &out[..n])
	}

	/// Variable-length 64-bit integer with at least `min_bytes` bytes.
	fn write_varlong(&mut self, v: i64, min_bytes: u8) -> io::Result<()> {
		let min = check_min_bytes(min_bytes)?;
		let mut out = [0u8; 9];
		let n = encode_var(&v.to_le_bytes(), min, &mut out);
		put(self, &out[..n])
	}

	/// `write_varint` from protocol 30, `write_int` before.
	fn write_varint30(&mut self, proto: Proto, v: i32) -> io::Result<()> {
		if proto.version < 30 { self.write_int(v) } else { self.write_varint(v) }
	}

	/// `write_varlong` from protocol 30, `write_longint` before.
	fn write_varlong30(&mut self, proto: Proto, v: i64, min_bytes: u8) -> io::Result<()> {
		if proto.version < 30 { self.write_longint(v) } else { self.write_varlong(v, min_bytes) }
	}

	/// A vstring (see [`ReadExt::read_vstring`]); longer than 0x7FFF is refused.
	fn write_vstring(&mut self, s: &[u8]) -> io::Result<()> {
		let len = s.len();
		if len > 0x7FFF {
			return Err(wire_error(
				io::ErrorKind::InvalidInput,
				RERR_PROTOCOL,
				format!("attempting to send over-long vstring ({len} > {})", 0x7FFF),
				Some(("io.c", 2529)),
			));
		}
		let mut buf = Vec::with_capacity(len + 2);
		if len > 0x7F {
			buf.push((len / 0x100) as u8 | 0x80);
		}
		buf.push(len as u8);
		buf.extend_from_slice(s);
		put(self, &buf)
	}
}

impl<W: Write + ?Sized> WriteExt for W {}

/// File-list index codec for ONE direction (`read_ndx`/`write_ndx`): delta-encoded from
/// protocol 30, plain `int` before. Use one instance per direction per connection.
///
/// From protocol 30 an index is sent relative to the previous index of the
/// same sign: a delta of 1..=253 is one byte; a delta of 0 or 254..=32767 is
/// 0xFE plus two big-endian bytes; anything else is 0xFE plus the absolute
/// value in four bytes with the top byte first and flagged by 0x80. Negative
/// indices are prefixed by 0xFF and tracked separately; NDX_DONE is a lone 0.
pub(crate) struct NdxCodec {
	delta: bool,
	plain_writes: bool,
	prev_positive: i32,
	prev_negative: i32,
	role: Option<Role>,
}

impl NdxCodec {
	/// A codec in its initial state for `proto`.
	pub(crate) fn new(proto: Proto) -> Self {
		Self {
			delta: proto.version >= 30,
			plain_writes: false,
			prev_positive: -1,
			prev_negative: 1,
			role: None,
		}
	}

	/// Names the local role in diagnostics (upstream `who_am_i`).
	pub(crate) fn set_role(&mut self, role: Role) {
		self.role = Some(role);
	}

	/// Writes plain `int`s regardless of protocol (upstream does this for the
	/// generator's output while reading a batch).
	pub(crate) fn set_plain_writes(&mut self, plain: bool) {
		self.plain_writes = plain;
	}

	/// Reads one index.
	pub(crate) fn read(&mut self, r: &mut dyn Read) -> io::Result<i32> {
		if !self.delta {
			return r.read_int();
		}
		let first = r.read_u8()?;
		let negative = first == 0xFF;
		let b = if negative {
			r.read_u8()?
		} else if first == 0 {
			return Ok(NDX_DONE);
		} else {
			first
		};
		let prev = (if negative { self.prev_negative } else { self.prev_positive }) as u32;
		let unum = if b == 0xFE {
			let mut two = [0u8; 2];
			fill(r, &mut two)?;
			if two[0] & 0x80 != 0 {
				let mut rest = [0u8; 2];
				fill(r, &mut rest)?;
				u32::from_le_bytes([two[1], rest[0], rest[1], two[0] & 0x7F])
			} else {
				(u32::from(two[0]) << 8 | u32::from(two[1])).wrapping_add(prev)
			}
		} else {
			u32::from(b).wrapping_add(prev)
		};
		let Ok(num) = i32::try_from(unum) else {
			let who = self.role.map_or("", Role::name);
			return Err(wire_error(
				io::ErrorKind::InvalidData,
				RERR_PROTOCOL,
				format!("Invalid file index: {unum} [{who}]"),
				Some(("io.c", 2623)),
			));
		};
		if negative {
			self.prev_negative = num;
			Ok(-num)
		} else {
			self.prev_positive = num;
			Ok(num)
		}
	}

	/// Writes one index.
	pub(crate) fn write(&mut self, w: &mut dyn Write, ndx: i32) -> io::Result<()> {
		if !self.delta || self.plain_writes {
			return w.write_int(ndx);
		}
		let mut b = [0u8; 6];
		let mut n = 0;
		let (diff, mag) = if ndx >= 0 {
			let diff = ndx.wrapping_sub(self.prev_positive);
			self.prev_positive = ndx;
			(diff, ndx)
		} else if ndx == NDX_DONE {
			return w.write_u8(0);
		} else {
			b[0] = 0xFF;
			n = 1;
			let mag = ndx.wrapping_neg();
			let diff = mag.wrapping_sub(self.prev_negative);
			self.prev_negative = mag;
			(diff, mag)
		};
		if diff > 0 && diff < 0xFE {
			b[n] = diff as u8;
			n += 1;
		} else if !(0..=0x7FFF).contains(&diff) {
			let m = mag.to_le_bytes();
			b[n..n + 5].copy_from_slice(&[0xFE, m[3] | 0x80, m[0], m[1], m[2]]);
			n += 5;
		} else {
			b[n..n + 3].copy_from_slice(&[0xFE, (diff >> 8) as u8, diff as u8]);
			n += 3;
		}
		put(w, &b[..n])
	}
}


