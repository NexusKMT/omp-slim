//! Control-flow builtins: `eval`, `source`, `return`, `exit`, `break`,
//! `continue`, `wait`.

use bstr::{BString, ByteSlice};

use super::{Control, Ctx, Outcome, R, Wait, done, number, opts};
use crate::bash::{
	diag::Diag,
	event::EventData,
	fs::StatKind,
	ids::Vpid,
	store::{Key, KeyBuf, MiscKey, OptId, Record},
	vm::{
		exec::push_script,
		locale,
		probe::{absolute, candidates},
		proc::{Probe, ProbeResult, ScriptKind},
		quote,
	},
};

/// `eval arg …`: run the joined arguments as a script in this shell.
pub fn eval(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	// bash's `no_options`: `--` is skipped, any option is invalid.
	let args = match opts(ctx, args, b"", b"", false) {
		Ok(o) => o.rest,
		Err(st) => return done(st),
	};
	if args.is_empty() {
		return done(0);
	}
	let src = bstr::join(b" ", args);
	// `$?` stays the caller's until the text runs its first command; text
	// without one ends with status 0 (the script frame's end).
	push_script(ctx.vp, &src, ctx.line, ScriptKind::Eval);
	ctx.k.emit_op(ctx.cx, ctx.vp, 0, EventData::EvalEnter);
	Ok(Outcome { status: 0, control: Control::Frame })
}

/// `source [-p path] file [args]` / `. …`: run `file` in this shell. A
/// name without `/` is looked up in `-p`'s path (only there) or, with
/// `sourcepath`, in `$PATH` and then the current directory (not in posix
/// mode). In posix mode a failure ends the shell (a special builtin, not
/// through `command`).
pub fn source(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let (search_arg, args) = match args {
		[p, path, rest @ ..] if p.as_slice() == b"-p" => (Some(path), rest),
		[dd, rest @ ..] if dd.as_slice() == b"--" => (None, rest),
		[opt, ..] if opt.len() > 1 && opt[0] == b'-' => {
			ctx.err(Diag::Usage { msg: format!("-{}: invalid option", opt[1] as char).into() });
			ctx.builtin_usage();
			return done(2);
		},
		_ => (None, args),
	};
	let Some((file, rest)) = args.split_first() else {
		ctx.usage("filename argument required");
		ctx.builtin_usage();
		return done(2);
	};
	let posix = ctx.option(OptId::Posix)?;
	let mut path = None;
	if !file.contains(&b'/') {
		let search = match search_arg {
			Some(p) if p.is_empty() => Some(BString::from(".")),
			Some(p) => Some(p.clone()),
			None if ctx.option(OptId::Sourcepath)? => Some(ctx.scalar(b"PATH")?.unwrap_or_default()),
			None => None,
		};
		if let Some(search) = search {
			let cwd = ctx.vp.cwd.clone();
			for cand in candidates(&search, file, &cwd) {
				if let ProbeResult::Stat(Some(st)) =
					ctx.probe(Probe::Stat { path: cand.clone(), follow: true })?
					&& st.kind == StatKind::File
				{
					path = Some(cand);
					break;
				}
			}
			if path.is_none() && (search_arg.is_some() || posix) {
				let utf8 = locale::is_utf8(ctx.k, ctx.cx.store, ctx.vp);
				let name = quote::printable_filename(file, utf8, false);
				ctx.err(Diag::Usage { msg: format!("{}: file not found", name.as_bstr()).into() });
				ctx.usage_error = true;
				return done(1);
			}
		}
	}
	// bash's `_evalfile` names the file it found.
	let shown = path.clone().unwrap_or_else(|| file.clone());
	let path = path.unwrap_or_else(|| absolute(&ctx.vp.cwd, file));
	let text = match ctx.probe(Probe::Read { path: path.clone() })? {
		ProbeResult::Bytes(Ok(text)) => text,
		ProbeResult::Bytes(Err(msg)) if msg.as_slice() == b"Is a directory" => {
			ctx.err(Diag::Usage { msg: format!("{}: is a directory", shown.as_bstr()).into() });
			return done(1);
		},
		ProbeResult::Bytes(Err(msg)) => {
			ctx.diag(Diag::Usage { msg: format!("{}: {}", file.as_bstr(), msg.as_bstr()).into() });
			ctx.usage_error = true;
			return done(1);
		},
		_ => {
			ctx.diag(Diag::NoSuchFile { name: file.clone() });
			ctx.usage_error = true;
			return done(1);
		},
	};
	// bash drops NUL bytes from a sourced file; more than 256 make it a
	// binary file (`EX_BINARY_FILE`).
	let nuls = text.find_iter(b"\0").count();
	if nuls > 256 {
		ctx.err(Diag::Usage {
			msg: format!("{}: cannot execute binary file", shown.as_bstr()).into(),
		});
		return done(126);
	}
	let text = if nuls == 0 {
		text
	} else {
		text.iter().copied().filter(|&c| c != 0).collect()
	};
	let restore = source_args(ctx, rest, true)?;
	// As for `eval`: the file sees the caller's `$?`.
	push_script(ctx.vp, &text, 1, ScriptKind::Source);
	// `BASH_SOURCE` shows the name as given.
	crate::bash::vm::callstack::push_source(
		ctx.k,
		ctx.cx.store,
		ctx.vp,
		file.clone(),
		ctx.line,
		rest,
		restore,
		None,
	)?;
	ctx.k
		.emit_op(ctx.cx, ctx.vp, 0, EventData::SourceEnter { path: path.as_bstr() });
	Ok(Outcome { status: 0, control: Control::Frame })
}

