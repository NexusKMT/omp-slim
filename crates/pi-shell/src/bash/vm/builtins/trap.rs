//! The `trap` special builtin: list, set and reset signal and pseudo-signal
//! traps (bash `traps.c`).

use bstr::{BStr, BString};

use super::{Ctx, R, done, opts};
use crate::bash::{
	diag::Diag,
	signal::Signal,
	store::{Key, KeyBuf, MiscKey, OptId, Record, StateStore, StoreError, Table, TrapKey},
	vm::{
		Kernel,
		exec::mode_of,
		proc::{FrameKind, ScriptKind, Vproc},
		quote, state,
	},
};

fn key(spec: &[u8], platform: crate::bash::ids::Platform) -> Option<TrapKey> {
	match spec.to_ascii_uppercase().as_slice() {
		b"0" | b"EXIT" => Some(TrapKey::Exit),
		b"ERR" => Some(TrapKey::Err),
		b"DEBUG" => Some(TrapKey::Debug),
		b"RETURN" => Some(TrapKey::Return),
		_ => Signal::parse_spec(spec, platform).map(TrapKey::Signal),
	}
}

fn name(key: TrapKey) -> String {
	match key {
		TrapKey::Signal(sig) => format!("SIG{sig}"),
		TrapKey::Exit => "EXIT".into(),
		TrapKey::Err => "ERR".into(),
		TrapKey::Debug => "DEBUG".into(),
		TrapKey::Return => "RETURN".into(),
	}
}

fn print(ctx: &mut Ctx<'_, '_>, key: TrapKey, action: &[u8]) {
	let mut line = b"trap -- ".to_vec();
	line.extend_from_slice(&quote::single(action));
	line.push(b' ');
	line.extend_from_slice(name(key).as_bytes());
	line.push(b'\n');
	ctx.out(&line);
}

