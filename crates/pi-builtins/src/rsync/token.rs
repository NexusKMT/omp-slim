//! Delta token streams: literal data and block-match tokens, plain or compressed
//! with zlib, zlibx, zstd or lz4, exactly as rsync 3.5.1 frames them.
//!
//! Plain streams send each literal run as `int len` + bytes (at most CHUNK_SIZE per
//! piece), a match of block `n` as `int -(n+1)`, and `int 0` at the end. Compressed
//! streams use flag bytes: compressed data frames (`DEFLATED_DATA` + 14-bit length)
//! and block tokens coded relative to the end of the previous run, with runs of
//! consecutive blocks collapsed.
//!
//! zlib (but not zlibx) also feeds every matched block into the compressor's and
//! decompressor's history so later literals can refer to it. Upstream does that
//! with a patched zlib (`Z_INSERT_ONLY`) or, built against a stock zlib like the
//! reference binary, a discarded sync-flush; both leave the history ending with the
//! block's bytes, which is what [`flate2::Compress::set_dictionary`] does on a raw
//! stream at a flushed boundary. The decoder inserts the same bytes by inflating
//! them as a stored block.

use std::{collections::HashSet, io};

use flate2::{Compression, Decompress, FlushCompress, FlushDecompress, Status};
use zstd::zstd_safe::{self, CCtx, CParameter, DCtx, InBuffer, OutBuffer, zstd_sys::ZSTD_EndDirective};

use crate::rsync::{
	checksum::{NameNum, NameTable},
	consts,
	exit::{self, RsyncError},
	paths,
	wire::{ReadExt, WriteExt},
};

/// End of the file's token stream.
const END_FLAG: u8 = 0;
/// Followed by a 32-bit token number.
const TOKEN_LONG: u8 = 0x20;
/// Followed by a 32-bit token number and a 16-bit run count.
const TOKENRUN_LONG: u8 = 0x21;
/// Plus the high 6 bits of the length, then the low length byte.
const DEFLATED_DATA: u8 = 0x40;
/// Plus a 6-bit token number relative to the previous run's end.
const TOKEN_REL: u8 = 0x80;
/// Like TOKEN_REL, followed by a 16-bit run count.
const TOKENRUN_REL: u8 = 0xc0;
/// Largest compressed frame (14-bit count).
const MAX_DATA_COUNT: usize = 16383;
/// Largest token number a compressed stream may name.
const MAX_TOKEN_INDEX: i32 = 0x7fff_fffe;
/// Longest stored block used to insert matched data into zlib history.
const MAX_STORED_LEN: usize = 0xffff;
/// The empty stored block that ends a sync flush (trimmed from the wire).
const SYNC_MARKER: [u8; 4] = [0, 0, 0xff, 0xff];
/// Default zstd level (ZSTD_CLEVEL_DEFAULT).
const ZSTD_DEFAULT_LEVEL: i32 = 3;

/// zlib's "enough output space for one call" bound used for inflate buffers.
const fn avail_out_size(n: usize) -> usize {
	n * 1001 / 1000 + 16
}

/// Compression algorithm (`--compress-choice`, negotiation names "zstd lz4 zlibx zlib none").
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Compress {
	None,
	Zlib,
	Zlibx,
	Zstd,
	Lz4,
}

/// The compression negotiation table (strongest preference first).
pub(crate) static COMPRESS_NAMES: NameTable = NameTable {
	entries: &[
		NameNum { name: "zstd", main: "zstd", num: 4 },
		NameNum { name: "lz4", main: "lz4", num: 3 },
		NameNum { name: "zlibx", main: "zlibx", num: 2 },
		NameNum { name: "zlib", main: "zlib", num: 1 },
		NameNum { name: "none", main: "none", num: 0 },
	],
};

impl Compress {
	/// Negotiation name.
	pub(crate) fn name(self) -> &'static str {
		match self {
			Self::None => "none",
			Self::Zlib => "zlib",
			Self::Zlibx => "zlibx",
			Self::Zstd => "zstd",
			Self::Lz4 => "lz4",
		}
	}

	/// Case-insensitive name lookup ("auto" is not a name; see [`parse_compress_choice`]).
	pub(crate) fn from_name(s: &str) -> Option<Self> {
		COMPRESS_NAMES.lookup(s.as_bytes()).and_then(|entry| Self::from_num(entry.num))
	}

	/// Upstream CPRES_* number.
	pub(crate) const fn num(self) -> u8 {
		match self {
			Self::None => 0,
			Self::Zlib => 1,
			Self::Zlibx => 2,
			Self::Lz4 => 3,
			Self::Zstd => 4,
		}
	}

	const fn from_num(num: u8) -> Option<Self> {
		Some(match num {
			0 => Self::None,
			1 => Self::Zlib,
			2 => Self::Zlibx,
			3 => Self::Lz4,
			4 => Self::Zstd,
			_ => return None,
		})
	}

	/// The level actually used for a requested `--compress-level` (None = not
	/// given), like upstream's init_compression_level: zlib/zlibx default to 6,
	/// take -1 as 6, clamp to 1..=9, and level 0 turns compression off (`None`);
	/// zstd defaults to 3, takes 0 as 3 and clamps to zstd's level range; lz4
	/// always uses 0. `Compress::None` has no level.
	pub(crate) fn effective_level(self, requested: Option<i32>) -> Option<i32> {
		match self {
			Self::None => None,
			Self::Zlib | Self::Zlibx => match requested {
				None | Some(-1) => Some(6),
				Some(0) => None,
				Some(level) => Some(level.clamp(1, 9)),
			},
			Self::Zstd => match requested {
				None | Some(0) => Some(ZSTD_DEFAULT_LEVEL),
				Some(level) => Some(level.clamp(zstd_safe::min_c_level(), zstd_safe::max_c_level())),
			},
			Self::Lz4 => Some(0),
		}
	}
}

