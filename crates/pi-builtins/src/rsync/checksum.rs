//! Rolling and strong checksums, sum headers, and checksum-name negotiation.
//!
//! Everything here is wire-visible: the rolling checksum and every strong
//! digest must produce exactly the bytes rsync 3.5.1 produces for the same
//! algorithm, seed and protocol, including the quirks of the legacy MD4
//! variants that pre-3.0 peers used.

use std::io::{self, Read, Write};

use md5::{Digest, Md5};
use sha1::Sha1;
use xxhash_rust::{
	xxh3::{Xxh3Default, xxh3_64_with_seed, xxh3_128_with_seed},
	xxh64::{Xxh64, xxh64},
};

use crate::rsync::{
	cstr::is_c_space,
	consts,
	exit::{self, RsyncError},
	log::Role,
	wire::{Proto, ReadExt, WriteExt},
};

/// Bias of the strong-sum length heuristic (`BLOCKSUM_BIAS`).
const BLOCKSUM_BIAS: i32 = 10;

/// The longest digest any [`CsumType`] produces.
pub(crate) const MAX_CSUM_LEN: usize = 20;

/// Strong-checksum algorithms (upstream CSUM_* + names used in negotiation).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CsumType {
	None,
	/// MD4 as used before protocol 21 (no final padding for 64-byte multiples).
	Md4Archaic,
	/// MD4 as used by protocols 21–26 (same padding bug as archaic).
	Md4Busted,
	/// MD4 for protocols 27–29: correct digest, seed mixed into file sums.
	Md4Old,
	Md4,
	Md5,
	Sha1,
	Xxh64,
	Xxh3,
	Xxh128,
}

impl CsumType {
	/// Digest length in bytes (`csum_len_for_type(type, 0)`).
	pub(crate) const fn digest_len(self) -> usize {
		match self {
			Self::None => 1,
			Self::Md4Archaic | Self::Md4Busted | Self::Md4Old | Self::Md4 | Self::Md5 => 16,
			Self::Sha1 => 20,
			Self::Xxh64 | Self::Xxh3 => 8,
			Self::Xxh128 => 16,
		}
	}

	/// Length of the file-list checksum (`csum_len_for_type(type, 1)`): the archaic
	/// MD4 variant only ever sent 2 bytes there.
	pub(crate) const fn flist_len(self) -> usize {
		match self {
			Self::Md4Archaic => 2,
			other => other.digest_len(),
		}
	}

	/// Negotiation name (the legacy MD4 variants all call themselves "md4").
	pub(crate) fn name(self) -> &'static str {
		match self {
			Self::None => "none",
			Self::Md4Archaic | Self::Md4Busted | Self::Md4Old | Self::Md4 => "md4",
			Self::Md5 => "md5",
			Self::Sha1 => "sha1",
			Self::Xxh64 => "xxh64",
			Self::Xxh3 => "xxh3",
			Self::Xxh128 => "xxh128",
		}
	}

	/// Case-insensitive lookup of a checksum name (including the "xxhash" alias).
	pub(crate) fn from_name(name: &str) -> Option<Self> {
		CHECKSUM_NAMES.lookup(name.as_bytes()).and_then(|entry| Self::from_num(entry.num))
	}

	/// Pre-negotiation default for a protocol version (and whether a seed fix applies).
	///
	/// Protocol 30+ uses MD5; whether its block sums put the seed first or last is
	/// decided by [`Proto::has`]`(CF_CHKSUM_SEED_FIX)` when hashing (see [`Strong`]).
	pub(crate) fn default_for(proto: Proto) -> Self {
		match proto.version {
			30.. => Self::Md5,
			27..=29 => Self::Md4Old,
			21..=26 => Self::Md4Busted,
			_ => Self::Md4Archaic,
		}
	}

	/// Upstream's CSUM_* number (the negotiation table key).
	const fn num(self) -> u8 {
		match self {
			Self::None => 0,
			Self::Md4Archaic => 1,
			Self::Md4Busted => 2,
			Self::Md4Old => 3,
			Self::Md4 => 4,
			Self::Md5 => 5,
			Self::Xxh64 => 6,
			Self::Xxh3 => 7,
			Self::Xxh128 => 8,
			Self::Sha1 => 9,
		}
	}

	const fn from_num(num: u8) -> Option<Self> {
		Some(match num {
			0 => Self::None,
			1 => Self::Md4Archaic,
			2 => Self::Md4Busted,
			3 => Self::Md4Old,
			4 => Self::Md4,
			5 => Self::Md5,
			6 => Self::Xxh64,
			7 => Self::Xxh3,
			8 => Self::Xxh128,
			9 => Self::Sha1,
			_ => return None,
		})
	}
}

