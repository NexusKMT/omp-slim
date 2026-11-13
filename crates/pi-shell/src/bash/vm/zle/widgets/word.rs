//! The emacs word widgets of zsh 5.9 `Src/Zle/zle_word.c`: word motions,
//! kills and deletions, case changes and `transpose-words` (the `vi-*`
//! word widgets are the vi module's).
//!
//! A word character is zsh's `ZC_iword`: an alphanumeric or a character
//! of `$WORDCHARS` ([`WordChars`]).
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use crate::bash::vm::zle::{
	Editor, Zle,
	exec::{WResult, Zw},
	utils::{self, cutflags},
};

/// zsh's `DEFAULT_WORDCHARS`: `$WORDCHARS` when it is unset.
pub const DEFAULT_WORDCHARS: &str = "*?_-.[]~=/&;!#$%^(){}<>";

/// The characters of `$WORDCHARS` (zsh `wordchars`/`wordchars_wide`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WordChars(Vec<char>);

impl WordChars {
	/// The word characters `$WORDCHARS` gives (`None`: unset, zsh's
	/// default). Bytes that are no character are dropped, as zsh's
	/// conversion to wide characters drops them.
	pub fn new(wordchars: Option<&[u8]>) -> Self {
		match wordchars {
			Some(w) => Self(
				bstr::ByteSlice::chars(w)
					.filter(|&c| c != '\u{fffd}')
					.collect(),
			),
			None => Self(DEFAULT_WORDCHARS.chars().collect()),
		}
	}

	/// The word characters of the editing shell.
	pub fn load(zw: &mut Zw<'_, '_>) -> Self {
		let w = zw.getsparam(b"WORDCHARS");
		Self::new(w.as_deref().map(|w| &w[..]))
	}

	/// zsh `ZC_iword` (`wcsiword`): `c` is part of a word.
	pub fn iword(&self, c: char) -> bool {
		if c.is_ascii() {
			c.is_ascii_alphanumeric() || self.0.contains(&c)
		} else {
			c.is_alphanumeric() || self.0.contains(&c)
		}
	}
}

/// Whether the character at `pos` is a word character.
fn word_at(ed: &Editor, wc: &WordChars, pos: usize) -> bool {
	wc.iword(ed.line[pos])
}

/// Whether the character before `pos` (`pos > 0`) is a word character
/// (zsh's `pos = x; DECPOS(pos); ZC_iword(zleline[pos])`); the position
/// of that character.
fn word_before(ed: &Editor, wc: &WordChars, pos: usize) -> (bool, usize) {
	let mut p = pos;
	utils::decpos(ed, &mut p);
	(word_at(ed, wc, p), p)
}

/// The start of the `n`-th word back from `x` (zsh's backward loops: skip
/// non-word characters, then word characters).
fn back_words(ed: &Editor, wc: &WordChars, mut x: usize, n: i64) -> usize {
	for _ in 0..n {
		while x != 0 {
			let (w, p) = word_before(ed, wc, x);
			if w {
				break;
			}
			x = p;
		}
		while x != 0 {
			let (w, p) = word_before(ed, wc, x);
			if !w {
				break;
			}
			x = p;
		}
	}
	x
}

/// The end of the `n`-th word on from `x` (zsh's forward loops of
/// `deleteword`/`killword`: skip non-word characters, then word
/// characters).
fn fore_words(ed: &Editor, wc: &WordChars, mut x: usize, n: i64) -> usize {
	let ll = ed.line.len();
	for _ in 0..n {
		while x != ll && !word_at(ed, wc, x) {
			utils::incpos(ed, &mut x);
		}
		while x != ll && word_at(ed, wc, x) {
			utils::incpos(ed, &mut x);
		}
	}
	x
}

/// Run `f` with the count `-n` (zsh's `zmult = -n; ret = other(args);
/// zmult = n;`).
fn with_mult<T>(ed: &mut Editor, n: i64, f: impl FnOnce(&mut Editor) -> T) -> T {
	ed.zmod.mult = n.wrapping_neg();
	let r = f(ed);
	ed.zmod.mult = n;
	r
}