/// Parses `--compress-choice=STR`: `Ok(None)` for "auto", else the algorithm.
/// The error is upstream's message without its newline; upstream reports it with
/// RERR_UNSUPPORTED at compat.c(190).
pub(crate) fn parse_compress_choice(arg: &str) -> Result<Option<Compress>, String> {
	if arg.eq_ignore_ascii_case("auto") {
		return Ok(None);
	}
	Compress::from_name(arg).map(Some).ok_or_else(|| format!("unknown compress name: {arg}"))
}

/// Our compression preference list as sent in negotiation (RSYNC_COMPRESS_LIST
/// aware). As for checksums, the client omits "none" from the default list and
/// reads the env value before '&'; the server reads the part after it. A batch
/// writer passes upstream's forced "zlib" as `env_override`.
pub(crate) fn compress_list(env_override: Option<&str>, am_server: bool) -> Vec<&'static str> {
	COMPRESS_NAMES.list(env_override, am_server)
}

/// Server-side `--compress-choice` check against RSYNC_COMPRESS_LIST.
pub(crate) fn compress_env_allows(env_override: Option<&str>, kind: Compress) -> bool {
	COMPRESS_NAMES.env_allows(env_override, &[kind.num()], false)
}

/// Upstream's default "dont compress" suffixes.
const DEFAULT_SKIP_SUFFIXES: &str = concat!(
	"3g2 3gp 7z aac ace apk avi bz2 deb dmg ear f4v flac flv gpg gz iso jar jpeg jpg lrz lz ",
	"lz4 lzma lzo m1a m1v m2a m2ts m2v m4a m4b m4p m4r m4v mka mkv mov mp1 mp2 mp3 mp4 mpa ",
	"mpeg mpg mpv mts odb odf odg odi odm odp ods odt oga ogg ogm ogv ogx opus otg oth otp ots ",
	"ott oxt png qt rar rpm rz rzip spx squashfs sxc sxd sxg sxm sxw sz tbz tbz2 tgz tlz ts ",
	"txz tzo vob war webm webp xz z zip zst",
);

/// Longest suffix kept from one `--skip-compress` entry.
const MAX_SUFFIX_LEN: usize = 32;

/// `--skip-compress` suffix list (default list when None).
///
/// Note: rsync 3.5.1 cannot change the compression level mid-stream, so it never
/// acts on this list; it is kept for `--skip-compress` parsing/forwarding and for
/// callers that want to know which names it covers.
#[derive(Clone, Debug)]
pub(crate) struct SkipCompress {
	suffixes: HashSet<Box<[u8]>>,
}

impl SkipCompress {
	/// `spec` is the `--skip-compress` value: suffixes separated by '/', matched
	/// case-insensitively, with `[...]` character classes (a one-character class
	/// such as "[a]" is literal, "[]" matches nothing). Without a spec the default
	/// suffix list applies.
	pub(crate) fn new(spec: Option<&str>) -> Self {
		let mut suffixes = HashSet::new();
		match spec {
			None => {
				for word in DEFAULT_SKIP_SUFFIXES.split(' ') {
					suffixes.insert(word.as_bytes().into());
				}
			},
			Some(spec) => {
				for token in spec.as_bytes().split(|&b| b == b'/').filter(|t| !t.is_empty()) {
					let mut token = token.to_ascii_lowercase();
					token.truncate(MAX_SUFFIX_LEN);
					expand_suffix(token[0], &token[1..], &mut Vec::new(), &mut suffixes);
				}
			},
		}
		Self { suffixes }
	}