/// `--checksum-choice` / RSYNC_CHECKSUM_LIST parsing and the negotiation string.
///
/// `None` for a half means "auto": negotiate (or use the protocol default).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ChecksumChoice {
	pub xfer: Option<CsumType>,
	pub file: Option<CsumType>,
}

impl ChecksumChoice {
	/// Parses `--checksum-choice=STR` (`NAME`, `XFER,FILE`, `auto`).
	///
	/// The error is upstream's message without its newline (`unknown checksum
	/// name: …`); upstream reports it with RERR_UNSUPPORTED at checksum.c(157).
	/// Like upstream, an unknown first half echoes the whole remaining argument.
	pub(crate) fn parse(arg: &str) -> Result<Self, String> {
		let unknown = |shown: &str| format!("unknown checksum name: {shown}");
		let one = |name: &str, shown: &str| -> Result<Option<CsumType>, String> {
			if name.eq_ignore_ascii_case("auto") {
				return Ok(None);
			}
			CsumType::from_name(name).map(Some).ok_or_else(|| unknown(shown))
		};
		match arg.split_once(',') {
			Some((xfer, file)) => Ok(Self { xfer: one(xfer, arg)?, file: one(file, file)? }),
			None => {
				let kind = one(arg, arg)?;
				Ok(Self { xfer: kind, file: kind })
			},
		}
	}

	/// Both halves after "auto" resolution for the negotiated protocol (when no
	/// negotiation took place).
	pub(crate) fn resolve(self, proto: Proto) -> (CsumType, CsumType) {
		let auto = CsumType::default_for(proto);
		(self.xfer.unwrap_or(auto), self.file.unwrap_or(auto))
	}
}

/// One negotiable algorithm name (upstream `name_num_item`).
pub(crate) struct NameNum {
	/// Name as it may appear on the wire or in an env list.
	pub name: &'static str,
	/// Canonical name this entry stands for (differs for aliases such as "xxhash").
	pub main: &'static str,
	/// Upstream algorithm number (CSUM_* / CPRES_*).
	pub num: u8,
}

/// A negotiation table (upstream `name_num_obj`), strongest first.
pub(crate) struct NameTable {
	/// Names in preference order, aliases after their main entry.
	pub entries: &'static [NameNum],
}

/// The checksum negotiation table of a build with xxhash, xxh3 and openssl.
pub(crate) static CHECKSUM_NAMES: NameTable = NameTable {
	entries: &[
		NameNum { name: "xxh128", main: "xxh128", num: 8 },
		NameNum { name: "xxh3", main: "xxh3", num: 7 },
		NameNum { name: "xxh64", main: "xxh64", num: 6 },
		NameNum { name: "xxhash", main: "xxh64", num: 6 },
		NameNum { name: "md5", main: "md5", num: 5 },
		NameNum { name: "md4", main: "md4", num: 4 },
		NameNum { name: "sha1", main: "sha1", num: 9 },
		NameNum { name: "none", main: "none", num: 0 },
	],
};

