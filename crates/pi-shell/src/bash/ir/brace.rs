//! Brace expansion (bash `brace_expand`) over a parsed word.
//!
//! Brace expansion is purely syntactic: it runs on the word as written,
//! before every other expansion, and only unquoted bytes (`WordPart::Lit`)
//! can open, separate or close a brace expression. The compiler expands a
//! word once into its alternatives; the VM uses them while `braceexpand`
//! (`set -B`) is on.

use std::collections::HashMap;

use crate::bash::syntax::tree::{self as st, Id, TextPk, Tree};

/// One unit of a word: an active (unquoted) byte or an opaque part.
#[derive(Clone, Copy)]
enum Tok {
	Ch(u8),
	/// A part of the source word.
	Src(u32),
	/// A part built in the output tree.
	Out(u32),
	/// A quoted empty string: bash re-reads brace-expanded text, so the `\`
	/// a character sequence produces is quote-removed to an empty word
	/// (`{Z..a}` has an empty word between `[` and `]`).
	Empty,
	/// A double-quoted source part holding a brace expression bash sees as
	/// unquoted ([`Brace::quoted_alternatives`]): the part and the index of
	/// its alternatives.
	Alts(u32, usize),
}

/// Upper bound on the number of words one brace expression may produce
/// (bash has none; this keeps `{1..999999999}` from exhausting memory). A
/// word over it is an error (`Err` with at least how many words it makes),
/// never left as written or cut short.
pub(super) const MAX_WORDS: usize = 1 << 22;

/// `Err(count)` when `count` words are over [`MAX_WORDS`].
const fn check_count(count: u128) -> Result<(), u128> {
	if count > MAX_WORDS as u128 {
		Err(count)
	} else {
		Ok(())
	}
}

/// The alternatives of `w`, or `None` when it has no brace expression: a
/// tree holding them, and their `Word` nodes (with `w`'s id and span).
/// Parts that stay as written are copied once and shared.
pub fn expand(w: st::Word<'_>) -> Result<Option<(Tree, Vec<u32>)>, u128> {
	let src = w.tree();
	let mut b = Brace { src, out: None, copied: HashMap::new(), alts: Vec::new(), empty: None };
	let Some(alts) = b.expand_parts(w.parts())? else {
		return Ok(None);
	};
	let out = b.out();
	let words = alts
		.iter()
		.map(|parts| out.copy_over(src, w.node(), parts))
		.collect();
	Ok(b.out.take().map(|t| (t, words)))
}

/// The output tree being built and what it already holds.
struct Brace<'s> {
	src:    &'s Tree,
	/// Made on first use: most words expand to nothing.
	out:    Option<Tree>,
	/// Source part → its copy.
	copied: HashMap<u32, u32>,
	/// Per [`Tok::Alts`]: the alternatives (output parts).
	alts:   Vec<Vec<u32>>,
	empty:  Option<u32>,
}

impl<'s> Brace<'s> {
	fn out(&mut self) -> &mut Tree {
		let src = self.src;
		self.out.get_or_insert_with(|| src.sharing_text())
	}

	/// Source node `n` in the output tree.
	fn copy(&mut self, n: u32) -> u32 {
		if let Some(&c) = self.copied.get(&n) {
			return c;
		}
		let src = self.src;
		let c = self.out().copy_from(src, n);
		self.copied.insert(n, c);
		c
	}

	fn empty_quote(&mut self) -> u32 {
		if let Some(e) = self.empty {
			return e;
		}
		let e = self.out().text_part(TextPk::SQuote, b"").index();
		self.empty = Some(e);
		e
	}

	/// The alternatives of `parts` as part lists of the output tree, or
	/// `None` when they hold no brace expression.
	fn expand_parts(
		&mut self,
		parts: st::Seq<'s, st::WordPart<'s>>,
	) -> Result<Option<Vec<Vec<u32>>>, u128> {
		// Most words hold no `{` outside quotes: skip them without building
		// tokens. A `"…"` part may still hide one (`quoted_alternatives`).
		let maybe = parts.iter().any(|p| match p.get() {
			st::Part::Lit(b) => b.contains(&b'{'),
			st::Part::DQuote(_) => true,
			_ => false,
		});
		if !maybe {
			return Ok(None);
		}
		let mut toks = Vec::new();
		let mut candidate = false;
		for p in parts {
			if let st::Part::Lit(b) = p.get() {
				candidate |= b.contains(&b'{');
				toks.extend(b.iter().map(|&c| Tok::Ch(c)));
			} else if let Some(alts) = self.quoted_alternatives(p)? {
				candidate = true;
				self.alts.push(alts);
				toks.push(Tok::Alts(p.node(), self.alts.len() - 1));
			} else {
				toks.push(Tok::Src(p.node()));
			}
		}
		if !candidate {
			return Ok(None);
		}
		let mut words = Vec::new();
		if !expand_toks(&toks, &self.alts, &mut words)? {
			return Ok(None);
		}
		Ok(Some(words.iter().map(|t| self.rebuild(t)).collect()))
	}