	/// Whether `name`'s suffix (after the last '.' of its last component, not a
	/// leading dot) is in the list.
	pub(crate) fn skips(&self, name: &[u8]) -> bool {
		let base = paths::basename(name);
		let Some(dot) = base.iter().rposition(|&b| b == b'.') else { return false };
		let suffix = &base[dot + 1..];
		if dot == 0 || suffix.is_empty() || suffix.len() > MAX_SUFFIX_LEN {
			return false;
		}
		let mut lower = [0u8; MAX_SUFFIX_LEN];
		let lower = &mut lower[..suffix.len()];
		lower.copy_from_slice(suffix);
		lower.make_ascii_lowercase();
		self.suffixes.contains(&*lower)
	}
}

/// Adds every suffix `ltr` + `rest` stands for, expanding `[...]` classes.
fn expand_suffix(ltr: u8, rest: &[u8], prefix: &mut Vec<u8>, out: &mut HashSet<Box<[u8]>>) {
	if ltr == b'['
		&& let Some(close) = memchr::memchr(b']', rest)
		&& close != 1
	{
		let after = &rest[close + 1..];
		for &member in &rest[..close] {
			expand_suffix(member, after, prefix, out);
		}
		return;
	}
	prefix.push(ltr);
	match rest.split_first() {
		Some((&next, tail)) => expand_suffix(next, tail, prefix, out),
		None => {
			out.insert(prefix.as_slice().into());
		},
	}
	prefix.pop();
}

/// What the token stream says next.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Token<'a> {
	Literal(&'a [u8]),
	Block(u32),
	End,
}

/// Token value for "data only, no token" (upstream -2).
const DATA_ONLY: i64 = -2;
/// Token value for "end of file" (upstream -1).
const END_TOKEN: i64 = -1;

/// Run-length state shared by the compressed formats.
struct Runs {
	last_token: i64,
	run_start: i64,
	last_run_end: i64,
}

impl Runs {
	const fn new() -> Self {
		Self { last_token: END_TOKEN, run_start: 0, last_run_end: 0 }
	}

	/// Records `token`, first emitting the pending run when it cannot be extended.
	/// Returns true when `token` starts a new file.
	fn advance(&mut self, w: &mut dyn io::Write, token: i64, has_data: bool) -> io::Result<bool> {
		let starts_file = self.last_token == END_TOKEN;
		if starts_file {
			self.last_run_end = 0;
			self.run_start = token;
		} else if self.last_token == DATA_ONLY {
			self.run_start = token;
		} else if has_data || token != self.last_token + 1 || token >= self.run_start + 65536 {
			let rel = self.run_start - self.last_run_end;
			let n = self.last_token - self.run_start;
			if (0..=63).contains(&rel) {
				let base = if n == 0 { TOKEN_REL } else { TOKENRUN_REL };
				w.write_u8(base + rel as u8)?;
			} else {
				w.write_u8(if n == 0 { TOKEN_LONG } else { TOKENRUN_LONG })?;
				w.write_int(self.run_start as i32)?;
			}
			if n != 0 {
				w.write_u8(n as u8)?;
				w.write_u8((n >> 8) as u8)?;
			}
			self.last_run_end = self.last_token;
			self.run_start = token;
		}
		self.last_token = token;
		Ok(starts_file)
	}
}

fn encode_error(message: String) -> io::Error {
	io::Error::other(message)
}

/// Sender side (send_token). One per transfer; `begin_file` resets per-file state.
pub(crate) struct TokenEncoder {
	kind: Compress,
	level: i32,
	threads: u32,
	proto_version: u32,
	runs: Runs,
	flush_pending: bool,
	obuf: Vec<u8>,
	deflate: Option<flate2::Compress>,
	zstd: Option<CCtx<'static>>,
}

impl TokenEncoder {
	/// `level` is the requested `--compress-level` (None = unspecified), resolved
	/// with [`Compress::effective_level`]; callers turn compression off beforehand
	/// when that yields None.
	pub(crate) fn new(kind: Compress, level: Option<i32>) -> Self {
		Self {
			kind,
			level: kind.effective_level(level).unwrap_or(0),
			threads: 0,
			proto_version: consts::PROTOCOL_VERSION,
			runs: Runs::new(),
			flush_pending: false,
			obuf: Vec::new(),
			deflate: None,
			zstd: None,
		}
	}

	/// The negotiated protocol: before 31, zlib re-inserts the first 64 KiB of a
	/// longer matched block instead of advancing through it (kept for compatibility).
	pub(crate) fn set_protocol(&mut self, version: u32) {
		self.proto_version = version;
	}

	/// `--compress-threads` for zstd (ignored when the zstd library lacks workers).
	pub(crate) fn set_threads(&mut self, threads: u32) {
		self.threads = threads;
	}

	/// Starts a file. Per-file state is already reset by the previous file's end;
	/// `compress_this_file` (the skip-compress verdict) does not change the stream
	/// because rsync 3.5.1 cannot change a compression level mid-stream.
	pub(crate) fn begin_file(&mut self, _compress_this_file: bool) {}