/// zsh `forwardword`: to the start of the `zmult`-th next word (with
/// `wordflag`, the end of the last one).
pub fn forward_word(ed: &mut Editor, wc: &WordChars) -> i32 {
	let n = ed.zmod.mult;
	if n < 0 {
		return with_mult(ed, n, |ed| backward_word(ed, wc));
	}
	let ll = ed.line.len();
	for left in (0..n).rev() {
		while ed.cs != ll && word_at(ed, wc, ed.cs) {
			utils::inccs(ed);
		}
		if ed.ls.wordflag && left == 0 {
			return 0;
		}
		while ed.cs != ll && !word_at(ed, wc, ed.cs) {
			utils::inccs(ed);
		}
	}
	0
}

/// zsh `emacsforwardword`: to the end of the `zmult`-th next word.
pub fn emacs_forward_word(ed: &mut Editor, wc: &WordChars) -> i32 {
	let n = ed.zmod.mult;
	if n < 0 {
		return with_mult(ed, n, |ed| emacs_backward_word(ed, wc));
	}
	let ll = ed.line.len();
	for left in (0..n).rev() {
		while ed.cs != ll && !word_at(ed, wc, ed.cs) {
			utils::inccs(ed);
		}
		if ed.ls.wordflag && left == 0 {
			return 0;
		}
		while ed.cs != ll && word_at(ed, wc, ed.cs) {
			utils::inccs(ed);
		}
	}
	0
}

/// zsh `backwardword`: to the start of the `zmult`-th word back.
pub fn backward_word(ed: &mut Editor, wc: &WordChars) -> i32 {
	let n = ed.zmod.mult;
	if n < 0 {
		return with_mult(ed, n, |ed| forward_word(ed, wc));
	}
	ed.cs = back_words(ed, wc, ed.cs, n);
	0
}

/// zsh `emacsbackwardword` (the same motion as `backwardword`; a negative
/// count goes forward as `emacs-forward-word`).
pub fn emacs_backward_word(ed: &mut Editor, wc: &WordChars) -> i32 {
	let n = ed.zmod.mult;
	if n < 0 {
		return with_mult(ed, n, |ed| emacs_forward_word(ed, wc));
	}
	ed.cs = back_words(ed, wc, ed.cs, n);
	0
}

/// zsh `backwarddeleteword`: delete back to the start of the `zmult`-th
/// word back, without saving the text.
pub fn backward_delete_word(ed: &mut Editor, wc: &WordChars) -> i32 {
	let n = ed.zmod.mult;
	if n < 0 {
		return with_mult(ed, n, |ed| delete_word(ed, wc));
	}
	let x = back_words(ed, wc, ed.cs, n);
	let ct = ed.cs - x;
	utils::backdel(ed, ct, cutflags::RAW);
	0
}

/// zsh `deleteword`: delete to the end of the `zmult`-th next word,
/// without saving the text.
pub fn delete_word(ed: &mut Editor, wc: &WordChars) -> i32 {
	let n = ed.zmod.mult;
	if n < 0 {
		return with_mult(ed, n, |ed| backward_delete_word(ed, wc));
	}
	let x = fore_words(ed, wc, ed.cs, n);
	let ct = x - ed.cs;
	utils::foredel(ed, ct, cutflags::RAW);
	0
}

/// zsh `backwardkillword`: kill back to the start of the `zmult`-th word
/// back.
pub fn backward_kill_word(zle: &mut Zle, ed: &mut Editor, wc: &WordChars) -> i32 {
	let n = ed.zmod.mult;
	if n < 0 {
		ed.zmod.mult = -n;
		let r = kill_word(zle, ed, wc);
		ed.zmod.mult = n;
		return r;
	}
	let x = back_words(ed, wc, ed.cs, n);
	let ct = ed.cs - x;
	utils::backkill(zle, ed, ct, cutflags::FRONT | cutflags::RAW);
	0
}

