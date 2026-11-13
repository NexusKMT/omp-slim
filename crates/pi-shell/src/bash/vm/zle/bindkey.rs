//! The `bindkey` builtin (zsh 5.9 `Src/Zle/zle_keymap.c` `bin_bindkey`
//! and its operations, `zle_utils.c` `bindztrdup`/`printbind`), over the
//! keymaps of the vproc's editor state ([`super::Zle::keymaps`]).
//!
//! Relinking `main` (`-e`, `-v`, `-A … main`, `-N main`, `-D`, `-d`) needs
//! no separate step for a line in progress: the reader resolves the
//! current keymap by name for every key, which is zsh's `reselectkeymap`
//! after each widget (falling back to `.safe` with a `No such keymap`
//! warning when the name is gone).
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use std::sync::Arc;

use bstr::BString;

use super::{
	bindings,
	keymap::{Bind, Keymap, Keymaps, MapOrigin, UnlinkError, default_main_vi},
};
use crate::bash::{
	store::Attrs,
	syntax::zsh::tok,
	vm::{
		builtins::{
			Ctx, Need, R, done,
			zsh_args::{Ops, isset},
			zsh_print::charset,
			zsh_quote::{Charset, niceformat, quotedzputs},
		},
		zle,
		zsh::text::{getkey, getkeystring},
	},
	zshopt::ZshOpt,
};

/// The options that pick a `bindkey` operation, in zsh's precedence order
/// (`opns[]`): letter, whether a keymap is selected for it, fewest and
/// most arguments. No letter: bind or list (`func` 0).
const OPNS: [(u8, bool, usize, Option<usize>); 8] = [
	(b'l', false, 0, None),
	(b'd', false, 0, Some(0)),
	(b'D', false, 1, None),
	(b'A', false, 2, Some(2)),
	(b'N', false, 1, Some(2)),
	(b'm', true, 0, Some(0)),
	(b'r', true, 1, None),
	(b's', true, 2, None),
];

/// How names and strings print: the character set, `RC_QUOTES` and
/// `CSH_JUNKIE_QUOTES`.
#[derive(Clone, Copy, Debug, Default)]
struct Fmt {
	cs:  Charset,
	rc:  bool,
	csh: bool,
}

impl Fmt {
	/// zsh `nicezputs`.
	fn nice(self, s: &[u8]) -> Vec<u8> {
		niceformat(s, false, self.cs)
	}

	/// zsh `quotedzputs`.
	fn quoted(self, s: &[u8]) -> Vec<u8> {
		quotedzputs(s, self.rc, self.cs)
	}

	/// A `%s` of a zsh warning (`nicezputs`).
	fn arg(self, s: &[u8]) -> String {
		String::from_utf8_lossy(&self.nice(s)).into_owned()
	}
}

/// What `bindkey` printed and warned, in order.
enum Ev {
	Out(Vec<u8>),
	Warn(String),
}

/// The output of one `bindkey` run.
struct Report {
	fmt: Fmt,
	ev:  Vec<Ev>,
}

impl Report {
	const fn new(fmt: Fmt) -> Self {
		Self { fmt, ev: Vec::new() }
	}

	fn out(&mut self, b: &[u8]) {
		if b.is_empty() {
			return;
		}
		if let Some(Ev::Out(o)) = self.ev.last_mut() {
			o.extend_from_slice(b);
		} else {
			self.ev.push(Ev::Out(b.to_vec()));
		}
	}

	/// zsh `zwarnnam(name, …)`.
	fn warn(&mut self, msg: String) {
		self.ev.push(Ev::Warn(msg));
	}
}

/// zsh `getkeystring(s, &len, GETKEYS_BINDKEY, NULL)` of a raw argument:
/// the raw key sequence (`^X`, `\e`, `\M-x`, `\C-x`, octal and hex
/// escapes).
pub fn getkeys(s: &[u8]) -> Vec<u8> {
	getkeystring(&tok::metafy(s), getkey::KEYS_BINDKEY).text
}

/// zsh `bindztrdup` (`printbind`): raw key sequence `s` in the double
/// quoted `^X`/`\M-x` form listings show; `csh` is `CSH_JUNKIE_QUOTES`.
pub fn bindztrdup(s: &[u8], csh: bool) -> Vec<u8> {
	let mut buf = Vec::with_capacity(s.len() * 2);
	for &b in s {
		let mut c = b;
		if c & 0x80 != 0 {
			buf.extend_from_slice(b"\\M-");
			c &= 0x7f;
		}
		if c < 32 || c == 0x7f {
			buf.push(b'^');
			c ^= 64;
		}
		if c == b'\\' || c == b'^' {
			buf.push(b'\\');
		}
		buf.push(c);
	}
	dquotedztrdup(&buf, csh)
}