	/// Sends `literal` then, if `block` is Some, the block-match token; `matched` is the
	/// matched block's data (feeds compressor history for zlib).
	pub(crate) fn send(
		&mut self,
		w: &mut dyn io::Write,
		literal: &[u8],
		block: Option<u32>,
		matched: &[u8],
	) -> io::Result<()> {
		let token = match block {
			None => DATA_ONLY,
			Some(index) if index < MAX_TOKEN_INDEX as u32 + 1 => i64::from(index),
			Some(index) => {
				return Err(io::Error::new(
					io::ErrorKind::InvalidInput,
					format!("block token {index} out of range"),
				));
			},
		};
		self.token(w, token, literal, matched)
	}

	

	/// Ends the file with a final literal run in the same call, as upstream's
	/// matcher does for the tail of a file.
	pub(crate) fn end_file_with(&mut self, w: &mut dyn io::Write, literal: &[u8]) -> io::Result<()> {
		self.token(w, END_TOKEN, literal, &[])
	}

	fn token(&mut self, w: &mut dyn io::Write, token: i64, data: &[u8], matched: &[u8]) -> io::Result<()> {
		match self.kind {
			Compress::None => simple_send(w, token, data),
			Compress::Zlib | Compress::Zlibx => self.deflate_send(w, token, data, matched),
			Compress::Zstd => self.zstd_send(w, token, data),
			Compress::Lz4 => self.lz4_send(w, token, data),
		}
	}

	fn deflate_send(&mut self, w: &mut dyn io::Write, token: i64, data: &[u8], matched: &[u8]) -> io::Result<()> {
		if self.runs.advance(w, token, !data.is_empty())? {
			match &mut self.deflate {
				Some(deflate) => deflate.reset(),
				None => {
					self.deflate = Some(flate2::Compress::new_with_window_bits(
						Compression::new(self.level.clamp(0, 9) as u32),
						false,
						15,
					));
				},
			}
			self.flush_pending = false;
		}
		let Some(deflate) = self.deflate.as_mut() else {
			return Err(encode_error("compression init failed".into()));
		};
		if self.obuf.len() < 2 + MAX_DATA_COUNT {
			self.obuf.resize(2 + MAX_DATA_COUNT, 0);
		}

		// A data-only call without data has nothing to deflate (upstream would
		// fail here with Z_BUF_ERROR; the matcher never asks for it).
		if (!data.is_empty() || self.flush_pending) && !(data.is_empty() && token == DATA_ONLY) {
			deflate_frames(deflate, w, &mut self.obuf, data, token != DATA_ONLY)?;
			self.flush_pending = token == DATA_ONLY;
		}

		if token == END_TOKEN {
			w.write_u8(END_FLAG)?;
		} else if token != DATA_ONLY && self.kind == Compress::Zlib {
			let mut offset = 0;
			let mut left = matched.len();
			while left > 0 {
				let n = left.min(MAX_STORED_LEN);
				let piece = &matched[offset..offset + n];
				deflate.set_dictionary(piece).map_err(|e| {
					encode_error(format!("deflate on token returned -2 ({n} bytes left): {e}"))
				})?;
				left -= n;
				if self.proto_version >= 31 {
					offset += n;
				}
			}
		}
		Ok(())
	}

	fn zstd_send(&mut self, w: &mut dyn io::Write, token: i64, data: &[u8]) -> io::Result<()> {
		if self.zstd.is_none() {
			let mut cctx = CCtx::try_create().ok_or_else(|| encode_error("compression init failed".into()))?;
			// Upstream ignores parameter errors (e.g. workers without zstdmt).
			let _ = cctx.set_parameter(CParameter::CompressionLevel(self.level));
			if self.threads > 0 {
				let _ = cctx.set_parameter(CParameter::NbWorkers(self.threads));
			}
			self.zstd = Some(cctx);
			self.obuf.resize(2 + MAX_DATA_COUNT, 0);
		}
		if self.runs.advance(w, token, !data.is_empty())? {
			self.flush_pending = false;
		}
		let Some(cctx) = self.zstd.as_mut() else {
			return Err(encode_error("compression init failed".into()));
		};
		if !data.is_empty() || self.flush_pending {
			let flush = token != DATA_ONLY;
			let directive = if flush { ZSTD_EndDirective::ZSTD_e_flush } else { ZSTD_EndDirective::ZSTD_e_continue };
			let mut input = InBuffer::around(data);
			loop {
				let (left, produced) = {
					let mut out = OutBuffer::around(&mut self.obuf[2..2 + MAX_DATA_COUNT]);
					let left = cctx
						.compress_stream2(&mut out, &mut input, directive)
						.map_err(|code| encode_error(format!("ZSTD_compressStream returned {}", code as i32)))?;
					(left, out.pos())
				};
				let finished = if flush { left == 0 } else { input.pos == data.len() };
				if produced != 0 {
					write_frame(w, &mut self.obuf, produced)?;
				}
				if finished {
					break;
				}
			}
			self.flush_pending = token == DATA_ONLY;
		}
		if token == END_TOKEN {
			w.write_u8(END_FLAG)?;
		}
		Ok(())
	}