pub(super) fn trap(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	// bash parses `-l`, `-p` and `-P` with `internal_getopt`; anything else
	// is an invalid option with the usage line.
	let o = match opts(ctx, args, b"lpP", b"", false) {
		Ok(o) => o,
		Err(st) => return done(st),
	};
	let (printing, action_only) = (o.has(b'p'), o.has(b'P'));
	let args = o.rest;
	if printing && action_only {
		ctx.usage("cannot specify both -p and -P");
		return done(2);
	}
	if action_only && args.is_empty() {
		ctx.usage("-P requires at least one signal name");
		return done(2);
	}
	if o.has(b'l') {
		// The same table as `kill -l` (bash's `display_signal_list`).
		return super::kill::list(ctx, &[]);
	}
	if args.is_empty() {
		let mut records = state::listed_traps(&ctx.k.root, ctx.cx.store, ctx.vp)?;
		let platform = ctx.k.engine.config().platform;
		records.sort_by_key(|(key, _)| match key {
			KeyBuf::Trap(TrapKey::Exit) => 0,
			KeyBuf::Trap(TrapKey::Signal(sig)) => u16::from(sig.number(platform)),
			KeyBuf::Trap(TrapKey::Debug) => 256,
			KeyBuf::Trap(TrapKey::Err) => 257,
			KeyBuf::Trap(TrapKey::Return) => 258,
			_ => 259,
		});
		for (key, rec) in records {
			if let (KeyBuf::Trap(key), Record::Trap { action, .. }) = (key, rec) {
				print(ctx, key, &action);
			}
		}
		return done(0);
	}
	let platform = ctx.k.engine.config().platform;
	if printing || action_only {
		let listed = state::listed_traps(&ctx.k.root, ctx.cx.store, ctx.vp)?;
		let mut status = 0;
		for spec in args {
			let Some(key) = key(spec, platform) else {
				ctx.diag(Diag::InvalidSignal { cmd: "trap".into(), spec: spec.clone() });
				status = 1;
				continue;
			};
			let found = listed.iter().find(|(k, _)| *k == KeyBuf::Trap(key));
			if let Some((_, Record::Trap { action, .. })) = found {
				if action_only {
					// `-P`: the action alone (bash's `DISP_ACTIONONLY`).
					let mut line = action.to_vec();
					line.push(b'\n');
					ctx.out(&line);
				} else {
					print(ctx, key, action);
				}
			}
		}
		return done(status);
	}
	// bash `trap_builtin`: a lone signal number (or, outside posix mode, a
	// lone signal name) resets it; otherwise the first word is the action
	// (`-` resets), and an action without signals is a usage error.
	let first = &args[0];
	let is_signal = |s: &[u8]| key(s, platform).is_some();
	let lone_name = args.len() == 1
		&& !first.is_empty()
		&& first.as_slice() != b"-"
		&& is_signal(first)
		&& !ctx.option(OptId::Posix)?;
	let (action, specs) =
		if (!first.is_empty() && first.iter().all(u8::is_ascii_digit) && is_signal(first))
			|| lone_name
		{
			(None, args)
		} else {
			let specs = &args[1..];
			if specs.is_empty() {
				ctx.builtin_usage();
				return done(2);
			}
			((first.as_slice() != b"-").then(|| first.clone()), specs)
		};
	let hard_ignored = match ctx.vp.overlay {
		Some(_) => match ctx.record(Key::Misc(MiscKey::HardIgnored))? {
			Some(Record::Words(names)) => names,
			_ => Vec::new(),
		},
		None => Vec::new(),
	};
	// bash `free_trap_strings`: a subshell that changes a trap stops
	// listing the caught-signal traps it inherited.
	if ctx.vp.parent.is_some() {
		let inherited: Vec<KeyBuf> = state::listed_traps(&ctx.k.root, ctx.cx.store, ctx.vp)?
			.into_iter()
			.filter(
				|(key, r)| matches!(key, KeyBuf::Trap(key) if state::inherited_trap(ctx.vp, *key, Some(r))),
			)
			.map(|(key, _)| key)
			.collect();
		for key in inherited {
			ctx.store_record(key, None);
		}
	}
	let mut status = 0;
	for spec in specs {
		let Some(key) = key(spec, platform) else {
			ctx.diag(Diag::InvalidSignal { cmd: "trap".into(), spec: spec.clone() });
			status = 1;
			continue;
		};
		// A signal ignored when this (new) shell started stays ignored.
		if let TrapKey::Signal(sig) = key
			&& hard_ignored
				.iter()
				.any(|n| n.as_slice() == sig.to_string().as_bytes())
		{
			continue;
		}
		let mut effective = action.clone();
		if ctx.vp.overlay.is_none()
			&& let TrapKey::Signal(sig) = key
			// `CHLD` comes from the engine (one per reaped child), not the OS.
			&& !matches!(sig, Signal::Kill | Signal::Stop | Signal::Chld)
		{
			// The root shell's OS disposition follows its traps (signals
			// ignored on entry stay ignored, as in a non-interactive bash).
			let disposition = crate::bash::vm::jobctl::trap_disposition(
				ctx.k,
				sig,
				effective.as_ref().map(BStr::new),
			);
			match ctx.cx.host.set_signal_trap(sig, disposition) {
				Ok(true) => {},
				Ok(false) => effective = Some(BString::default()),
				Err(err) => {
					ctx.err(Diag::SignalSetup { sig, err });
					status = 1;
					continue;
				},
			}
		}
		let record = effective.map(|action| Record::Trap { mode: mode_of(ctx.vp), action });
		// The innermost function (for DEBUG also `.` file) and the vproc
		// now run it as their own rather than an inherited trap.
		ctx.vp.own_traps = ctx.vp.own_traps.with(key);
		if let Some(frame) = ctx.vp.frames.iter_mut().rev().find(|f| {
			matches!(f.kind, FrameKind::Function { .. })
				|| (key == TrapKey::Debug
					&& matches!(f.kind, FrameKind::Script { what: ScriptKind::Source, .. }))
		}) {
			match key {
				TrapKey::Debug => frame.debug_trap_local = true,
				TrapKey::Err => frame.err_trap_local = true,
				TrapKey::Return => frame.return_trap_local = true,
				TrapKey::Exit | TrapKey::Signal(_) => {},
			}
		}
		if matches!(&record, Some(Record::Trap { action, .. }) if !action.is_empty()) {
			ctx.k.pseudo_traps.note(key);
		}
		ctx.store_record(KeyBuf::Trap(key), record);
	}
	done(status)
}

/// bash: a new shell (a script run as `ENOEXEC`) cannot trap or reset the
/// signals ignored when it starts. Records in `child` the signals `parent`
/// ignores; the nested shell's `fresh_shell` (also a script run as
/// `ENOEXEC`) calls it on the child it creates.
///
/// # Errors
///
/// A store failure reading the parent's traps.
pub fn hard_ignore(
	k: &mut Kernel,
	store: &mut dyn StateStore,
	parent: &Vproc,
	child: &mut Vproc,
) -> Result<(), StoreError> {
	let names: Vec<BString> = state::scan(&k.root, store, parent, Table::Trap)?
		.into_iter()
		.filter_map(|(key, rec)| match (key, rec) {
			(KeyBuf::Trap(TrapKey::Signal(sig)), Record::Trap { action, .. }) if action.is_empty() => {
				Some(BString::from(sig.to_string()))
			},
			_ => None,
		})
		.collect();
	if !names.is_empty() {
		state::store_record(
			&mut k.root,
			store,
			child,
			KeyBuf::Misc(MiscKey::HardIgnored),
			Some(Record::Words(names)),
		);
	}
	Ok(())
}