/// zsh `dquotedztrdup`: `s` double quoted.
fn dquotedztrdup(s: &[u8], csh: bool) -> Vec<u8> {
	let mut p = Vec::with_capacity(s.len() * 2 + 2);
	if csh {
		let mut inquote = false;
		for &c in s {
			match c {
				b'"' | b'$' | b'`' => {
					if inquote {
						p.push(b'"');
						inquote = false;
					}
					p.push(b'\\');
					p.push(c);
				},
				_ => {
					if !inquote {
						p.push(b'"');
						inquote = true;
					}
					if c == b'\n' {
						p.push(b'\\');
					}
					p.push(c);
				},
			}
		}
		if inquote {
			p.push(b'"');
		}
	} else {
		let mut pending = false;
		p.push(b'"');
		for &c in s {
			match c {
				b'\\' => {
					if pending {
						p.push(b'\\');
					}
					p.push(b'\\');
					pending = true;
				},
				b'"' | b'$' | b'`' => {
					if pending {
						p.push(b'\\');
					}
					p.push(b'\\');
					p.push(c);
					pending = false;
				},
				_ => {
					p.push(c);
					pending = false;
				},
			}
		}
		if pending {
			p.push(b'\\');
		}
		p.push(b'"');
	}
	p
}

/// An exported variable's value (zsh `zgetenv`).
fn getenv(ctx: &mut Ctx<'_, '_>, name: &[u8]) -> Result<Option<BString>, Need> {
	Ok(ctx
		.var(name)?
		.filter(|v| v.attrs.contains(Attrs::EXPORT))
		.and_then(|v| v.as_scalar().map(BString::from)))
}

/// zsh `bin_bindkey`: the `bindkey` builtin (options already parsed with
/// optstring `evaM:ldDANmrsLRp`).
pub fn bindkey(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	let fmt = Fmt {
		cs:  charset(ctx)?,
		rc:  isset(ctx, ZshOpt::Rcquotes)?,
		csh: isset(ctx, ZshOpt::Cshjunkiequotes)?,
	};
	// `bindkey -d` builds the defaults again, `main` chosen from the
	// environment as at startup.
	let main_vi = if ops.isset(b'd') {
		let visual = getenv(ctx, b"VISUAL")?;
		let editor = getenv(ctx, b"EDITOR")?;
		default_main_vi(visual.as_ref().map(|v| v.as_slice()), editor.as_ref().map(|v| v.as_slice()))
	} else {
		false
	};
	let mut rep = Report::new(fmt);
	let status = {
		let z = zle::zle_mut(ctx.k, ctx.cx, ctx.vp);
		run(&mut z.keymaps, ops, args, main_vi, &mut rep)
	};
	for ev in rep.ev {
		match ev {
			Ev::Out(b) => ctx.out(&b),
			Ev::Warn(m) => ctx.usage(m),
		}
	}
	done(status)
}