	fn lz4_send(&mut self, w: &mut dyn io::Write, token: i64, data: &[u8]) -> io::Result<()> {
		let cap = lz4_flex::block::get_maximum_output_size(MAX_DATA_COUNT);
		if self.obuf.len() < 2 + cap {
			self.obuf.resize(2 + cap, 0);
		}
		self.runs.advance(w, token, !data.is_empty())?;
		// Every frame is an independent LZ4 block. Unlike upstream, an empty
		// frame is never sent: upstream receivers would take it for end-of-file.
		let mut rest = data;
		while !rest.is_empty() {
			let mut take = rest.len().min(MAX_DATA_COUNT);
			loop {
				let out_len = lz4_flex::block::compress_into(&rest[..take], &mut self.obuf[2..2 + cap])
					.map_err(|e| encode_error(format!("compress returned 0: {e}")))?;
				if out_len <= MAX_DATA_COUNT {
					write_frame(w, &mut self.obuf, out_len)?;
					rest = &rest[take..];
					break;
				}
				take /= 2;
			}
		}
		if token == END_TOKEN {
			w.write_u8(END_FLAG)?;
		}
		Ok(())
	}
}

/// Uncompressed tokens: literal pieces of at most CHUNK_SIZE, then the token.
fn simple_send(w: &mut dyn io::Write, token: i64, data: &[u8]) -> io::Result<()> {
	for piece in data.chunks(consts::CHUNK_SIZE) {
		w.write_int(piece.len() as i32)?;
		w.write_all(piece)?;
	}
	if token != DATA_ONLY {
		w.write_int((-(token + 1)) as i32)?;
	}
	Ok(())
}

/// Writes `obuf[2..2 + n]` as one DEFLATED_DATA frame.
fn write_frame(w: &mut dyn io::Write, obuf: &mut [u8], n: usize) -> io::Result<()> {
	obuf[0] = DEFLATED_DATA | (n >> 8) as u8;
	obuf[1] = n as u8;
	w.write_all(&obuf[..n + 2])
}

/// Deflates `data` into DEFLATED_DATA frames. With `flush`, the input ends with a
/// sync flush whose trailing empty stored block (00 00 ff ff) is not sent: frames
/// filled during the flush hold their last four bytes back for the next frame.
fn deflate_frames(
	deflate: &mut flate2::Compress,
	w: &mut dyn io::Write,
	obuf: &mut [u8],
	data: &[u8],
	flush: bool,
) -> io::Result<()> {
	let mut rest = data;
	let mut avail: &[u8] = &[];
	let mut filled = 0usize;
	let mut room = 0usize;
	let mut mode = FlushCompress::None;
	loop {
		if avail.is_empty() && !rest.is_empty() {
			let n = rest.len().min(consts::CHUNK_SIZE);
			(avail, rest) = rest.split_at(n);
		}
		if room == 0 {
			filled = 0;
			room = MAX_DATA_COUNT;
			if mode != FlushCompress::None {
				obuf.copy_within(2 + MAX_DATA_COUNT - 4..2 + MAX_DATA_COUNT, 2);
				filled = 4;
				room -= 4;
			}
		}
		if rest.is_empty() && flush {
			mode = FlushCompress::Sync;
		}
		let (in_before, out_before) = (deflate.total_in(), deflate.total_out());
		let status = deflate
			.compress(avail, &mut obuf[2 + filled..2 + filled + room], mode)
			.map_err(|e| encode_error(format!("deflate returned -2: {e}")))?;
		if status == Status::StreamEnd {
			return Err(encode_error("deflate returned 1".into()));
		}
		let consumed = (deflate.total_in() - in_before) as usize;
		let produced = (deflate.total_out() - out_before) as usize;
		avail = &avail[consumed..];
		filled += produced;
		room -= produced;
		let all_given = rest.is_empty();
		if all_given || room == 0 {
			let n = if mode == FlushCompress::None { filled } else { filled.saturating_sub(4) };
			if n > 0 {
				write_frame(w, obuf, n)?;
			}
		}
		if all_given && room != 0 {
			return Ok(());
		}
		if consumed == 0 && produced == 0 {
			return Err(encode_error("deflate returned -5".into()));
		}
	}
}

/// Decoder state (upstream recv_state).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RecvState {
	Init,
	Idle,
	Running,
	Inflating,
	Inflated,
}

/// One decoded step before borrowing the output buffer.
enum Step {
	Data(usize),
	Block(u32),
	End,
}

fn decode_error(message: String, line: u32) -> RsyncError {
	RsyncError::new(exit::RERR_STREAMIO, message).at("token.c", line)
}