impl NameTable {
	/// Case-insensitive exact-length name lookup (`get_nni_by_name`).
	pub(crate) fn lookup(&self, name: &[u8]) -> Option<&'static NameNum> {
		self.entries.iter().find(|e| e.name.as_bytes().eq_ignore_ascii_case(name))
	}

	/// Size of the rank array: one past the largest algorithm number. A rank equal
	/// to this value can never win a negotiation (an upstream quirk that makes the
	/// fifth entry of a compress list unselectable).
	fn saw_len(&self) -> usize {
		self.entries.iter().map(|e| usize::from(e.num) + 1).max().unwrap_or(0)
	}

	/// The built-in list (`get_default_nno_list`): aliases dropped, and "none"
	/// omitted unless we are the server.
	pub(crate) fn default_list(&self, am_server: bool) -> Vec<&'static str> {
		self.entries
			.iter()
			.filter(|e| e.name == e.main && (am_server || e.num != 0))
			.map(|e| e.name)
			.collect()
	}

	/// Simplifies a user list (`parse_nni_str`): whitespace-separated, stops at '&',
	/// unknown names and duplicates dropped, aliases canonicalized. A list that named
	/// something but kept nothing becomes `["INVALID"]`.
	pub(crate) fn parse_list(&self, list: &str) -> Vec<&'static str> {
		let list = list.as_bytes();
		let list = &list[..memchr::memchr(b'&', list).unwrap_or(list.len())];
		let mut seen = [false; 256];
		let mut out = Vec::new();
		let mut saw_token = false;
		for token in list.split(|&b| is_c_space(b)).filter(|t| !t.is_empty()) {
			saw_token = true;
			if let Some(entry) = self.lookup(token)
				&& !seen[usize::from(entry.num)]
			{
				seen[usize::from(entry.num)] = true;
				out.push(entry.main);
			}
		}
		if saw_token && out.is_empty() {
			out.push("INVALID");
		}
		out
	}

	/// The list we send (`send_negotiate_str`): the env override when it yields a
	/// non-empty list, else the built-in default. On the server only the text after
	/// the first '&' of the env value counts; on the client the text before it.
	pub(crate) fn list(&self, env_override: Option<&str>, am_server: bool) -> Vec<&'static str> {
		if let Some(env) = env_override.map(|env| server_part(env, am_server))
			&& !env.is_empty()
		{
			let parsed = self.parse_list(env);
			if !parsed.is_empty() {
				return parsed;
			}
		}
		self.default_list(am_server)
	}

	/// 1-based preference ranks of `ours`, indexed by algorithm number.
	fn ranks(&self, ours: &[&str]) -> [u8; 256] {
		let mut saw = [0u8; 256];
		let mut cnt = 0u8;
		for name in ours {
			if let Some(entry) = self.lookup(name.as_bytes())
				&& saw[usize::from(entry.num)] == 0
			{
				cnt = cnt.saturating_add(1);
				saw[usize::from(entry.num)] = cnt;
			}
		}
		saw
	}

	/// Our most preferred name that the peer listed (`parse_negotiate_str`).
	pub(crate) fn pick(&self, ours: &[&str], theirs: &[u8]) -> Option<&'static str> {
		let saw = self.ranks(ours);
		let mut best = self.saw_len();
		let mut chosen = None;
		for token in theirs.split(|&b| b == b' ').filter(|t| !t.is_empty()) {
			let Some(entry) = self.lookup(token) else { continue };
			let rank = usize::from(saw[usize::from(entry.num)]);
			if rank == 0 || best <= rank {
				continue;
			}
			best = rank;
			chosen = Some(entry.main);
			if best == 1 {
				break;
			}
		}
		chosen
	}

	/// Server-side check that an explicit choice is in the env list
	/// (`validate_choice_vs_env`); `nums` are the chosen algorithm numbers and
	/// `md4_family` lets "md4" admit the legacy MD4 variants.
	pub(crate) fn env_allows(&self, env_override: Option<&str>, nums: &[u8], md4_family: bool) -> bool {
		let Some(env) = env_override else { return true };
		let env = server_part(env, true).trim_start_matches(|c: char| c.is_ascii() && is_c_space(c as u8));
		if env.is_empty() {
			return true;
		}
		let parsed = self.parse_list(env);
		let mut saw = self.ranks(&parsed);
		if md4_family {
			let md4 = saw[usize::from(CsumType::Md4.num())];
			for kind in [CsumType::Md4Archaic, CsumType::Md4Busted, CsumType::Md4Old] {
				saw[usize::from(kind.num())] = md4;
			}
		}
		nums.iter().all(|&n| saw[usize::from(n)] != 0)
	}
}

/// The part of an RSYNC_*_LIST value a role uses: after the first '&' on the server.
fn server_part(env: &str, am_server: bool) -> &str {
	match env.split_once('&') {
		Some((_, after)) if am_server => after,
		_ => env,
	}
}