/// zsh `killword`: kill to the end of the `zmult`-th next word.
pub fn kill_word(zle: &mut Zle, ed: &mut Editor, wc: &WordChars) -> i32 {
	let n = ed.zmod.mult;
	if n < 0 {
		ed.zmod.mult = -n;
		let r = backward_kill_word(zle, ed, wc);
		ed.zmod.mult = n;
		return r;
	}
	let x = fore_words(ed, wc, ed.cs, n);
	let ct = x - ed.cs;
	utils::forekill(zle, ed, ct, cutflags::RAW);
	0
}

/// zsh `ZC_toupper`/`ZC_tolower`: the one-character case mapping (a
/// character whose mapping is longer stays).
fn map_case(c: char, upper: bool) -> char {
	fn one(mut it: impl Iterator<Item = char>) -> Option<char> {
		let first = it.next()?;
		it.next().is_none().then_some(first)
	}
	let m = if upper {
		one(c.to_uppercase())
	} else {
		one(c.to_lowercase())
	};
	m.unwrap_or(c)
}

/// How [`change_case`] maps the letters of a word.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CaseOp {
	/// `up-case-word`.
	Upper,
	/// `down-case-word`.
	Lower,
	/// `capitalize-word`.
	Capitalize,
}

/// zsh `upcaseword`, `downcaseword`, `capitalizeword`: change the case of
/// the next `|zmult|` words, moving over them (a negative count leaves
/// the cursor where it was).
pub fn change_case(ed: &mut Editor, wc: &WordChars, op: CaseOp) -> i32 {
	let n = ed.zmod.mult;
	let neg = n < 0;
	let ocs = ed.cs;
	let ll = ed.line.len();
	for _ in 0..n.unsigned_abs() {
		while ed.cs != ll && !word_at(ed, wc, ed.cs) {
			utils::inccs(ed);
		}
		if op == CaseOp::Capitalize {
			while ed.cs != ll && word_at(ed, wc, ed.cs) && !ed.line[ed.cs].is_alphabetic() {
				utils::inccs(ed);
			}
		}
		let mut first = true;
		while ed.cs != ll && word_at(ed, wc, ed.cs) {
			let c = ed.line[ed.cs];
			ed.line[ed.cs] = match op {
				CaseOp::Upper => map_case(c, true),
				CaseOp::Lower => map_case(c, false),
				CaseOp::Capitalize => map_case(c, first),
			};
			first = false;
			utils::inccs(ed);
		}
	}
	if neg {
		ed.cs = ocs;
	}
	0
}

/// zsh `transposewords`: exchange the word at (or before) the cursor
/// with the `|zmult|`-th word before it, then move after them (a
/// negative count leaves the cursor). 1 when there are no such words on
/// the line.
pub fn transpose_words(ed: &mut Editor, wc: &WordChars) -> i32 {
	let mut n = ed.zmod.mult;
	let neg = n < 0;
	let ocs = ed.cs;
	if neg {
		n = -n;
	}
	let ll = ed.line.len();
	let mut x = ed.cs;
	while x != ll && ed.line[x] != '\n' && !word_at(ed, wc, x) {
		utils::incpos(ed, &mut x);
	}
	if x == ll || ed.line[x] == '\n' {
		x = ed.cs;
		while x != 0 {
			if x < ll && word_at(ed, wc, x) {
				break;
			}
			let mut pos = x;
			utils::decpos(ed, &mut pos);
			if ed.line[pos] == '\n' {
				break;
			}
			x = pos;
		}
		if x == 0 {
			return 1;
		}
		let mut pos = x;
		utils::decpos(ed, &mut pos);
		if ed.line[pos] == '\n' {
			return 1;
		}
	}
	let mut p4 = x;
	while p4 != ll && word_at(ed, wc, p4) {
		utils::incpos(ed, &mut p4);
	}
	let mut p3 = p4;
	while p3 != 0 {
		let (w, pos) = word_before(ed, wc, p3);
		if !w {
			break;
		}
		p3 = pos;
	}
	if p3 == 0 {
		return 1;
	}
	let mut p1 = p3;
	let mut p2 = p3;
	let mut pt = p3;
	for _ in 0..n {
		p2 = pt;
		while p2 != 0 {
			let (w, pos) = word_before(ed, wc, p2);
			if w {
				break;
			}
			p2 = pos;
		}
		if p2 == 0 {
			return 1;
		}
		p1 = p2;
		while p1 != 0 {
			let (w, pos) = word_before(ed, wc, p1);
			if !w {
				break;
			}
			p1 = pos;
		}
		pt = p1;
	}
	let mut temp = Vec::with_capacity(p4 - p1);
	temp.extend_from_slice(&ed.line[p3..p4]);
	temp.extend_from_slice(&ed.line[p2..p3]);
	temp.extend_from_slice(&ed.line[p1..p2]);
	ed.line[p1..p4].copy_from_slice(&temp);
	ed.cs = if neg { ocs } else { p4 };
	0
}