fn invalid_token() -> RsyncError {
	RsyncError::new(exit::RERR_PROTOCOL, "invalid token number in compressed stream").at("token.c", 531)
}

/// zlib return code for a flate2 result, for upstream's diagnostics.
fn zlib_code(result: &Result<Status, flate2::DecompressError>) -> i32 {
	match result {
		Ok(Status::Ok) => 0,
		Ok(Status::StreamEnd) => 1,
		Ok(Status::BufError) => -5,
		Err(err) if err.needs_dictionary().is_some() => 2,
		Err(_) => -3,
	}
}

/// Receiver side (recv_token + see_token).
pub(crate) struct TokenDecoder {
	kind: Compress,
	proto_version: u32,
	state: RecvState,
	rx_token: i32,
	rx_run: i32,
	saved_flag: Option<u8>,
	residue: usize,
	data: Vec<u8>,
	cbuf: Vec<u8>,
	cpos: usize,
	clen: usize,
	inflate: Option<Decompress>,
	zstd: Option<DCtx<'static>>,
	pending: Option<RsyncError>,
}

impl TokenDecoder {
	/// A decoder for `kind`; buffers are allocated on first use and bounded.
	pub(crate) fn new(kind: Compress) -> Self {
		Self {
			kind,
			proto_version: consts::PROTOCOL_VERSION,
			state: RecvState::Init,
			rx_token: 0,
			rx_run: 0,
			saved_flag: None,
			residue: 0,
			data: Vec::new(),
			cbuf: Vec::new(),
			cpos: 0,
			clen: 0,
			inflate: None,
			zstd: None,
			pending: None,
		}
	}

	/// The negotiated protocol (see [`TokenEncoder::set_protocol`]).
	pub(crate) fn set_protocol(&mut self, version: u32) {
		self.proto_version = version;
	}