/// Our preference list as sent in negotiation (env override aware).
///
/// `am_server` matters: the client omits "none" from its default list and reads
/// the env value before '&'; the server reads it after '&'. When writing a batch
/// file the caller passes upstream's forced list ("md5", or "md4" before protocol
/// 30) as `env_override`.
pub(crate) fn checksum_list(env_override: Option<&str>, am_server: bool) -> Vec<&'static str> {
	CHECKSUM_NAMES.list(env_override, am_server)
}

/// Picks the negotiated algorithm exactly like upstream (`negotiate_the_strings`).
///
/// Works for both checksum and compression lists: each side independently takes
/// its own most-preferred name that also appears in the peer's list. Returns the
/// canonical name. `we_are_server` does not change the choice (it only affects
/// which side reports a failure, see [`negotiate_failure`]).
pub(crate) fn pick(ours: &[&str], theirs: &[u8], _we_are_server: bool) -> Option<String> {
	table_for(ours).pick(ours, theirs).map(str::to_owned)
}

/// The table `ours` was drawn from (compression names other than "none" are
/// never checksum names).
fn table_for(ours: &[&str]) -> &'static NameTable {
	let compress = &crate::rsync::token::COMPRESS_NAMES;
	let is_compress = ours.iter().any(|name| {
		compress.lookup(name.as_bytes()).is_some() && CHECKSUM_NAMES.lookup(name.as_bytes()).is_none()
	});
	if is_compress { compress } else { &CHECKSUM_NAMES }
}

/// Failure of a negotiation (`recv_negotiate_str`): RERR_UNSUPPORTED at
/// compat.c(406). `what` is "checksum" or "compress"; `theirs` is the list as
/// received. A server in a negotiating session exits without a message.
pub(crate) fn negotiate_failure(
	what: &str,
	ours: &[&str],
	theirs: &[u8],
	am_server: bool,
	negotiated_strings: bool,
) -> RsyncError {
	let message = (!am_server || !negotiated_strings).then(|| {
		let (peer, us) = if am_server { ("Client", "Server") } else { ("Server", "Client") };
		let table = table_for(ours);
		let mut mine: String = ours
			.iter()
			.filter_map(|name| table.lookup(name.as_bytes()))
			.map(|entry| format!(" {}", entry.main))
			.collect();
		if mine.is_empty() {
			mine.push_str(" INVALID");
		}
		format!(
			"Failed to negotiate a {what} choice.\n{peer} list: {}\n{us} list:{mine}",
			String::from_utf8_lossy(theirs)
		)
	});
	let mut err = RsyncError::new(exit::RERR_UNSUPPORTED, String::new()).at("compat.c", 406);
	err.message = message;
	err
}

/// Server-side `--checksum-choice` check against RSYNC_CHECKSUM_LIST (the part
/// after '&'): listing "md4" also admits the legacy MD4 variants.
pub(crate) fn checksum_env_allows(env_override: Option<&str>, xfer: CsumType, file: CsumType) -> bool {
	CHECKSUM_NAMES.env_allows(env_override, &[xfer.num(), file.num()], true)
}

/// "Your --<what>-choice value (<choice>) was refused by the server."
/// (RERR_UNSUPPORTED at compat.c(450)).
pub(crate) fn choice_refused(what: &str, choice: &str) -> RsyncError {
	RsyncError::new(
		exit::RERR_UNSUPPORTED,
		format!("Your --{what}-choice value ({choice}) was refused by the server."),
	)
	.at("compat.c", 450)
}

/// Upstream get_checksum1 (CHAR_OFFSET 0): bytes are summed as signed chars.
pub(crate) fn checksum1(buf: &[u8]) -> u32 {
	let (s1, s2) = sums(buf);
	(s1 & 0xffff) | (s2 << 16)
}

fn sums(buf: &[u8]) -> (u32, u32) {
	let mut s1: u32 = 0;
	let mut s2: u32 = 0;
	for &b in buf {
		s1 = s1.wrapping_add(signed(b));
		s2 = s2.wrapping_add(s1);
	}
	(s1, s2)
}

/// A byte as the C `schar` value, widened modulo 2^32.
const fn signed(b: u8) -> u32 {
	b as i8 as i32 as u32
}

/// Rolling form of checksum1 over a sliding window.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Rolling {
	s1: u32,
	s2: u32,
	len: u32,
}