/// zsh `bin_bindkey` over `kms`: the operation's status.
fn run(
	kms: &mut Arc<Keymaps>,
	ops: &Ops,
	args: &[BString],
	main_vi: bool,
	rep: &mut Report,
) -> i32 {
	let fmt = rep.fmt;
	// Select the operation and ensure no clashing options.
	let op = OPNS.iter().position(|o| ops.isset(o.0));
	if let Some(i) = op
		&& OPNS[i + 1..].iter().any(|o| ops.isset(o.0))
	{
		rep.warn("incompatible operation selection options".into());
		return 1;
	}
	let (o, selp, min, max) = op.map_or((0, true, 0, None), |i| OPNS[i]);
	let n = b"evaM".iter().filter(|&&c| ops.isset(c)).count();
	if !selp && n != 0 {
		rep.warn(format!("keymap cannot be selected with -{}", char::from(o)));
		return 1;
	}
	if n > 1 {
		rep.warn("incompatible keymap selection options".into());
		return 1;
	}

	// Keymap selection.
	let sel = if selp {
		let kmname: &[u8] = if ops.isset(b'e') {
			b"emacs"
		} else if ops.isset(b'v') {
			b"viins"
		} else if ops.isset(b'a') {
			b"vicmd"
		} else if ops.isset(b'M') {
			ops.arg(b'M').unwrap_or_default()
		} else {
			b"main"
		};
		let Some(id) = kms.open(kmname) else {
			rep.warn(format!("no such keymap `{}'", fmt.arg(kmname)));
			return 1;
		};
		if ops.isset(b'e') || ops.isset(b'v') {
			// zsh ignores linkkeymap's result: only an immortal `main`
			// (which nothing creates) could refuse.
			let _ = Arc::make_mut(kms).link(id, b"main", false);
		}
		Some((kmname, id))
	} else {
		None
	};

	// Listing is a special case.
	if o == 0 && args.len() < 2 {
		if ops.isset(b'e') || ops.isset(b'v') {
			return 0;
		}
		let Some((kmname, id)) = sel else {
			return 1;
		};
		let Some(km) = kms.keymap(id) else {
			return 1;
		};
		return list(km, kmname, args, ops.isset(b'L'), ops.isset(b'p'), rep);
	}

	// Check the number of arguments.
	if args.len() < min {
		rep.warn(format!("not enough arguments for -{}", char::from(o)));
		return 1;
	}
	if max.is_some_and(|m| args.len() > m) {
		rep.warn(format!("too many arguments for -{}", char::from(o)));
		return 1;
	}

	match (o, sel) {
		(b'l', _) => lsmaps(kms, args, ops.isset(b'L'), rep),
		(b'd', _) => {
			Arc::make_mut(kms).reset(main_vi);
			0
		},
		(b'D', _) => del(kms, args, rep),
		(b'A', _) => link(kms, args, rep),
		(b'N', _) => new(kms, args, rep),
		(b'm', Some((kmname, id))) => meta(kms, kmname, id, rep),
		(b'r' | b's' | 0, Some((kmname, id))) => bind(kms, kmname, id, args, ops, o, rep),
		_ => 1,
	}
}

/// zsh `bin_bindkey_lsmaps` (`-l`): the named keymaps, or all of them
/// sorted; `long` (`-L`) as `bindkey -N`/`-A` commands.
fn lsmaps(kms: &Keymaps, args: &[BString], long: bool, rep: &mut Report) -> i32 {
	let mut ret = 0;
	if args.is_empty() {
		for name in kms.sorted_names() {
			listmap(kms, &name, long, rep);
		}
	} else {
		for a in args {
			if kms.exists(a) {
				listmap(kms, a, long, rep);
			} else {
				rep.warn(format!("no such keymap: `{}'", rep.fmt.arg(a)));
				ret = 1;
			}
		}
	}
	ret
}

/// zsh `scanlistmaps`: one name of `bindkey -l`.
fn listmap(kms: &Keymaps, name: &[u8], long: bool, rep: &mut Report) {
	let fmt = rep.fmt;
	let mut out = Vec::new();
	if long {
		// `.safe` is not listed as a command: it cannot be created so.
		let Some(primary) = kms.primary_of(name) else {
			return;
		};
		out.extend_from_slice(b"bindkey -");
		if let MapOrigin::Linked(p) = primary {
			out.extend_from_slice(b"A ");
			if p.first() == Some(&b'-') {
				out.extend_from_slice(b"-- ");
			}
			out.extend_from_slice(&fmt.quoted(&p));
			out.push(b' ');
		} else {
			out.extend_from_slice(b"N ");
			if name.first() == Some(&b'-') {
				out.extend_from_slice(b"-- ");
			}
		}
		out.extend_from_slice(&fmt.quoted(name));
	} else {
		out.extend_from_slice(&fmt.nice(name));
	}
	out.push(b'\n');
	rep.out(&out);
}

/// zsh `bin_bindkey_del` (`-D`).
fn del(kms: &mut Arc<Keymaps>, args: &[BString], rep: &mut Report) -> i32 {
	let mut ret = 0;
	for a in args {
		match Arc::make_mut(kms).unlink(a, false) {
			Ok(()) => {},
			Err(UnlinkError::Protected) => {
				rep.warn(format!("keymap name `{}' is protected", rep.fmt.arg(a)));
				ret = 1;
			},
			Err(UnlinkError::NoSuchKeymap) => {
				rep.warn(format!("no such keymap `{}'", rep.fmt.arg(a)));
				ret = 1;
			},
		}
	}
	ret
}

