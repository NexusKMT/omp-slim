//! Shared POSIX basic-regular-expression translation.
//!
//! `grep` and `sed` both accept BREs but compile them with different engines
//! (`grep-regex` and `fancy-regex` respectively), neither of which implements
//! BRE syntax. This module converts a BRE into the ERE-compatible form those
//! engines accept, so the dialect is defined in exactly one place.

/// Whether the target engine supports back-references.
///
/// `sed` compiles with `fancy-regex`, which does; `grep` compiles with
/// `grep-regex` (the `regex` crate), which does not. When back-references are
/// unsupported the sequence is passed through unchanged, leaving the caller's
/// own compilation failure to decide what happens next.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[allow(dead_code, reason = "each variant is used by a different utility feature")]
pub(crate) enum Backrefs {
	Supported,
	Unsupported,
}

/// Convert a primitive BRE pattern to a safe ERE-compatible pattern string.
/// - Replaces `\(`, `\)`, `\?`, `\+`, `\|`, `\{` and `\}` with `(`, `)`, `?`,
///   `+`, `|`, `{` and `}`.
/// - Puts single-digit back-references in non-capturing groups..
/// - Escapes ERE-only metacharacters: `+ ? { } | ( )`.
/// - Leaves all other characters as-is.
///
/// A repetition character with **no preceding atom** is emitted as a literal,
/// per POSIX: "an asterisk that is the first character of an RE ... shall lose
/// its special meaning". The same applies directly after `^`, `\(` or `\|`.
/// This matters because the target engines accept `^+` and compile it as
/// `(?:^)+`, which matches the empty string at every line start - so a pattern
/// meant to find a few lines silently matches all of them.
pub(crate) fn bre_to_ere(pattern: &str, backrefs: Backrefs) -> String {
	let mut result = String::with_capacity(pattern.len());
	let mut chars = pattern.chars().peekable();

	let mut at_beginning = true;
	let mut previous: Option<char> = None;
	// Whether something repeatable precedes the current position. False at the
	// start of the pattern and directly after `^`, `\(` or `\|`.
	let mut has_atom = false;
	while let Some(c) = chars.next() {
		if c == '\\' {
			match chars.peek() {
				Some('(') => {
					chars.next();
					result.push('('); // Group start
					has_atom = false;
				},
				Some(')') => {
					chars.next();
					result.push(')'); // Group end
					has_atom = true;
				},
				Some('?') => {
					chars.next();
					if has_atom {
						result.push('?'); // Quantifier 0 or 1
					} else {
						result.push_str(r"\?"); // Nothing to repeat: literal
						has_atom = true;
					}
				},
				Some('+') => {
					chars.next();
					if has_atom {
						result.push('+'); // Quantifier 1 or more
					} else {
						result.push_str(r"\+"); // Nothing to repeat: literal
						has_atom = true;
					}
				},
				Some('|') => {
					chars.next();
					result.push('|'); // Alternation operator
					has_atom = false;
				},
				Some('{') => {
					chars.next();
					// Emitted as an operator even with no operand, so the
					// engine REJECTS the pattern. That is what `grep` and
					// `sed` both do: measured, `\{1,4\}` with nothing to
					// repeat is "repetition-operator operand invalid", not
					// a literal brace. Degrading it to a literal here would
					// replace a correct error with a silent wrong match.
					result.push('{'); // Brace quantifier start
				},
				Some('}') => {
					chars.next();
					result.push('}'); // Brace quantifier end
					has_atom = true;
				},
				Some(v) if v.is_ascii_digit() => {
					// Back-reference.  In sed BREs these are single-digit
					// (\1-\9) whereas fancy_regex supports multi-digit
					// back-references. Put them in a non-capturing group
					// to avoid having the number extend beyond the single
					// digit. Example: In sed \11 matches group 1 followed
					// by '1', not group 11.
					let v = *v;
					chars.next();
					match backrefs {
						Backrefs::Supported => result.push_str(&format!(r"(?:\{v})")),
						Backrefs::Unsupported => {
							result.push('\\');
							result.push(v);
						},
					}
					has_atom = true;
				},
				Some(&next) => {
					// Preserve other escaped characters.
					chars.next();
					result.push('\\');
					result.push(next);
					has_atom = true;
				},
				None => {
					// Trailing backslash; keep it.
					result.push('\\');
					has_atom = true;
				},
			}
		} else {
			match c {
				'+' | '?' | '{' | '}' | '|' | '(' | ')' => {
					// Escape unsupported ERE metacharacters.
					result.push('\\');
					result.push(c);
					has_atom = true;
				},
				'*' => {
					if has_atom {
						result.push('*'); // Quantifier 0 or more
					} else {
						result.push_str(r"\*"); // Nothing to repeat: literal
						has_atom = true;
					}
				},
				'^' if !at_beginning && previous != Some('[') => {
					// In BREs ^ has special meaning at the beginning
					// and as bracket negation.  This heuristic escapes
					// all other uses, which per POSIX are valid in EREs.
					// "the ERE "a^b" is valid, but can never match because
					// the 'a' prevents the expression "^b" from matching
					// starting at the first character."
					// POSIX 9.4.9 ERE Expression Anchoring
					result.push('\\');
					result.push(c);
					has_atom = true;
				},
				'$' if chars.peek().is_some() => {
					// Similarly for $ appearing not at the end.
					result.push('\\');
					result.push(c);
					has_atom = true;
				},
				// An anchor is not an atom: `^` leaves `has_atom` as it found
				// it, so `^*` sees no operand while `[^x]*` still quantifies
				// the bracket expression.
				'^' | '$' => result.push(c),
				_ => {
					result.push(c);
					has_atom = true;
				},
			}
		}
		at_beginning = false;
		previous = Some(c);
	}

	result
}