impl Rolling {
	/// Checksum of `window`, ready to slide.
	pub(crate) fn new(window: &[u8]) -> Self {
		let (s1, s2) = sums(window);
		Self { s1, s2, len: u32::try_from(window.len()).unwrap_or(u32::MAX) }
	}

	/// Slides the window one byte: drops `out` (the first byte), appends `inp`.
	pub(crate) fn roll(&mut self, out: u8, inp: u8) {
		let out = signed(out);
		self.s1 = self.s1.wrapping_sub(out).wrapping_add(signed(inp));
		self.s2 = self.s2.wrapping_sub(self.len.wrapping_mul(out)).wrapping_add(self.s1);
	}

	/// Drops the first byte without appending (the window shrinks at EOF).
	pub(crate) fn rollout(&mut self, out: u8) {
		let out = signed(out);
		self.s1 = self.s1.wrapping_sub(out);
		self.s2 = self.s2.wrapping_sub(self.len.wrapping_mul(out));
		self.len = self.len.saturating_sub(1);
	}

	/// Current checksum1 value.
	pub(crate) fn value(&self) -> u32 {
		(self.s1 & 0xffff) | (self.s2 << 16)
	}
}

/// MD4 (RFC 1320) with the hooks rsync's legacy variants need: an unpadded
/// result for 64-byte-aligned input and a 32-bit bit count before protocol 27.
#[derive(Clone)]
struct Md4 {
	state: [u32; 4],
	block: [u8; 64],
	filled: usize,
	total: u64,
	short_bit_count: bool,
}

impl Md4 {
	fn new(proto_version: u32) -> Self {
		Self {
			state: [0x6745_2301, 0xefcd_ab89, 0x98ba_dcfe, 0x1032_5476],
			block: [0; 64],
			filled: 0,
			total: 0,
			short_bit_count: proto_version < 27,
		}
	}

	fn update(&mut self, mut data: &[u8]) {
		self.total = self.total.wrapping_add(data.len() as u64);
		if self.filled > 0 {
			let take = (64 - self.filled).min(data.len());
			self.block[self.filled..self.filled + take].copy_from_slice(&data[..take]);
			self.filled += take;
			data = &data[take..];
			if self.filled < 64 {
				return;
			}
			let block = self.block;
			md4_compress(&mut self.state, &block);
			self.filled = 0;
		}
		let (blocks, rest) = data.as_chunks::<64>();
		for block in blocks {
			md4_compress(&mut self.state, block);
		}
		self.block[..rest.len()].copy_from_slice(rest);
		self.filled = rest.len();
	}

	/// The digest. With `legacy_tail` set, input that ended on a 64-byte boundary
	/// is not padded at all (the pre-protocol-27 bug).
	fn finish(mut self, legacy_tail: bool) -> [u8; 16] {
		if !(legacy_tail && self.filled == 0) {
			let mut bits = self.total.wrapping_mul(8);
			if self.short_bit_count {
				bits &= 0xffff_ffff;
			}
			let mut pad = [0u8; 72];
			pad[0] = 0x80;
			let pad_len = if self.filled < 56 { 56 - self.filled } else { 120 - self.filled };
			pad[pad_len..pad_len + 8].copy_from_slice(&bits.to_le_bytes());
			self.update(&pad[..pad_len + 8]);
		}
		let mut out = [0u8; 16];
		for (dst, word) in out.as_chunks_mut::<4>().0.iter_mut().zip(self.state) {
			*dst = word.to_le_bytes();
		}
		out
	}
}