/// Widget `forward-word`.
pub fn forwardword(zw: &mut Zw<'_, '_>) -> WResult {
	let wc = WordChars::load(zw);
	WResult::Done(forward_word(zw.ed, &wc))
}

/// Widget `backward-word`.
pub fn backwardword(zw: &mut Zw<'_, '_>) -> WResult {
	let wc = WordChars::load(zw);
	WResult::Done(backward_word(zw.ed, &wc))
}

/// Widget `emacs-forward-word`.
pub fn emacsforwardword(zw: &mut Zw<'_, '_>) -> WResult {
	let wc = WordChars::load(zw);
	WResult::Done(emacs_forward_word(zw.ed, &wc))
}

/// Widget `emacs-backward-word`.
pub fn emacsbackwardword(zw: &mut Zw<'_, '_>) -> WResult {
	let wc = WordChars::load(zw);
	WResult::Done(emacs_backward_word(zw.ed, &wc))
}

/// Widget `backward-delete-word`.
pub fn backwarddeleteword(zw: &mut Zw<'_, '_>) -> WResult {
	let wc = WordChars::load(zw);
	WResult::Done(backward_delete_word(zw.ed, &wc))
}

/// Widget `delete-word`.
pub fn deleteword(zw: &mut Zw<'_, '_>) -> WResult {
	let wc = WordChars::load(zw);
	WResult::Done(delete_word(zw.ed, &wc))
}

/// Widget `backward-kill-word`.
pub fn backwardkillword(zw: &mut Zw<'_, '_>) -> WResult {
	let wc = WordChars::load(zw);
	WResult::Done(backward_kill_word(zw.zle, zw.ed, &wc))
}

/// Widget `kill-word`.
pub fn killword(zw: &mut Zw<'_, '_>) -> WResult {
	let wc = WordChars::load(zw);
	WResult::Done(kill_word(zw.zle, zw.ed, &wc))
}

/// Widget `up-case-word`.
pub fn upcaseword(zw: &mut Zw<'_, '_>) -> WResult {
	let wc = WordChars::load(zw);
	WResult::Done(change_case(zw.ed, &wc, CaseOp::Upper))
}

/// Widget `down-case-word`.
pub fn downcaseword(zw: &mut Zw<'_, '_>) -> WResult {
	let wc = WordChars::load(zw);
	WResult::Done(change_case(zw.ed, &wc, CaseOp::Lower))
}

/// Widget `capitalize-word`.
pub fn capitalizeword(zw: &mut Zw<'_, '_>) -> WResult {
	let wc = WordChars::load(zw);
	WResult::Done(change_case(zw.ed, &wc, CaseOp::Capitalize))
}

/// Widget `transpose-words`.
pub fn transposewords(zw: &mut Zw<'_, '_>) -> WResult {
	let wc = WordChars::load(zw);
	WResult::Done(transpose_words(zw.ed, &wc))
}


