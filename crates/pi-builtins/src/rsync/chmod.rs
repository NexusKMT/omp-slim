//! `--chmod` rules: the comma-separated symbolic/octal grammar of rsync's
//! `--chmod` option and its application to file-list modes.
//!
//! Grammar of one clause (clauses are separated by `,`; several `--chmod`
//! options accumulate in order):
//!
//! - an optional run of `D` (directories only) / `F` (non-directories only),
//! - then either an octal number of up to `07777` (`[DF]*[0-7]+`, replacing all
//!   permission bits), or `[ugoa]*` followed by exactly one of `+`, `-`, `=`
//!   and then either `[rwxXst]*` or a single copy source `u`, `g`, or `o`.
//!
//! A clause that names no class (`+x`, `=r`) acts on all classes but never
//! grants or copies a bit the umask masks. `X` grants execute only to
//! directories and to files that were executable before any clause ran.

use crate::rsync::consts::{CHMOD_BITS, S_ISGID, S_ISUID, S_ISVTX, mode_is_dir};

/// Class masks: one bit per permission triplet, so `classes * rwx` spreads an
/// `rwx` value (4/2/1) over the selected triplets.
const USER: u32 = 0o100;
const GROUP: u32 = 0o010;
const OTHER: u32 = 0o001;
const ALL: u32 = USER | GROUP | OTHER;

/// Which entries a clause applies to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Scope {
	Any,
	Dirs,
	Files,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Op {
	Add,
	Remove,
	Assign,
}

/// A symbolic clause, fully resolved at parse time (the umask included).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Symbolic {
	op: Op,
	/// Selected triplets (`USER | GROUP | OTHER` subset; all when none named).
	classes: u32,
	/// Special bits that `=` clears when the clause sets any: setuid for `u`,
	/// setgid for `g`, both for `a`.
	class_specials: u32,
	/// `rwx` spread over `classes`, already filtered by `allowed`.
	perms: u32,
	/// `X` was present: execute is granted only to dirs and executable files.
	cond_exec: bool,
	/// Setuid/setgid/sticky bits named via `s`/`t`.
	specials: u32,
	/// Copy source triplet (`USER`, `GROUP`, `OTHER`), or 0.
	copy_from: u32,
	/// Result bits a clause may grant or copy: everything when a class was
	/// named, else what the umask leaves.
	allowed: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Action {
	/// Octal form: the permission bits become exactly this value.
	Set(u32),
	Symbolic(Symbolic),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Clause {
	scope: Scope,
	action: Action,
}

/// Parsed --chmod rules (D/F prefixes, ugoa, +-=, rwxXst, octal).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ChmodRules {
	clauses: Vec<Clause>,
}

impl ChmodRules {
	/// Parses one `--chmod` argument and appends its clauses to `prior` (multiple
	/// `--chmod` options accumulate). Who-less clauses honor the host process umask
	/// (`0o022` on Windows). The error is upstream's message, without a trailing newline.
	pub(crate) fn parse(spec: &str, prior: Option<Self>) -> Result<Self, String> {
		#[cfg(unix)]
		let umask = crate::host::process_umask();
		#[cfg(not(unix))]
		let umask = 0o022;
		Self::parse_with_umask(spec, prior, umask)
	}

	/// [`ChmodRules::parse`] with an explicit umask (the shell's, when it has one).
	pub(crate) fn parse_with_umask(
		spec: &str,
		prior: Option<Self>,
		umask: u32,
	) -> Result<Self, String> {
		let invalid = || format!("Invalid argument passed to --chmod ({spec})");
		let mut rules = prior.unwrap_or_default();
		for part in spec.as_bytes().split(|&b| b == b',') {
			rules.clauses.push(parse_clause(part, umask).ok_or_else(invalid)?);
		}
		Ok(rules)
	}

	/// Applies every clause in order to `mode` (type bits included, which select
	/// `D`/`F` clauses and are preserved).
	pub(crate) fn apply(&self, mode: u32) -> u32 {
		let type_bits = mode & !CHMOD_BITS;
		let is_dir = mode_is_dir(mode);
		let was_exec = mode & 0o111 != 0;
		let mut perms = mode & CHMOD_BITS;
		for clause in &self.clauses {
			match clause.scope {
				Scope::Dirs if !is_dir => continue,
				Scope::Files if is_dir => continue,
				_ => {},
			}
			perms = match clause.action {
				Action::Set(value) => value,
				Action::Symbolic(sym) => apply_symbolic(&sym, perms, is_dir, was_exec),
			};
		}
		perms | type_bits
	}
}

