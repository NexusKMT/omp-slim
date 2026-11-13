//! Variant names of the engine's large fieldless enums, packed into one
//! byte array at compile time.
//!
//! A `match` that returns a `&'static str` per variant (what strum's
//! `IntoStaticStr` and `Display` derive, inlined at every use) compiles to
//! a lookup table of string pointers: one dynamic relocation per variant
//! and per inlined copy, which the loader applies at every process start
//! (about 32 instructions each in glibc 2.43). The names here are strum's
//! own (`VariantNames`, the spellings `IntoStaticStr` would give), copied
//! at compile time into an array of bytes and one of end offsets: no
//! pointers, nothing to relocate.
//!
//! Do not revert these enums to `#[derive(IntoStaticStr, Display)]`: that
//! was measured at +1,340 relocations, +3.9 % instructions on every
//! `obash` start.

/// Bytes of all `names` together.
pub const fn packed_len(names: &[&str]) -> usize {
	let mut n = 0;
	let mut i = 0;
	while i < names.len() {
		n += names[i].len();
		i += 1;
	}
	n
}

/// The names of `N` variants packed into `BYTES` bytes; built by
/// [`PackedNames::new`] in a `static` (see [`packed_names!`]).
pub struct PackedNames<const BYTES: usize, const N: usize> {
	bytes: [u8; BYTES],
	/// End offset of each name in `bytes`.
	ends:  [u16; N],
}

impl<const BYTES: usize, const N: usize> PackedNames<BYTES, N> {
	/// Pack `names` (an enum's `strum::VariantNames::VARIANTS`); a size
	/// mismatch fails the constant's evaluation, so the build.
	pub const fn new(names: &[&str]) -> Self {
		assert!(names.len() == N && packed_len(names) == BYTES && BYTES <= u16::MAX as usize);
		let mut bytes = [0_u8; BYTES];
		let mut ends = [0_u16; N];
		let mut at = 0;
		let mut i = 0;
		while i < N {
			let name = names[i].as_bytes();
			let mut j = 0;
			while j < name.len() {
				bytes[at] = name[j];
				at += 1;
				j += 1;
			}
			ends[i] = at as u16;
			i += 1;
		}
		Self { bytes, ends }
	}

	/// The name of variant `i` (`""` past the last one).
	pub fn get(&'static self, i: usize) -> &'static str {
		let start = match i.checked_sub(1) {
			Some(prev) => self.ends.get(prev).map_or(0, |&e| usize::from(e)),
			None => 0,
		};
		let end = self.ends.get(i).map_or(start, |&e| usize::from(e));
		// Whole names cut from valid UTF-8: the check never fails.
		self
			.bytes
			.get(start..end)
			.and_then(|b| std::str::from_utf8(b).ok())
			.unwrap_or_default()
	}
}

/// `From<E>` and `From<&E>` for `&'static str` (and with `, Display` the
/// `Display` impl) of fieldless enum `E` (deriving `strum::VariantNames`;
/// variants without explicit discriminants, so `e as usize` is the
/// declaration index) from its packed names: what strum's `IntoStaticStr`
/// and `Display` give, without a relocated pointer table.
macro_rules! packed_names {
	($ty:ty,Display) => {
		$crate::bash::packed_names::packed_names!($ty);

		impl std::fmt::Display for $ty {
			fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
				f.pad(<&'static str>::from(*self))
			}
		}
	};
	($ty:ty) => {
		impl From<$ty> for &'static str {
			fn from(v: $ty) -> Self {
				static NAMES: $crate::bash::packed_names::PackedNames<
					{ $crate::bash::packed_names::packed_len(<$ty as strum::VariantNames>::VARIANTS) },
					{ <$ty as strum::VariantNames>::VARIANTS.len() },
				> =
					$crate::bash::packed_names::PackedNames::new(<$ty as strum::VariantNames>::VARIANTS);
				NAMES.get(v as usize)
			}
		}

		impl From<&$ty> for &'static str {
			fn from(v: &$ty) -> Self {
				Self::from(*v)
			}
		}
	};
}

pub(crate) use packed_names;