	/// bash finds braces in the word as written with a naive quote tracker
	/// (`brace_gobbler`): in `"${a["{2..6}"]}"` the `"` that opens the
	/// subscript string closes the outer one, so the text between the inner
	/// quotes is unquoted and its braces expand (`"${a["2"]}" … "${a["6"]}"`).
	/// The same holds for a double-quoted string in the operator word of a
	/// `${…}` inside double quotes (`"${x:-"{1,2}"}"`). The alternatives of
	/// such a double-quoted part (output parts), or `None`. An unquoted
	/// `${a["{1,2}"]}` keeps its quotes: bash skips `${`.
	fn quoted_alternatives(&mut self, part: st::WordPart<'s>) -> Result<Option<Vec<u32>>, u128> {
		let st::Part::DQuote(inner) = part.get() else {
			return Ok(None);
		};
		let Some(lists) = self.quoted_from(inner, 0, Vec::new())? else {
			return Ok(None);
		};
		let src = self.src;
		let out = self.out();
		Ok(Some(
			lists
				.iter()
				.map(|parts| out.copy_over(src, part.node(), parts))
				.collect(),
		))
	}

	/// [`Self::quoted_alternatives`] for the `${…}` at or after
	/// `inner[from]`, `prefix` standing for the parts before it: the first
	/// one expands, then (bash's postamble) each of its alternatives at the
	/// later ones; expanded text is not rescanned. Each alternative's inner
	/// parts.
	fn quoted_from(
		&mut self,
		inner: st::Seq<'s, st::WordPart<'s>>,
		from: usize,
		prefix: Vec<u32>,
	) -> Result<Option<Vec<Vec<u32>>>, u128> {
		let src = self.src;
		for (j, p) in inner.iter().enumerate().skip(from) {
			let st::Part::Param(param) = p.get() else {
				continue;
			};
			for (slot, word) in param.words().into_iter().flatten() {
				for (k, sub) in word.parts().iter().enumerate() {
					let st::Part::DQuote(q) = sub.get() else {
						continue;
					};
					let Some(alts) = self.expand_parts(q)? else {
						continue;
					};
					let mut alternatives = Vec::with_capacity(alts.len());
					for alt in alts {
						// The `${…}` with part `k` of that word replaced.
						let quote = self.out().copy_over(src, sub.node(), &alt);
						let mut parts: Vec<u32> =
							word.parts().iter().map(|x| self.copy(x.node())).collect();
						parts[k] = quote;
						let new_word = Id::new(self.out().copy_over(src, word.node(), &parts));
						let mut kids: Vec<u32> = src
							.kids_of(param.node())
							.iter()
							.map(|&x| self.copy(x))
							.collect();
						let new_param = self
							.out()
							.param_replaced(src, param.node(), slot, new_word, &mut kids)
							.index();
						let mut parts = prefix.clone();
						for x in inner.iter().take(j).skip(from) {
							parts.push(self.copy(x.node()));
						}
						parts.push(new_param);
						if let Some(more) = self.quoted_from(inner, j + 1, parts.clone())? {
							alternatives.extend(more);
						} else {
							for x in inner.iter().skip(j + 1) {
								parts.push(self.copy(x.node()));
							}
							alternatives.push(parts);
						}
						check_count(alternatives.len() as u128)?;
					}
					return Ok(Some(alternatives));
				}
			}
		}
		Ok(None)
	}

	/// Parts from tokens: runs of active bytes become one `Lit`.
	fn rebuild(&mut self, toks: &[Tok]) -> Vec<u32> {
		let mut parts = Vec::new();
		let mut lit = Vec::new();
		for &t in toks {
			let part = match t {
				Tok::Ch(c) => {
					lit.push(c);
					continue;
				},
				Tok::Src(n) | Tok::Alts(n, _) => self.copy(n),
				Tok::Out(n) => n,
				Tok::Empty => self.empty_quote(),
			};
			if !lit.is_empty() {
				self.push_lit(&mut parts, std::mem::take(&mut lit));
			}
			parts.push(part);
		}
		if !lit.is_empty() {
			self.push_lit(&mut parts, lit);
		}
		parts
	}