/// zsh `bin_bindkey_link` (`-A old new`).
fn link(kms: &mut Arc<Keymaps>, args: &[BString], rep: &mut Report) -> i32 {
	let (from, to) = (&args[0], &args[1]);
	let Some(id) = kms.open(from) else {
		rep.warn(format!("no such keymap `{}'", rep.fmt.arg(from)));
		return 1;
	};
	if Arc::make_mut(kms).link(id, to, false).is_err() {
		rep.warn(format!("keymap name `{}' is protected", rep.fmt.arg(to)));
		return 1;
	}
	0
}

/// zsh `bin_bindkey_new` (`-N name [old]`).
fn new(kms: &mut Arc<Keymaps>, args: &[BString], rep: &mut Report) -> i32 {
	let name = &args[0];
	if kms.immortal(name) {
		rep.warn(format!("keymap name `{}' is protected", rep.fmt.arg(name)));
		return 1;
	}
	let copy = match args.get(1) {
		Some(old) => {
			let Some(id) = kms.open(old) else {
				rep.warn(format!("no such keymap `{}'", rep.fmt.arg(old)));
				return 1;
			};
			Some(id)
		},
		None => None,
	};
	if Arc::make_mut(kms).create(name, copy, false).is_err() {
		rep.warn(format!("keymap name `{}' is protected", rep.fmt.arg(name)));
		return 1;
	}
	0
}

/// zsh `bin_bindkey_meta` (`-m`): bind the meta keys of `metabind` that
/// are unbound or `self-insert`.
fn meta(kms: &mut Arc<Keymaps>, kmname: &[u8], id: super::keymap::KmId, rep: &mut Report) -> i32 {
	if kms.keymap(id).is_none_or(Keymap::immutable) {
		rep.warn(format!("keymap `{}' is protected", rep.fmt.arg(kmname)));
		return 1;
	}
	rep.warn("warning: `bindkey -m' disables multibyte support".into());
	let kms = Arc::make_mut(kms);
	for (i, wid) in bindings::META.iter().enumerate() {
		let (Some(wid), Ok(c)) = (*wid, u8::try_from(i + 128)) else {
			continue;
		};
		let rebind = kms.keymap(id).is_some_and(|km| match km.lookup(&[c]) {
			None => true,
			Some(Bind::Widget(w)) => w.as_slice() == b"self-insert" || w.as_slice() == b".self-insert",
			Some(Bind::Str(_)) => false,
		});
		if rebind {
			// The keymap is mutable and the sequence not empty.
			let _ = kms.bind(id, &[c], Some(Bind::widget(wid)));
		}
	}
	0
}

/// zsh `bin_bindkey_bind`: `-r` (unbind), `-s` (send strings) or plain
/// (widgets) bindings, of key ranges with `-R`, or `-rp` (unbind every
/// sequence a prefix starts).
fn bind(
	kms: &mut Arc<Keymaps>,
	kmname: &[u8],
	id: super::keymap::KmId,
	args: &[BString],
	ops: &Ops,
	func: u8,
	rep: &mut Report,
) -> i32 {
	if func != b'r' && !args.len().is_multiple_of(2) {
		rep.warn("even number of arguments required".into());
		return 1;
	}
	if kms.keymap(id).is_none_or(Keymap::immutable) {
		rep.warn(format!("keymap `{}' is protected", rep.fmt.arg(kmname)));
		return 1;
	}
	let kms = Arc::make_mut(kms);
	if func == b'r' && ops.isset(b'p') {
		for a in args {
			let prefix = getkeys(a);
			let mut seqs: Vec<Vec<u8>> = Vec::new();
			if let Some(km) = kms.keymap(id) {
				km.scan_entries(&mut |seq, _| {
					if seq.starts_with(&prefix) && seq.len() > prefix.len() {
						seqs.push(seq.to_vec());
					}
				});
			}
			for seq in seqs {
				// The keymap is mutable and the sequence not empty.
				let _ = kms.bind(id, &seq, None);
			}
		}
		return 0;
	}
	let mut ret = 0;
	let mut i = 0;
	while i < args.len() {
		let useq = &args[i];
		let b = match func {
			b'r' => None,
			b's' => {
				i += 1;
				Some(Bind::Str(BString::from(getkeys(&args[i]))))
			},
			_ => {
				i += 1;
				Some(Bind::Widget(args[i].clone()))
			},
		};
		let bseq = getkeys(useq);
		if ops.isset(b'R') {
			let len = bseq.len();
			let dash = usize::from(bseq.get(1) == Some(&b'-'));
			if len < 2 || len > 2 + dash || bseq[0] > bseq[len - 1] {
				rep.warn(format!("malformed key range `{}'", rep.fmt.arg(useq)));
				ret = 1;
			} else {
				for c in bseq[0]..=bseq[len - 1] {
					// The keymap is mutable and the sequence not empty.
					let _ = kms.bind(id, &[c], b.clone());
				}
			}
		} else if kms.bind(id, &bseq, b).is_err() {
			rep.warn("cannot bind to an empty key sequence".into());
			ret = 1;
		}
		i += 1;
	}
	ret
}