fn md4_compress(state: &mut [u32; 4], block: &[u8; 64]) {
	let mut x = [0u32; 16];
	for (word, &bytes) in x.iter_mut().zip(block.as_chunks::<4>().0) {
		*word = u32::from_le_bytes(bytes);
	}
	let [mut a, mut b, mut c, mut d] = *state;
	const ROUND2: u32 = 0x5a82_7999;
	const ROUND3: u32 = 0x6ed9_eba1;
	const ORDER3: [usize; 16] = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];
	for i in 0..16 {
		let f = (b & c) | (!b & d);
		let t = a.wrapping_add(f).wrapping_add(x[i]).rotate_left([3, 7, 11, 19][i % 4]);
		(a, b, c, d) = (d, t, b, c);
	}
	for i in 0..16 {
		let g = (b & c) | (b & d) | (c & d);
		let k = (i % 4) * 4 + i / 4;
		let t = a.wrapping_add(g).wrapping_add(x[k]).wrapping_add(ROUND2).rotate_left([3, 5, 9, 13][i % 4]);
		(a, b, c, d) = (d, t, b, c);
	}
	for i in 0..16 {
		let h = b ^ c ^ d;
		let t = a
			.wrapping_add(h)
			.wrapping_add(x[ORDER3[i]])
			.wrapping_add(ROUND3)
			.rotate_left([3, 9, 11, 15][i % 4]);
		(a, b, c, d) = (d, t, b, c);
	}
	state[0] = state[0].wrapping_add(a);
	state[1] = state[1].wrapping_add(b);
	state[2] = state[2].wrapping_add(c);
	state[3] = state[3].wrapping_add(d);
}

/// Block (get_checksum2) and whole-file (sum_init/update/end) digests.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Strong {
	pub kind: CsumType,
	pub seed: i32,
	pub proto: Proto,
}

impl Strong {
	/// Strong sum of one block; full `digest_len`, callers truncate to s2length.
	pub(crate) fn block(&self, data: &[u8]) -> Vec<u8> {
		let mut out = [0u8; MAX_CSUM_LEN];
		let len = self.block_into(data, &mut out);
		out[..len].to_vec()
	}

	/// Allocation-free [`Strong::block`]: writes the digest into the front of
	/// `out` and returns its length.
	pub(crate) fn block_into(&self, data: &[u8], out: &mut [u8; MAX_CSUM_LEN]) -> usize {
		let seed = self.seed.to_le_bytes();
		let seeded = self.seed != 0;
		let xxh_seed = i64::from(self.seed) as u64;
		match self.kind {
			CsumType::None => out[0] = 0,
			CsumType::Xxh64 => out[..8].copy_from_slice(&xxh64(data, xxh_seed).to_le_bytes()),
			CsumType::Xxh3 => {
				out[..8].copy_from_slice(&xxh3_64_with_seed(data, xxh_seed).to_le_bytes());
			},
			CsumType::Xxh128 => {
				out[..16].copy_from_slice(&xxh3_128_with_seed(data, xxh_seed).to_le_bytes());
			},
			CsumType::Md5 => {
				// The seed goes first unless a protocol-30+ peer lacks the seed-order fix.
				let seed_first =
					self.proto.version < 30 || self.proto.has(consts::CF_CHKSUM_SEED_FIX);
				let mut md = Md5::new();
				if seeded && seed_first {
					md.update(seed);
				}
				md.update(data);
				if seeded && !seed_first {
					md.update(seed);
				}
				out[..16].copy_from_slice(&md.finalize());
			},
			CsumType::Sha1 => {
				let mut sha = Sha1::new();
				if seeded {
					sha.update(seed);
				}
				sha.update(data);
				out[..20].copy_from_slice(&sha.finalize());
			},
			CsumType::Md4 | CsumType::Md4Old | CsumType::Md4Busted | CsumType::Md4Archaic => {
				let mut md = Md4::new(self.proto.version);
				md.update(data);
				if seeded {
					md.update(&seed);
				}
				out[..16].copy_from_slice(&md.finish(legacy_md4_tail(self.kind)));
			},
		}
		self.kind.digest_len()
	}

	/// Whole-file digest accumulator seeded like upstream's sum_init: only the
	/// legacy MD4 variants mix the seed in (always, even a zero seed).
	pub(crate) fn file(&self) -> FileDigest {
		let mut digest = FileDigest::new(self.kind, self.proto);
		if matches!(self.kind, CsumType::Md4Old | CsumType::Md4Busted | CsumType::Md4Archaic) {
			digest.update(&self.seed.to_le_bytes());
		}
		digest
	}
}

/// Whether an MD4 variant skips padding for 64-byte-aligned input.
const fn legacy_md4_tail(kind: CsumType) -> bool {
	matches!(kind, CsumType::Md4Busted | CsumType::Md4Archaic)
}

/// A running whole-file digest.
pub(crate) struct FileDigest {
	kind: CsumType,
	state: DigestState,
}