/// The arguments of `. file args` become the positional parameters while
/// the file runs; what its end puts back. `bash`: outside any function a
/// file that changes them keeps its own (bash `maybe_pop_dollar_vars`);
/// zsh `bin_dot` always restores.
fn source_args(
	ctx: &mut Ctx<'_, '_>,
	rest: &[BString],
	bash: bool,
) -> Result<Option<Box<crate::bash::vm::callstack::SourceSave>>, super::Need> {
	use crate::bash::vm::state;
	if rest.is_empty() {
		return Ok(None);
	}
	let args = state::positional(&ctx.k.root, ctx.cx.store, ctx.vp)?;
	let installed = if bash && state::func_scope(&ctx.k.root, ctx.cx.store, ctx.vp)?.is_none() {
		Some(rest.to_vec())
	} else {
		None
	};
	state::set_positional(&mut ctx.k.root, ctx.cx.store, ctx.vp, rest.to_vec());
	Ok(Some(Box::new(crate::bash::vm::callstack::SourceSave { args, installed })))
}

/// A bad argument to `return`, `exit`, `break` or `continue` (reported).
#[derive(Clone, Copy, PartialEq, Eq)]
enum BadArg {
	/// Not a number (bash's `EX_USAGE`).
	NotNumeric,
	/// More than one argument (status 2).
	TooMany,
}