	/// The next literal piece, block match, or end of the file.
	pub(crate) fn recv(&mut self, r: &mut dyn io::Read) -> Result<Token<'_>, RsyncError> {
		if let Some(err) = self.pending.take() {
			return Err(err);
		}
		let step = match self.kind {
			Compress::None => self.simple_step(r)?,
			Compress::Zlib | Compress::Zlibx => self.inflate_step(r)?,
			Compress::Zstd => self.zstd_step(r)?,
			Compress::Lz4 => self.lz4_step(r)?,
		};
		Ok(match step {
			Step::Data(n) => Token::Literal(&self.data[..n]),
			Step::Block(index) => Token::Block(index),
			Step::End => Token::End,
		})
	}

	/// Feeds a matched block's data into decompressor history (see_token). Only
	/// zlib keeps such history; an inflate failure is reported by the next `recv`.
	pub(crate) fn see_block(&mut self, data: &[u8]) {
		if self.kind != Compress::Zlib || self.pending.is_some() {
			return;
		}
		if let Err(err) = self.insert_history(data) {
			self.pending = Some(err);
		}
	}

	fn simple_step(&mut self, r: &mut dyn io::Read) -> Result<Step, RsyncError> {
		if self.residue == 0 {
			let len = r.read_int().map_err(RsyncError::from_stream)?;
			if len == 0 {
				return Ok(Step::End);
			}
			if len < 0 {
				return Ok(Step::Block((-(i64::from(len) + 1)) as u32));
			}
			self.residue = len as usize;
		}
		let n = self.residue.min(consts::CHUNK_SIZE);
		if self.data.len() < consts::CHUNK_SIZE {
			self.data.resize(consts::CHUNK_SIZE, 0);
		}
		r.read_exact(&mut self.data[..n]).map_err(RsyncError::from_stream)?;
		self.residue -= n;
		Ok(Step::Data(n))
	}

	/// Reads a DEFLATED_DATA payload into `cbuf`.
	fn read_frame(&mut self, r: &mut dyn io::Read, flag: u8) -> Result<(), RsyncError> {
		let low = r.read_u8().map_err(RsyncError::from_stream)?;
		let n = (usize::from(flag & 0x3f) << 8) | usize::from(low);
		if self.cbuf.len() < MAX_DATA_COUNT {
			self.cbuf.resize(MAX_DATA_COUNT, 0);
		}
		r.read_exact(&mut self.cbuf[..n]).map_err(RsyncError::from_stream)?;
		self.cpos = 0;
		self.clen = n;
		self.state = RecvState::Inflating;
		Ok(())
	}

	fn read_flag(&mut self, r: &mut dyn io::Read) -> Result<u8, RsyncError> {
		match self.saved_flag.take() {
			Some(flag) => Ok(flag),
			None => r.read_u8().map_err(RsyncError::from_stream),
		}
	}

	/// A token flag byte (anything but data and END_FLAG).
	fn token_num(&mut self, r: &mut dyn io::Read, flag: u8) -> Result<Step, RsyncError> {
		let mut run_bit = flag & 1;
		if flag & TOKEN_REL != 0 {
			let incr = i32::from(flag & 0x3f);
			if self.rx_token > MAX_TOKEN_INDEX - incr {
				return Err(invalid_token());
			}
			self.rx_token += incr;
			run_bit = (flag >> 6) & 1;
		} else {
			self.rx_token = r.read_int().map_err(RsyncError::from_stream)?;
			if !(0..=MAX_TOKEN_INDEX).contains(&self.rx_token) {
				return Err(invalid_token());
			}
		}
		if run_bit != 0 {
			let lo = r.read_u8().map_err(RsyncError::from_stream)?;
			let hi = r.read_u8().map_err(RsyncError::from_stream)?;
			self.rx_run = i32::from(lo) | (i32::from(hi) << 8);
			if self.rx_run <= 0 || self.rx_token > MAX_TOKEN_INDEX - self.rx_run {
				return Err(invalid_token());
			}
			self.state = RecvState::Running;
		}
		Ok(Step::Block(self.rx_token as u32))
	}

	fn run_step(&mut self) -> Result<Step, RsyncError> {
		if self.rx_run <= 0 || self.rx_token >= MAX_TOKEN_INDEX {
			return Err(invalid_token());
		}
		self.rx_token += 1;
		self.rx_run -= 1;
		if self.rx_run == 0 {
			self.state = RecvState::Idle;
		}
		Ok(Step::Block(self.rx_token as u32))
	}

	fn ensure_inflate(&mut self) -> &mut Decompress {
		let out = avail_out_size(consts::CHUNK_SIZE);
		if self.data.len() < out {
			self.data.resize(out, 0);
		}
		self.inflate.get_or_insert_with(|| Decompress::new_with_window_bits(false, 15))
	}

	fn inflate_step(&mut self, r: &mut dyn io::Read) -> Result<Step, RsyncError> {
		loop {
			match self.state {
				RecvState::Init => {
					if self.inflate.is_some() {
						self.ensure_inflate().reset(false);
					} else {
						self.ensure_inflate();
					}
					self.state = RecvState::Idle;
					self.rx_token = 0;
				},
				RecvState::Idle | RecvState::Inflated => {
					let flag = self.read_flag(r)?;
					if flag & 0xc0 == DEFLATED_DATA {
						self.read_frame(r, flag)?;
						continue;
					}
					if self.state == RecvState::Inflated {
						let out = avail_out_size(consts::CHUNK_SIZE);
						let Self { inflate, data, .. } = self;
						let Some(inflate) = inflate.as_mut() else { return Err(invalid_token()) };
						let before = inflate.total_out();
						let result = inflate.decompress(&[], &mut data[..out], FlushDecompress::Sync);
						let n = (inflate.total_out() - before) as usize;
						let code = zlib_code(&result);
						if code != 0 && code != -5 {
							return Err(decode_error(
								format!("inflate flush returned {code} ({n} bytes)"),
								628,
							));
						}
						if n != 0 && code != -5 {
							self.saved_flag = Some(flag);
							return Ok(Step::Data(n));
						}
						// The sender trimmed the sync flush's empty stored block;
						// supply it, which must complete without output.
						let (in_before, out_before) = (inflate.total_in(), inflate.total_out());
						let result = inflate.decompress(&SYNC_MARKER, &mut data[..out], FlushDecompress::Sync);
						if result.is_err()
							|| inflate.total_in() - in_before != SYNC_MARKER.len() as u64
							|| inflate.total_out() != out_before
						{
							return Err(decode_error("decompressor lost sync!".into(), 643));
						}
						self.state = RecvState::Idle;
					}
					if flag == END_FLAG {
						self.state = RecvState::Init;
						return Ok(Step::End);
					}
					return self.token_num(r, flag);
				},
				RecvState::Inflating => {
					let out = avail_out_size(consts::CHUNK_SIZE);
					let Self { inflate, data, cbuf, cpos, clen, state, .. } = self;
					let Some(inflate) = inflate.as_mut() else { return Err(invalid_token()) };
					let (in_before, out_before) = (inflate.total_in(), inflate.total_out());
					let result = inflate.decompress(&cbuf[*cpos..*clen], &mut data[..out], FlushDecompress::None);
					let n = (inflate.total_out() - out_before) as usize;
					*cpos += (inflate.total_in() - in_before) as usize;
					let code = zlib_code(&result);
					if code != 0 {
						return Err(decode_error(format!("inflate returned {code} ({n} bytes)"), 668));
					}
					if *cpos == *clen {
						*state = RecvState::Inflated;
					}
					if n != 0 {
						return Ok(Step::Data(n));
					}
				},
				RecvState::Running => return self.run_step(),
			}
		}
	}

	/// Inflates `data` as stored blocks so it lands in the history window.
	fn insert_history(&mut self, data: &[u8]) -> Result<(), RsyncError> {
		let proto_version = self.proto_version;
		self.ensure_inflate();
		let out = avail_out_size(consts::CHUNK_SIZE);
		let Self { inflate, data: scratch, .. } = self;
		let Some(inflate) = inflate.as_mut() else { return Err(invalid_token()) };
		let mut offset = 0;
		let mut left = data.len();
		while left > 0 {
			let n = left.min(MAX_STORED_LEN);
			let header = [0, n as u8, (n >> 8) as u8, !(n as u8), !((n >> 8) as u8)];
			inflate_all(inflate, &header, &mut scratch[..out])?;
			inflate_all(inflate, &data[offset..offset + n], &mut scratch[..out])?;
			left -= n;
			if proto_version >= 31 {
				offset += n;
			}
		}
		Ok(())
	}

	fn zstd_step(&mut self, r: &mut dyn io::Read) -> Result<Step, RsyncError> {
		if self.zstd.is_none() {
			let dctx = DCtx::try_create().ok_or_else(|| {
				RsyncError::new(exit::RERR_PROTOCOL, "ZSTD_createDStream failed").at("token.c", 850)
			})?;
			self.zstd = Some(dctx);
			self.data.resize(DCtx::out_size() * 2, 0);
		}
		loop {
			match self.state {
				RecvState::Init => {
					self.state = RecvState::Idle;
					self.rx_token = 0;
				},
				RecvState::Idle | RecvState::Inflated => {
					let flag = self.read_flag(r)?;
					if flag & 0xc0 == DEFLATED_DATA {
						self.read_frame(r, flag)?;
						continue;
					}
					if flag == END_FLAG {
						self.state = RecvState::Init;
						return Ok(Step::End);
					}
					return self.token_num(r, flag);
				},
				RecvState::Inflating => {
					let Self { zstd, data, cbuf, cpos, clen, state, .. } = self;
					let Some(dctx) = zstd.as_mut() else { return Err(invalid_token()) };
					let out_size = data.len();
					let mut input = InBuffer { src: &cbuf[..*clen], pos: *cpos };
					let mut output = OutBuffer::around(&mut data[..]);
					let result = dctx.decompress_stream(&mut output, &mut input);
					let n = output.pos();
					*cpos = input.pos;
					if let Err(code) = result {
						return Err(decode_error(
							format!("ZSTD decomp returned {} ({n} bytes)", code as i32),
							903,
						));
					}
					if *cpos == *clen && n < out_size {
						*state = RecvState::Idle;
					}
					if n != 0 {
						return Ok(Step::Data(n));
					}
				},
				RecvState::Running => return self.run_step(),
			}
		}
	}

	fn lz4_step(&mut self, r: &mut dyn io::Read) -> Result<Step, RsyncError> {
		let size = lz4_flex::block::get_maximum_output_size(consts::CHUNK_SIZE).max(MAX_DATA_COUNT + 2);
		if self.data.len() < size {
			self.data.resize(size, 0);
		}
		loop {
			match self.state {
				RecvState::Init => {
					self.state = RecvState::Idle;
					self.rx_token = 0;
				},
				RecvState::Idle | RecvState::Inflated => {
					let flag = self.read_flag(r)?;
					if flag & 0xc0 == DEFLATED_DATA {
						self.read_frame(r, flag)?;
						continue;
					}
					if flag == END_FLAG {
						self.state = RecvState::Init;
						return Ok(Step::End);
					}
					return self.token_num(r, flag);
				},
				RecvState::Inflating => {
					let n = lz4_flex::block::decompress_into(&self.cbuf[..self.clen], &mut self.data[..size])
						.map_err(|_| decode_error("uncompress failed: -1".into(), 1047))?;
					self.state = RecvState::Idle;
					// An empty block is not end-of-file; skip it.
					if n != 0 {
						return Ok(Step::Data(n));
					}
				},
				RecvState::Running => return self.run_step(),
			}
		}
	}
}

/// Inflates all of `input` (with sync flushes), discarding the output.
fn inflate_all(inflate: &mut Decompress, input: &[u8], scratch: &mut [u8]) -> Result<(), RsyncError> {
	let mut pos = 0;
	loop {
		let (in_before, out_before) = (inflate.total_in(), inflate.total_out());
		let result = inflate.decompress(&input[pos..], scratch, FlushDecompress::Sync);
		let code = zlib_code(&result);
		if code != 0 && code != -5 {
			return Err(decode_error(format!("inflate (token) returned {code}"), 724));
		}
		let consumed = (inflate.total_in() - in_before) as usize;
		let produced = (inflate.total_out() - out_before) as usize;
		pos += consumed;
		if pos == input.len() && produced < scratch.len() {
			return Ok(());
		}
		if consumed == 0 && produced == 0 {
			return Err(decode_error("inflate (token) returned -5".into(), 724));
		}
	}
}