enum DigestState {
	None,
	Md4(Md4),
	Md5(Md5),
	Sha1(Sha1),
	Xxh64(Xxh64),
	Xxh3(Box<Xxh3Default>),
}

impl FileDigest {
	/// An unseeded accumulator.
	fn new(kind: CsumType, proto: Proto) -> Self {
		let state = match kind {
			CsumType::None => DigestState::None,
			CsumType::Md4 | CsumType::Md4Old | CsumType::Md4Busted | CsumType::Md4Archaic => {
				DigestState::Md4(Md4::new(proto.version))
			},
			CsumType::Md5 => DigestState::Md5(Md5::new()),
			CsumType::Sha1 => DigestState::Sha1(Sha1::new()),
			CsumType::Xxh64 => DigestState::Xxh64(Xxh64::new(0)),
			CsumType::Xxh3 | CsumType::Xxh128 => DigestState::Xxh3(Box::new(Xxh3Default::new())),
		};
		Self { kind, state }
	}

	/// Feeds data (sum_update).
	pub(crate) fn update(&mut self, data: &[u8]) {
		match &mut self.state {
			DigestState::None => {},
			DigestState::Md4(md) => md.update(data),
			DigestState::Md5(md) => md.update(data),
			DigestState::Sha1(sha) => sha.update(data),
			DigestState::Xxh64(xxh) => xxh.update(data),
			DigestState::Xxh3(xxh) => xxh.update(data),
		}
	}

	/// The digest (sum_end), `kind.digest_len()` bytes.
	pub(crate) fn finish(self) -> Vec<u8> {
		match self.state {
			DigestState::None => vec![0],
			DigestState::Md4(md) => md.finish(legacy_md4_tail(self.kind)).to_vec(),
			DigestState::Md5(md) => md.finalize().to_vec(),
			DigestState::Sha1(sha) => sha.finalize().to_vec(),
			DigestState::Xxh64(xxh) => xxh.digest().to_le_bytes().to_vec(),
			DigestState::Xxh3(xxh) if self.kind == CsumType::Xxh128 => {
				xxh.digest128().to_le_bytes().to_vec()
			},
			DigestState::Xxh3(xxh) => xxh.digest().to_le_bytes().to_vec(),
		}
	}
}

/// Whole-file checksum of a local file for `--checksum` (file_checksum).
///
/// Upstream never seeds these digests, so `_seed` is unused; the legacy MD4
/// variants keep their aligned-input padding quirk. Reads `reader` to EOF.
pub(crate) fn file_checksum(
	kind: CsumType,
	_seed: i32,
	proto: Proto,
	reader: &mut dyn Read,
) -> io::Result<Vec<u8>> {
	let mut digest = FileDigest::new(kind, proto);
	let mut buf = [0u8; 32 * 1024];
	loop {
		match reader.read(&mut buf) {
			Ok(0) => break,
			Ok(n) => digest.update(&buf[..n]),
			Err(err) if err.kind() == io::ErrorKind::Interrupted => {},
			Err(err) => return Err(err),
		}
	}
	Ok(digest.finish())
}

/// The sum header (count, block length, strong length, remainder).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct SumHead {
	pub count: i32,
	pub blength: i32,
	pub s2length: i32,
	pub remainder: i32,
}

impl SumHead {
	

	/// sum_sizes_sqroot with an explicit `csum_length` (SUM_LENGTH in the redo pass).
	pub(crate) fn sized(
		len: i64,
		block_size_opt: u32,
		proto: Proto,
		xfer_sum_len: usize,
		csum_length: i32,
	) -> Self {
		if len < 0 {
			return Self { count: -1, ..Self::default() };
		}
		let sum_length = consts::SUM_LENGTH as i32;
		let max_s2length = sum_length.min(i32::try_from(xfer_sum_len).unwrap_or(i32::MAX));
		let block_size = i64::from(consts::BLOCK_SIZE);
		let blength: i64 = if block_size_opt != 0 {
			i64::from(block_size_opt)
		} else if len <= block_size * block_size {
			block_size
		} else {
			let max_blength = max_block_len(proto);
			let mut c: i64 = 1;
			let mut l = len >> 2;
			while l != 0 {
				c <<= 1;
				l >>= 2;
			}
			if c >= max_blength {
				max_blength
			} else {
				// Largest multiple of 8 whose square does not exceed len.
				let mut b: i64 = 0;
				while c >= 8 {
					b |= c;
					if len < b * b {
						b &= !c;
					}
					c >>= 1;
				}
				b.max(block_size)
			}
		};

		let s2length = if csum_length == sum_length {
			max_s2length
		} else {
			let mut bits = BLOCKSUM_BIAS;
			let mut l = len >> 1;
			while l != 0 {
				bits += 2;
				l >>= 1;
			}
			let mut c = blength >> 1;
			while c != 0 && bits != 0 {
				bits -= 1;
				c >>= 1;
			}
			// Add a bit, subtract the 32 rolling-sum bits, round up to bytes.
			((bits + 1 - 32 + 7) / 8).max(csum_length).min(max_s2length)
		};

		let remainder = len % blength;
		let count = len / blength + i64::from(remainder != 0);
		Self {
			count: i32::try_from(count).unwrap_or(-1),
			blength: i32::try_from(blength).unwrap_or(i32::MAX),
			s2length,
			remainder: remainder as i32,
		}
	}