/// True when an ERE contains a repetition operator with nothing to repeat.
///
/// POSIX leaves this undefined and both GNU and BSD grep reject it:
/// `grep -E '^+'` is "repetition-operator operand invalid". The `regex` crate
/// instead compiles `^+` as `(?:^)+`, which matches the empty string at every
/// line start, so without this check an invalid pattern silently selects every
/// line - a wrong answer with a success exit status.
#[cfg(feature = "util.grep")]
pub(crate) fn ere_repetition_operand_missing(pattern: &str) -> bool {
	let mut chars = pattern.chars().peekable();
	let mut has_atom = false;
	while let Some(c) = chars.next() {
		match c {
			// An escaped character is a literal, and therefore an atom.
			'\\' => {
				if chars.next().is_none() {
					return false;
				}
				has_atom = true;
			},
			// A bracket expression is one atom. `]` immediately after the
			// opening bracket (or its negation) is a literal, not the close.
			'[' => {
				if chars.peek() == Some(&'^') {
					chars.next();
				}
				if chars.peek() == Some(&']') {
					chars.next();
				}
				for inner in chars.by_ref() {
					if inner == ']' {
						break;
					}
				}
				has_atom = true;
			},
			'(' | '|' => has_atom = false,
			')' => has_atom = true,
			// Anchors are not atoms: they leave the operand state alone, so
			// `^*` has nothing to repeat while `[^x]*` still quantifies the
			// bracket expression.
			'^' | '$' => {},
			'*' | '+' | '?' | '{' if !has_atom => return true,
			_ => has_atom = true,
		}
	}
	false
}

#[cfg(test)]
mod tests {
	use super::*;

	fn ere(pattern: &str) -> String {
		bre_to_ere(pattern, Backrefs::Supported)
	}

	// Relocated from `sed`, which owned this translation before `grep` shared it.

	#[test]
	fn test_bre_group_translation() {
		assert_eq!(ere(r"\(a\?b\+c\|\)"), "(a?b+c|)");
		assert_eq!(ere(r"a\(b\)c"), "a(b)c");
	}

	#[test]
	fn test_bre_brace_quantifier_translation() {
		assert_eq!(ere(r"\{1,4\}"), "{1,4}");
	}

	#[test]
	fn test_ere_metacharacters_escaped() {
		assert_eq!(ere(r"a+b?c{1}|(d)"), r"a\+b\?c\{1\}\|\(d\)");
	}

	#[test]
	fn test_literal_backslashes_preserved() {
		assert_eq!(ere(r"foo\\bar"), r"foo\\bar");
		assert_eq!(ere(r"\."), r"\.");
	}

	#[test]
	fn test_character_classes_unchanged() {
		assert_eq!(ere(r"[a-z]"), "[a-z]");
		assert_eq!(ere(r"[^0-9]"), "[^0-9]");
	}

	#[test]
	fn test_anchors_and_dot_and_star() {
		assert_eq!(ere(r"^a.*b$"), "^a.*b$");
	}