/// One clause's effect on the permission bits `perms`.
fn apply_symbolic(sym: &Symbolic, perms: u32, is_dir: bool, was_exec: bool) -> u32 {
	// The copy source is read before this clause changes anything.
	let copied = if sym.copy_from == 0 {
		0
	} else {
		(sym.classes * triplet(perms, sym.copy_from)) & sym.allowed
	};
	let mut grant = sym.perms;
	if sym.cond_exec && !was_exec && !is_dir {
		grant &= !0o111;
	}
	match sym.op {
		Op::Add => perms | grant | sym.specials | copied,
		Op::Remove => perms & !(sym.perms | sym.specials | copied),
		Op::Assign => {
			let mut clear = sym.classes * 7;
			if sym.specials != 0 {
				clear |= sym.class_specials;
			}
			if sym.copy_from != 0 {
				clear |= dest_specials(sym.classes);
			}
			(perms & !clear) | grant | sym.specials | copied
		},
	}
}

/// The rwx value (0..=7) of the triplet selected by `class`.
const fn triplet(perms: u32, class: u32) -> u32 {
	match class {
		USER => (perms >> 6) & 7,
		GROUP => (perms >> 3) & 7,
		_ => perms & 7,
	}
}

/// Special bits "belonging" to the destination triplets of a copy (`=` clears them).
const fn dest_specials(classes: u32) -> u32 {
	let mut bits = 0;
	if classes & USER != 0 {
		bits |= S_ISUID;
	}
	if classes & GROUP != 0 {
		bits |= S_ISGID;
	}
	if classes & OTHER != 0 {
		bits |= S_ISVTX;
	}
	bits
}

/// Parses one comma-free clause; `None` when it is malformed.
fn parse_clause(text: &[u8], umask: u32) -> Option<Clause> {
	let mut scope = Scope::Any;
	let mut classes = 0u32;
	let mut class_specials = 0u32;
	let mut i = 0;
	// Prefix: D/F and the class letters, in any order.
	let op = loop {
		let &c = text.get(i)?;
		i += 1;
		match c {
			b'D' => {
				if scope == Scope::Files {
					return None;
				}
				scope = Scope::Dirs;
			},
			b'F' => {
				if scope == Scope::Dirs {
					return None;
				}
				scope = Scope::Files;
			},
			b'u' => {
				classes |= USER;
				class_specials |= S_ISUID;
			},
			b'g' => {
				classes |= GROUP;
				class_specials |= S_ISGID;
			},
			b'o' => classes |= OTHER,
			b'a' => {
				classes |= ALL;
				class_specials |= S_ISUID | S_ISGID;
			},
			b'+' => break Op::Add,
			b'-' => break Op::Remove,
			b'=' => break Op::Assign,
			b'0'..=b'7' if classes == 0 => {
				let value = parse_octal(&text[i - 1..])?;
				return Some(Clause { scope, action: Action::Set(value) });
			},
			_ => return None,
		}
	};

	let mut rwx = 0u32;
	let mut cond_exec = false;
	let mut specials = 0u32;
	let mut copy_from = 0u32;
	for &c in &text[i..] {
		let copy_class = match c {
			b'u' => Some(USER),
			b'g' => Some(GROUP),
			b'o' => Some(OTHER),
			_ => None,
		};
		if let Some(class) = copy_class {
			if rwx != 0 || specials != 0 || copy_from != 0 {
				return None;
			}
			copy_from = class;
			continue;
		}
		if copy_from != 0 {
			return None;
		}
		match c {
			b'r' => rwx |= 4,
			b'w' => rwx |= 2,
			b'x' => rwx |= 1,
			b'X' => {
				rwx |= 1;
				cond_exec = true;
			},
			b's' => {
				if class_specials == 0 {
					specials = S_ISUID;
				} else {
					specials |= class_specials;
				}
			},
			b't' => specials |= S_ISVTX,
			_ => return None,
		}
	}

	let named = classes != 0;
	let classes = if named { classes } else { ALL };
	let allowed = if named { CHMOD_BITS } else { !umask & CHMOD_BITS };
	Some(Clause {
		scope,
		action: Action::Symbolic(Symbolic {
			op,
			classes,
			class_specials,
			perms: (classes * rwx) & allowed,
			cond_exec,
			specials,
			copy_from,
			allowed,
		}),
	})
}

/// All-octal-digit tail of an octal clause, at most `07777`.
fn parse_octal(digits: &[u8]) -> Option<u32> {
	let mut value = 0u32;
	for &d in digits {
		if !(b'0'..=b'7').contains(&d) {
			return None;
		}
		value = value * 8 + u32::from(d - b'0');
		if value > CHMOD_BITS {
			return None;
		}
	}
	Some(value)
}