	/// Length of block `index` (the last one may be the remainder).
	pub(crate) fn block_len(&self, index: i32) -> i32 {
		if index == self.count - 1 && self.remainder != 0 { self.remainder } else { self.blength }
	}

	/// Total file length these sums describe.
	pub(crate) fn flength(&self) -> i64 {
		if self.count <= 0 {
			return 0;
		}
		let full = i64::from(self.count) * i64::from(self.blength);
		if self.remainder != 0 { full - i64::from(self.blength) + i64::from(self.remainder) } else { full }
	}

	/// Reads and validates a sum header (read_sum_head), reporting as the sender.
	pub(crate) fn read(r: &mut dyn Read, proto: Proto, xfer_sum_len: usize) -> Result<Self, RsyncError> {
		Self::read_as(r, proto, xfer_sum_len, Role::Sender)
	}

	/// [`SumHead::read`] with the role named in the error messages (who_am_i).
	/// Rejects negative fields, oversize block or strong lengths, a remainder
	/// beyond the block length, and a zero block length with a non-zero count
	/// (CVE-2026-53792), all with RERR_PROTOCOL.
	pub(crate) fn read_as(
		r: &mut dyn Read,
		proto: Proto,
		xfer_sum_len: usize,
		who: Role,
	) -> Result<Self, RsyncError> {
		let who = who.name();
		let fail = |message: String, line: u32| -> Result<Self, RsyncError> {
			Err(RsyncError::new(exit::RERR_PROTOCOL, message).at("io.c", line))
		};

		let count = read_i32(r)?;
		if count < 0 {
			return fail(format!("Invalid checksum count {count} [{who}]"), 2240);
		}
		let blength = read_i32(r)?;
		if blength < 0 || i64::from(blength) > max_block_len(proto) {
			return fail(format!("Invalid block length {blength} [{who}]"), 2261);
		}
		if count != 0 && blength == 0 {
			return fail(format!("Invalid zero block length [{who}]"), 2266);
		}
		let s2length = read_i32(r)?;
		if s2length < 0 || s2length as usize > xfer_sum_len {
			return fail(format!("Invalid checksum length {s2length} [{who}]"), 2282);
		}
		let remainder = read_i32(r)?;
		if remainder < 0 || remainder > blength {
			return fail(format!("Invalid remainder length {remainder} [{who}]"), 2288);
		}
		Ok(Self { count, blength, s2length, remainder })
	}

	/// write_sum_head (protocol 27+ layout; older protocols are refused earlier).
	pub(crate) fn write(&self, w: &mut dyn Write, _proto: Proto) -> io::Result<()> {
		w.write_int(self.count)?;
		w.write_int(self.blength)?;
		w.write_int(self.s2length)?;
		w.write_int(self.remainder)
	}
}

/// One wire `int`, with stream errors mapped like upstream's read_int.
fn read_i32(r: &mut dyn Read) -> Result<i32, RsyncError> {
	r.read_int().map_err(RsyncError::from_stream)
}

/// Largest block length a protocol allows.
fn max_block_len(proto: Proto) -> i64 {
	i64::from(if proto.version < 30 { consts::OLD_MAX_BLOCK_SIZE } else { consts::MAX_BLOCK_SIZE })
}