	/// Append a literal. Brace expansion works on the text as written, so
	/// name characters that end up right after an unbraced `$name` extend
	/// the name (`$var{x,y}` is `$varx $vary`).
	fn push_lit(&mut self, parts: &mut Vec<u32>, mut lit: Vec<u8>) {
		let out = self.out();
		if let Some(last) = parts.last_mut()
			&& let st::Part::Param(p) = st::WordPart::at(out, *last).get()
			&& let st::ParamName::Var(name) = p.name()
			&& !p.braced()
			&& !p.indirect()
			&& p.index().is_none()
			&& matches!(p.op(), st::ParamOp::None)
		{
			let n = lit
				.iter()
				.take_while(|&&c| c.is_ascii_alphanumeric() || c == b'_')
				.count();
			if n > 0 {
				let mut longer = name.to_vec();
				longer.extend_from_slice(&lit[..n]);
				*last = out.param_renamed(Id::new(*last), &longer).index();
				lit.drain(..n);
			}
			if lit.is_empty() {
				return;
			}
		}
		let part = out.text_part(TextPk::Lit, &lit).index();
		parts.push(part);
	}
}

/// Expand `toks` into `out`; `false` when nothing expanded.
fn expand_toks(toks: &[Tok], alts: &[Vec<u32>], out: &mut Vec<Vec<Tok>>) -> Result<bool, u128> {
	let mut start = 0;
	while let Some(s) = toks[start..]
		.iter()
		.position(|t| matches!(t, Tok::Ch(b'{') | Tok::Alts(..)))
		.map(|i| start + i)
	{
		if let Tok::Alts(_, i) = toks[s] {
			let rest = &toks[s + 1..];
			let mut posts = Vec::new();
			if !expand_toks(rest, alts, &mut posts)? {
				posts.push(rest.to_vec());
			}
			check_count(out.len() as u128 + alts[i].len() as u128 * posts.len() as u128)?;
			for &alt in &alts[i] {
				for post in &posts {
					let mut word = Vec::with_capacity(s + 1 + post.len());
					word.extend_from_slice(&toks[..s]);
					word.push(Tok::Out(alt));
					word.extend_from_slice(post);
					out.push(word);
				}
			}
			return Ok(true);
		}
		let Some(e) = matching_close(toks, s) else {
			// An unclosed `{` is literal; a later brace may still expand.
			start = s + 1;
			continue;
		};
		let inner = &toks[s + 1..e];
		let body = if let Some(p) = split_commas(inner) {
			Body::Alts(p)
		} else if let Some(q) = sequence(inner) {
			Body::Seq(q)
		} else {
			// Neither alternatives nor a sequence: this brace is literal.
			start = s + 1;
			continue;
		};
		// bash `brace_expand`: the preamble stays as written; each
		// alternative and the postamble are expanded on their own, and the
		// combined words (or sequence items) are not rescanned, so
		// `{{1..3}..{7..9}}` is `{1..7} {1..8} …`.
		let rest = &toks[e + 1..];
		let mut posts = Vec::new();
		if !expand_toks(rest, alts, &mut posts)? {
			posts.push(rest.to_vec());
		}
		let (pieces, alternatives) = match body {
			Body::Alts(p) => (p, true),
			Body::Seq(q) => {
				// Counted before an item is built.
				check_count(out.len() as u128 + q.count() * posts.len() as u128)?;
				(q.items(), false)
			},
		};
		for piece in pieces {
			let mut items = Vec::new();
			if !(alternatives && expand_toks(&piece, alts, &mut items)?) {
				items.push(piece);
			}
			check_count(out.len() as u128 + items.len() as u128 * posts.len() as u128)?;
			for item in &items {
				for post in &posts {
					let mut word = Vec::with_capacity(s + item.len() + post.len());
					word.extend_from_slice(&toks[..s]);
					word.extend_from_slice(item);
					word.extend_from_slice(post);
					out.push(word);
				}
			}
		}
		return Ok(true);
	}
	Ok(false)
}

/// The `}` closing the `{` at `s` (nested braces counted).
fn matching_close(toks: &[Tok], s: usize) -> Option<usize> {
	let mut depth = 0usize;
	for (i, t) in toks.iter().enumerate().skip(s) {
		match t {
			Tok::Ch(b'{') => depth += 1,
			Tok::Ch(b'}') => {
				depth -= 1;
				if depth == 0 {
					return Some(i);
				}
			},
			_ => {},
		}
	}
	None
}