/// The numeric argument of `return`, `exit`, `break`, `continue`, after an
/// optional `--`.
fn numeric_arg(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> Result<Option<i64>, BadArg> {
	let args = match args.first() {
		Some(a) if a.as_slice() == b"--" => &args[1..],
		_ => args,
	};
	let Some(a) = args.first() else {
		return Ok(None);
	};
	let Some(n) = number(a) else {
		ctx.diag(Diag::NumericArg { cmd: ctx.name.into(), arg: a.clone() });
		ctx.usage_error = true;
		return Err(BadArg::NotNumeric);
	};
	if args.len() > 1 {
		ctx.diag(Diag::TooManyArgs { cmd: ctx.name.into() });
		return Err(BadArg::TooMany);
	}
	Ok(Some(n))
}

/// A status argument (`return`, `exit`): the low 8 bits.
fn status_arg(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> Result<Option<i32>, BadArg> {
	Ok(numeric_arg(ctx, args)?.map(|n| (n & 0xff) as i32))
}

/// `return [n]`. Outside a function, `.` file or `${ ;}` (and not in a
/// subshell of a function) it is an error, fatal to a posix shell.
pub fn return_(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	use crate::bash::vm::proc::FrameKind;
	let target = ctx.vp.frames.iter().any(|f| {
		matches!(
			f.kind,
			FrameKind::Function { .. }
				| FrameKind::NoFork
				| FrameKind::Script { what: ScriptKind::Source, .. }
		)
	}) || (ctx.vp.parent.is_some()
		&& crate::bash::vm::state::in_function(&ctx.k.root, ctx.cx.store, ctx.vp)?);
	// The arguments are checked first (`return 1 2` anywhere is "too many
	// arguments").
	let arg = status_arg(ctx, args);
	if !target && !matches!(arg, Err(BadArg::TooMany)) {
		ctx.err(Diag::Usage { msg: "can only `return' from a function or sourced script".into() });
		ctx.usage_error = true;
		return done(2);
	}
	let status = match arg {
		Ok(Some(n)) => n,
		Ok(None) => ctx
			.vp
			.frames
			.iter()
			.rev()
			.find_map(|f| match f.kind {
				FrameKind::Script { what: ScriptKind::Trap { status, .. }, .. } => Some(status),
				FrameKind::Function { .. } | FrameKind::Script { what: ScriptKind::Source, .. } => {
					Some(ctx.vp.status)
				},
				_ => None,
			})
			.unwrap_or(ctx.vp.status),
		// bash returns 2 from the function; extra arguments are only an
		// error.
		Err(BadArg::NotNumeric) => 2,
		Err(BadArg::TooMany) => return done(2),
	};
	Ok(Outcome { status, control: Control::Return })
}

/// `logout [n]`: `exit` in a login shell, else an error.
pub fn logout(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	if ctx.option(OptId::LoginShell)? {
		return exit(ctx, args);
	}
	ctx.err(Diag::Usage { msg: "not login shell: use `exit'".into() });
	done(1)
}

/// `exit [n]`.
pub fn exit(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	// A bad argument (`exit status`, too many) is reported and the shell
	// goes on (status 2), as bash 5.3 does outside posix mode.
	let status = match status_arg(ctx, args) {
		Ok(n) => n.unwrap_or(ctx.vp.status),
		Err(_) => return done(2),
	};
	// An interactive shell with stopped jobs warns once instead.
	if crate::bash::vm::jobctl::check_before_exit(ctx.k, ctx.cx, ctx.vp) {
		return done(1);
	}
	if let Some(outcome) = bash_logout(ctx, status)? {
		return Ok(outcome);
	}
	Ok(Outcome { status, control: Control::Exit })
}

/// bash's `bash_logout`: `exit`/`logout` in a login shell (not a subshell)
/// first sources `~/.bash_logout`, once; the shell then exits with
/// `status` (`builtin exit N` runs after the file).
fn bash_logout(ctx: &mut Ctx<'_, '_>, status: i32) -> Result<Option<Outcome>, super::Need> {
	if !ctx.option(OptId::LoginShell)?
		|| crate::bash::vm::nested::in_subshell(ctx.cx.store, ctx.vp)
		|| ctx.record(Key::Misc(MiscKey::LoggedOut))?.is_some()
	{
		return Ok(None);
	}
	let Some(home) = ctx.scalar(b"HOME")? else {
		return Ok(None);
	};
	let mut path = home;
	path.extend_from_slice(b"/.bash_logout");
	let ProbeResult::Bytes(Ok(text)) = ctx.probe(Probe::Read { path: path.clone() })? else {
		return Ok(None);
	};
	ctx.store_record(KeyBuf::Misc(MiscKey::LoggedOut), Some(Record::Misc(BString::from("1"))));
	ctx.vp.status = status;
	push_script(ctx.vp, format!("builtin exit {status}\n").as_bytes(), ctx.line, ScriptKind::Eval);
	push_script(ctx.vp, &text, 1, ScriptKind::Source);
	ctx.k
		.emit_op(ctx.cx, ctx.vp, 0, EventData::SourceEnter { path: path.as_bstr() });
	Ok(Some(Outcome { status, control: Control::Frame }))
}

/// `break [n]` / `continue [n]`. A count below 1 is reported and leaves
/// every loop (status 1); a non-numeric one ends the (non-interactive)
/// shell.
pub fn break_(ctx: &mut Ctx<'_, '_>, args: &[BString], cont: bool) -> R {
	let n = match numeric_arg(ctx, args) {
		Ok(None) => 1,
		Ok(Some(n)) if n >= 1 => u32::try_from(n).unwrap_or(u32::MAX),
		Ok(Some(n)) => {
			ctx.err(Diag::Usage { msg: format!("{n}: loop count out of range").into() });
			return Ok(Outcome { status: 1, control: Control::Break { n: u32::MAX, cont: false } });
		},
		Err(BadArg::NotNumeric) => return Ok(Outcome { status: 2, control: Control::Exit }),
		Err(BadArg::TooMany) => return done(2),
	};
	Ok(Outcome { status: 0, control: Control::Break { n, cont } })
}

/// `wait [-fn] [-p var] [id …]` (bash `wait.def`): wait for background
/// children of this shell, by pid or job spec, or all of them; `-n` for
/// the first of them to finish; `-p var` gets the waited pid. With job
/// control a job that stops ends the wait unless `-f`.
pub fn wait(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let o = match opts(ctx, args, b"fn", b"p", false) {
		Ok(o) => o,
		Err(st) => return done(st),
	};
	let any = o.has(b'n');
	let force = o.has(b'f');
	let into = o.arg(b'p').cloned();
	if let Some(name) = &into {
		// bash checks the name, then unsets it (`wait -p v` with nothing to
		// wait for leaves `v` unset).
		let (base, index) = super::split_subscript(name);
		if !crate::bash::vm::is_ident(base) {
			ctx.err(Diag::InvalidIdent { name: name.clone() });
			return done(1);
		}
		if index.is_none() {
			// `readonly WV` without a value is declared but unset: still
			// readonly.
			let readonly =
				crate::bash::vm::state::lookup_declared(&ctx.k.root, ctx.cx.store, ctx.vp, base)?
					.is_some_and(|v| v.attrs.contains(crate::bash::store::Attrs::READONLY));
			if readonly {
				ctx.usage(format!("{}: cannot unset: readonly variable", base.as_bstr()));
				return done(1);
			}
			crate::bash::vm::state::unset_var(&mut ctx.k.root, ctx.cx.store, ctx.vp, base, false);
		}
	}
	let args = o.rest;
	if any {
		return wait_any(ctx, args, into);
	}
	if args.is_empty() {
		return wait_all(ctx, force);
	}
	let mut list = Vec::new();
	let mut status = 0;
	for a in args {
		if a.first().is_some_and(u8::is_ascii_digit) {
			let Some(pid) = number(a).and_then(|n| u32::try_from(n).ok()) else {
				// bash returns at once on a malformed pid.
				ctx.usage(format!("`{}': not a pid or valid job spec", a.as_bstr()));
				if list.is_empty() {
					return done(1);
				}
				status = 1;
				break;
			};
			let child = ctx.vp.vpid_of(pid);
			if is_child(ctx, child) {
				list.push(child);
			} else {
				ctx.usage(format!("pid {pid} is not a child of this shell"));
				status = 127;
			}
		} else if a.starts_with(b"%") {
			match super::jobs::spec(ctx, a) {
				Ok(n) => {
					let job = ctx.vp.jobs.get(n).map(|j| (j.vpid, j.state));
					if let Some((_, crate::bash::vm::proc::JobState::Stopped(_))) = job {
						ctx.diag(Diag::Warning {
							msg: format!("warning: wait_for_job: job {n} is stopped").into(),
						});
					}
					list.extend(job.map(|(v, _)| v));
				},
				Err(bad) => {
					if matches!(bad, super::jobs::Bad::Missing) {
						super::jobs::no_such_job(ctx, a);
					}
					status = 127;
				},
			}
		} else {
			ctx.usage(format!("`{}': not a pid or valid job spec", a.as_bstr()));
			status = 1;
		}
	}
	if list.is_empty() {
		return done(status);
	}
	let wait = Wait { children: list, all: false, any: false, into, force };
	Ok(Outcome { status, control: Control::Wait(wait) })
}

/// Whether `pid` is a child this shell can wait for: a job of its own, a
/// finished child whose status is kept (bash's `bgpids`), or the running
/// process substitution or coprocess `$!` names.
fn is_child(ctx: &mut Ctx<'_, '_>, pid: Vpid) -> bool {
	if ctx.vp.jobs.by_vpid(pid).is_some_and(|j| !j.inherited) {
		return true;
	}
	// A subshell copies `$!`, not its parent's children.
	if !ctx.k.started(ctx.cx.store, ctx.vp.vpid, pid) {
		return false;
	}
	match ctx.k.proc_state(ctx.cx.store, pid) {
		Some(crate::bash::vm::ProcState::Exited(_)) => true,
		Some(crate::bash::vm::ProcState::Running) => ctx.vp.last_bg.is(pid),
		None => false,
	}
}

/// `wait` without operands: every running job (bash
/// `wait_for_background_pids`); with job control a stopped job is skipped
/// with a warning. A command substitution's copies of its parent's jobs
/// are not its children.
fn wait_all(ctx: &mut Ctx<'_, '_>, force: bool) -> R {
	let control = super::jobs::active(ctx)?;
	let foreign: Vec<u32> = ctx
		.vp
		.jobs
		.iter()
		.filter(|j| j.inherited && j.state == crate::bash::vm::proc::JobState::Running)
		.map(crate::bash::vm::proc::Job::pid)
		.collect();
	for pid in foreign {
		ctx.usage(format!("pid {pid} is not a child of this shell"));
	}
	ctx.vp.jobs.remove_where(|j| j.inherited);
	let mut list = Vec::new();
	let mut stopped = Vec::new();
	for job in ctx.vp.jobs.iter() {
		match job.state {
			crate::bash::vm::proc::JobState::Stopped(_) if control => {
				stopped.push((job.number, job.pid()));
			},
			crate::bash::vm::proc::JobState::Done(_) => {},
			_ => list.push(job.vpid),
		}
	}
	for (number, pid) in stopped {
		ctx.err(Diag::Warning { msg: format!("warning: job {number}[{pid}] stopped").into() });
	}
	// bash also waits for the process substitution `$!` names.
	if let Some(last) = ctx.vp.last_bg.vpid()
		&& ctx.vp.jobs.by_vpid(last).is_none()
		&& ctx.k.proc_state(ctx.cx.store, last) == Some(crate::bash::vm::ProcState::Running)
		&& ctx.k.started(ctx.cx.store, ctx.vp.vpid, last)
	{
		list.push(last);
	}
	let wait = Wait { children: list, all: true, any: false, into: None, force };
	Ok(Outcome { status: 0, control: Control::Wait(wait) })
}

/// `wait -n [id …]`: the first of the jobs (all without operands) to
/// finish (bash `wait_for_any_job`); a finished child that already left the
/// job table answers at once. 127 when there is nothing to wait for.
fn wait_any(ctx: &mut Ctx<'_, '_>, args: &[BString], into: Option<BString>) -> R {
	let mut list = Vec::new();
	if args.is_empty() {
		list.extend(ctx.vp.jobs.iter().filter(|j| !j.inherited).map(|j| j.vpid));
	} else {
		// bash `check_nonjobs`: a pid no longer in the job table whose
		// status is kept.
		let kept = args.iter().find_map(|a| {
			let pid = ctx.vp.vpid_of(u32::try_from(number(a)?).ok()?);
			(ctx.vp.jobs.by_vpid(pid).is_none()
				&& matches!(
					ctx.k.proc_state(ctx.cx.store, pid),
					Some(crate::bash::vm::ProcState::Exited(_))
				)
				&& ctx.k.started(ctx.cx.store, ctx.vp.vpid, pid))
			.then_some(pid)
		});
		if let Some(pid) = kept {
			let wait = Wait { children: vec![pid], all: false, any: true, into, force: true };
			return Ok(Outcome { status: 0, control: Control::Wait(wait) });
		}
		for a in args {
			let pid = number(a)
				.and_then(|n| u32::try_from(n).ok())
				.map(|n| ctx.vp.vpid_of(n));
			let found = match pid {
				Some(p) => ctx
					.vp
					.jobs
					.by_vpid(p)
					.filter(|j| !j.inherited)
					.map(|j| j.vpid)
					.or_else(|| {
						(ctx.vp.last_bg.is(p)
							&& ctx.k.proc_state(ctx.cx.store, p)
								== Some(crate::bash::vm::ProcState::Running)
							&& ctx.k.started(ctx.cx.store, ctx.vp.vpid, p))
						.then_some(p)
					}),
				None => super::jobs::spec(ctx, a)
					.ok()
					.and_then(|n| ctx.vp.jobs.get(n))
					.map(|j| j.vpid),
			};
			match found {
				Some(v) => {
					if !list.contains(&v) {
						list.push(v);
					}
				},
				None if a.starts_with(b"%") => super::jobs::no_such_job(ctx, a),
				None => ctx.usage(format!("`{}': not a pid or valid job spec", a.as_bstr())),
			}
		}
	}
	if list.is_empty() {
		return done(127);
	}
	let wait = Wait { children: list, all: false, any: true, into, force: true };
	Ok(Outcome { status: 0, control: Control::Wait(wait) })
}