	#[test]
	fn test_trailing_backslash_is_preserved() {
		assert_eq!(ere(r"abc\"), r"abc\");
	}

	#[test]
	fn test_caret_escaped_in_middle() {
		assert_eq!(ere(r"^a^[^x]c"), r"^a\^[^x]c");
	}

	#[test]
	fn test_dollar_escaped_in_middle() {
		assert_eq!(ere(r"a$c$"), r"a\$c$");
	}

	#[test]
	fn test_bre_back_reference() {
		assert_eq!(ere(r"\(.\)\1\(.\)\2"), r"(.)(?:\1)(.)(?:\2)");
	}

	#[test]
	fn back_references_pass_through_when_the_engine_does_not() {
		assert_eq!(bre_to_ere(r"\(a\)\1", Backrefs::Unsupported), r"(a)\1");
	}

	// ── Repetition operators with no preceding atom ──────────────────────────
	// POSIX BRE: a repetition character with nothing to repeat is a LITERAL.
	// Emitting it as an operator lets the Rust engine compile `^+` as `(?:^)+`,
	// which matches the empty string at every line start - so the pattern
	// silently matches EVERY line instead of the intended few.

	#[test]
	fn escaped_plus_at_pattern_start_is_a_literal() {
		assert_eq!(ere(r"\+"), r"\+");
	}

	#[test]
	fn escaped_plus_after_anchor_is_a_literal() {
		assert_eq!(ere(r"^\+"), r"^\+");
	}

	#[test]
	fn escaped_question_after_anchor_is_a_literal() {
		assert_eq!(ere(r"^\?"), r"^\?");
	}

	#[test]
	fn escaped_brace_quantifier_with_no_operand_stays_an_operator() {
		// Deliberately NOT a literal. `grep` and `sed` both reject
		// `\{1,4\}` with nothing to repeat rather than matching a brace, so
		// the operator is emitted and the engine refuses the pattern.
		assert_eq!(ere(r"^\{2\}"), r"^{2}");
		assert_eq!(ere(r"\{1,4\}"), r"{1,4}");
	}

	#[test]
	fn bare_star_at_pattern_start_is_a_literal() {
		assert_eq!(ere(r"*x"), r"\*x");
	}

	#[test]
	fn bare_star_after_anchor_is_a_literal() {
		assert_eq!(ere(r"^*"), r"^\*");
	}

	#[test]
	fn repetition_after_group_open_is_a_literal() {
		assert_eq!(ere(r"\(\+a\)"), r"(\+a)");
		assert_eq!(ere(r"\(*a\)"), r"(\*a)");
	}

	#[test]
	fn repetition_after_alternation_is_a_literal() {
		assert_eq!(ere(r"a\|\+b"), r"a|\+b");
	}

	// The operator cases these must not break.

	#[test]
	fn repetition_with_an_operand_stays_an_operator() {
		assert_eq!(ere(r"a\+"), r"a+");
		assert_eq!(ere(r"a\?"), r"a?");
		assert_eq!(ere(r"a\{2\}"), r"a{2}");
		assert_eq!(ere(r"a*"), r"a*");
		assert_eq!(ere(r"^a\+"), r"^a+");
		assert_eq!(ere(r"\(a\)\+"), r"(a)+");
		assert_eq!(ere(r"[a-z]\+"), r"[a-z]+");
		assert_eq!(ere(r".\+"), r".+");
	}

	// ── ERE operand validation ───────────────────────────────────────────────

	#[cfg(feature = "util.grep")]
	#[test]
	fn ere_rejects_repetition_with_no_operand() {
		for pattern in ["^+", "^*", "^?", "^{2}", "*x", "+", "(+)", "a|+b", "(|+)"] {
			assert!(ere_repetition_operand_missing(pattern), "should reject {pattern}");
		}
	}

	#[cfg(feature = "util.grep")]
	#[test]
	fn ere_accepts_repetition_with_an_operand() {
		for pattern in [
			"a+",
			"^a+",
			"a{2}",
			"[a-z]+",
			".*",
			r"\++",     // an escaped plus is a literal, so it IS an operand
			"[^x]*",    // negated class, not an anchor
			"[]]*",     // `]` first in a class is a literal
			"[^]]*",    // and after a negation too
			"(a)+",
			"a|b+",
			"$",
			r"\\",
			r"a\",      // trailing backslash: not our error to report
		] {
			assert!(!ere_repetition_operand_missing(pattern), "should accept {pattern}");
		}
	}
}