/// The comma-separated alternatives of a brace body (top-level commas
/// only); `None` without a comma.
fn split_commas(inner: &[Tok]) -> Option<Vec<Vec<Tok>>> {
	let mut depth = 0usize;
	let mut alts = Vec::new();
	let mut cur = Vec::new();
	let mut comma = false;
	for &t in inner {
		match t {
			Tok::Ch(b'{') => depth += 1,
			Tok::Ch(b'}') => depth = depth.saturating_sub(1),
			Tok::Ch(b',') if depth == 0 => {
				comma = true;
				alts.push(std::mem::take(&mut cur));
				continue;
			},
			_ => {},
		}
		cur.push(t);
	}
	alts.push(cur);
	comma.then_some(alts)
}

/// What a closed brace holds.
enum Body {
	Alts(Vec<Vec<Tok>>),
	Seq(Sequence),
}

/// A brace sequence, `x..y[..incr]`, over integers or single characters.
#[derive(Clone, Copy)]
enum Sequence {
	/// Zero-padded to `width` when either end is.
	Ints {
		a:     i64,
		b:     i64,
		step:  u64,
		width: usize,
	},
	Chars {
		a:    u8,
		b:    u8,
		step: u8,
	},
}

/// The sequence a brace body spells, if any.
fn sequence(inner: &[Tok]) -> Option<Sequence> {
	let text = inner
		.iter()
		.map(|t| match t {
			Tok::Ch(c) => Some(*c),
			Tok::Src(_) | Tok::Out(_) | Tok::Empty | Tok::Alts(..) => None,
		})
		.collect::<Option<Vec<u8>>>()?;
	let parts: Vec<&[u8]> = split_dots(&text);
	if !(2..=3).contains(&parts.len()) {
		return None;
	}
	let incr = match parts.get(2) {
		Some(i) => parse_int(i)?,
		None => 1,
	};
	let step = incr.unsigned_abs().max(1);
	match (parse_int(parts[0]), parse_int(parts[1])) {
		(Some(a), Some(b)) => {
			let padded = |p: &[u8]| {
				let digits = p
					.strip_prefix(b"-")
					.or_else(|| p.strip_prefix(b"+"))
					.unwrap_or(p);
				digits.len() > 1 && digits[0] == b'0'
			};
			let width = if padded(parts[0]) || padded(parts[1]) {
				parts[0].len().max(parts[1].len())
			} else {
				0
			};
			Some(Sequence::Ints { a, b, step, width })
		},
		(None, None) if parts[0].len() == 1 && parts[1].len() == 1 => Some(Sequence::Chars {
			a:    parts[0][0],
			b:    parts[1][0],
			step: u8::try_from(step).unwrap_or(u8::MAX).max(1),
		}),
		_ => None,
	}
}

impl Sequence {
	/// How many items [`Self::items`] makes.
	fn count(self) -> u128 {
		match self {
			Self::Ints { a, b, step, .. } => a.abs_diff(b) as u128 / step as u128 + 1,
			Self::Chars { a, b, step } => u128::from(a.abs_diff(b) / step) + 1,
		}
	}

	/// The items, as tokens.
	fn items(self) -> Vec<Vec<Tok>> {
		match self {
			Self::Ints { a, b, step, width } => (0..self.count() as u64)
				.map(|k| {
					let off = i64::try_from(k * step).unwrap_or(i64::MAX);
					let v = if a <= b {
						a.saturating_add(off)
					} else {
						a.saturating_sub(off)
					};
					let text = if v < 0 {
						format!("-{:0w$}", v.unsigned_abs(), w = width.saturating_sub(1))
					} else {
						format!("{v:0width$}")
					};
					text.bytes().map(Tok::Ch).collect()
				})
				.collect(),
			Self::Chars { a, b, step } => (0..=a.abs_diff(b) / step)
				.map(|k| {
					let c = if a <= b { a + k * step } else { a - k * step };
					// bash re-reads expanded text: a lone `\` is quote-removed
					// to an empty word.
					if c == b'\\' {
						vec![Tok::Empty]
					} else {
						vec![Tok::Ch(c)]
					}
				})
				.collect(),
		}
	}
}

/// Split at `..` (exactly two dots).
fn split_dots(text: &[u8]) -> Vec<&[u8]> {
	let mut out = Vec::new();
	let mut rest = text;
	while let Some(i) = rest.windows(2).position(|w| w == b"..") {
		out.push(&rest[..i]);
		rest = &rest[i + 2..];
	}
	out.push(rest);
	out
}

fn parse_int(text: &[u8]) -> Option<i64> {
	let digits = text
		.strip_prefix(b"-")
		.or_else(|| text.strip_prefix(b"+"))
		.unwrap_or(text);
	if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
		return None;
	}
	std::str::from_utf8(text).ok()?.parse().ok()
}