/// zsh `struct bindstate`: the run of bindings being listed.
struct ListState<'a> {
	kmname: &'a [u8],
	/// `BS_LIST` (`-L`).
	long:   bool,
	/// `BS_ALL`: list an unbound key too.
	all:    bool,
	first:  Vec<u8>,
	last:   Vec<u8>,
	bind:   Option<Bind>,
}

/// zsh `bin_bindkey_list`: one key's binding, the bindings a prefix
/// starts (`-p`), or the whole keymap; `long` (`-L`) as `bindkey`
/// commands.
fn list(
	km: &Keymap,
	kmname: &[u8],
	args: &[BString],
	long: bool,
	pflag: bool,
	rep: &mut Report,
) -> i32 {
	let fmt = rep.fmt;
	let mut st =
		ListState { kmname, long, all: false, first: Vec::new(), last: Vec::new(), bind: None };
	if let (Some(a), false) = (args.first(), pflag) {
		let seq = getkeys(a);
		st.all = true;
		st.bind = km.lookup(&seq).cloned();
		st.first.clone_from(&seq);
		st.last = seq;
		let out = bindlistout(&st, fmt);
		rep.out(&out);
		return 0;
	}
	// An empty prefix is no prefix.
	let prefix = if pflag && args.first().is_none_or(|a| !a.is_empty()) {
		let Some(a) = args.first() else {
			rep.warn("option -p requires a prefix string".into());
			return 1;
		};
		getkeys(a)
	} else {
		Vec::new()
	};
	let mut out = Vec::new();
	km.scan_entries(&mut |seq, bind| {
		if !prefix.is_empty() && (!seq.starts_with(&prefix) || seq.len() <= prefix.len()) {
			return;
		}
		if let ([t], [l]) = (seq, st.last.as_slice())
			&& bind == st.bind.as_ref()
			&& l.checked_add(1) == Some(*t)
		{
			st.last = seq.to_vec();
			return;
		}
		out.extend_from_slice(&bindlistout(&st, fmt));
		st.first = seq.to_vec();
		st.last = seq.to_vec();
		st.bind = bind.cloned();
	});
	out.extend_from_slice(&bindlistout(&st, fmt));
	rep.out(&out);
	0
}

/// zsh `bindlistout`: one line of a listing (a key or a range of keys
/// with the same binding).
fn bindlistout(st: &ListState<'_>, fmt: Fmt) -> Vec<u8> {
	let mut out = Vec::new();
	if st.bind.is_none() && !st.all {
		return out;
	}
	let range = st.first != st.last;
	if st.long {
		let mut nodash = true;
		out.extend_from_slice(b"bindkey ");
		if range {
			out.extend_from_slice(b"-R ");
		}
		if matches!(st.bind, Some(Bind::Str(_))) {
			out.extend_from_slice(b"-s ");
		}
		match st.kmname {
			b"main" => {},
			b"vicmd" => out.extend_from_slice(b"-a "),
			name => {
				out.extend_from_slice(b"-M ");
				out.extend_from_slice(&fmt.quoted(name));
				out.push(b' ');
				nodash = false;
			},
		}
		if nodash && st.first.first() == Some(&b'-') {
			out.extend_from_slice(b"-- ");
		}
	}
	out.extend_from_slice(&bindztrdup(&st.first, fmt.csh));
	if range {
		out.push(b'-');
		out.extend_from_slice(&bindztrdup(&st.last, fmt.csh));
	}
	out.push(b' ');
	match &st.bind {
		Some(Bind::Str(s)) => out.extend_from_slice(&bindztrdup(s, fmt.csh)),
		b => {
			let name = match b {
				Some(Bind::Widget(w)) => w.as_slice(),
				_ => super::keymap::UNDEFINED_KEY,
			};
			out.extend_from_slice(&if st.long {
				fmt.quoted(name)
			} else {
				fmt.nice(name)
			});
		},
	}
	out.push(b'\n');
	out
}


