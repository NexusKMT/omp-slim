//! Redirections: expand each target, open through the pollable `Fs`, and
//! install the fd, saving the previous one in the op's scratch so the
//! caller can restore it.
//!
//! Progress (`done`, the expanded target, a pending `open`) lives in the
//! scratch, so a redirection list that parks resumes where it stopped.
use std::{
	sync::Arc,
	task::{Context, Poll},
};

use bstr::{BStr, BString, ByteSlice};

use super::{
	Cx, Kernel, TextKind,
	builtins::{self, Lhs},
	exec::{Flow, expanding},
	expand::arith_value,
	probe::{absolute, dev_fd},
	proc::{AssignValue, BangStage, DeferPhase, Deferral, Saved, Slot, Stage, Vproc},
	state::{self, Level},
};
use crate::bash::{
	diag::Diag,
	event::{EventData, RedirInfo, RedirKind, WaitKey},
	fd::{FdOrigin, FdRef},
	fs::{FsOp, FsPoll, OpenFlags, StatKind},
	host::ChildRedir,
	ir::{RedirFdIr, RedirIr, RedirTargetIr, Unit},
	mem::MemBuf,
	store::{OptId, VarValue},
};

/// Why a redirection list stopped.
pub enum Halt {
	/// The op parks, calls or is abandoned.
	Flow(Flow),
	/// A redirection failed (the diagnostic is printed): the command does
	/// not run and its status is 1.
	Failed,
}

fn scratch(vp: &mut Vproc) -> &mut super::proc::Scratch {
	super::exec::scratch(vp)
}

/// The top frame's I/O progress (created on first use: a redirection is
/// being applied).
fn io(vp: &mut Vproc) -> &mut super::proc::ScratchIo {
	scratch(vp).io()
}

/// Apply redirection list `list` of `unit`.
pub fn apply(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	list: u32,
	line: u32,
) -> Result<(), Halt> {
	let redirs = &unit.redirs[list as usize];
	loop {
		// Read without creating the progress: an empty list needs none.
		let done = scratch(vp).io.as_ref().map_or(0, |io| io.redir.done);
		let Some(r) = redirs.get(done) else {
			return Ok(());
		};
		let target = if let Some(t) = io(vp).redir.target.clone() {
			t
		} else {
			let t = target_text(k, vp, cx, unit, r, line)?;
			io(vp).redir.target = Some(t.clone());
			t
		};
		let before = io(vp).saved.len();
		if k
			.deferrals
			.iter()
			.any(|d| d.vproc == vp.vpid && d.phase == DeferPhase::Collect)
		{
			collect(k, vp, cx, r, &target, line)?;
		} else {
			// A FIFO the job's process will open itself is decided before any
			// open starts: an in-flight open that is dropped wakes its helper by
			// opening the other end, which the FIFO's real peer observes (a
			// writer then sees its reader vanish).
			if !k.bangs.is_empty() && waits_on_fifo(cx, vp, r, &target) {
				let path = absolute(&vp.cwd, &target);
				if deferrable(k, vp, cx, &redirs[done..], &path) {
					start_deferral(vp, k);
					return Ok(());
				}
			}
			match install(k, vp, cx, unit, r, &target, line) {
				Err(Halt::Flow(Flow::Block(WaitKey::Fs { op: FsOp::Open, path })))
					if !k.bangs.is_empty() =>
				{
					if defer(k, vp, cx, &redirs[done..], &path) {
						return Ok(());
					}
					return Err(Halt::Flow(Flow::Block(WaitKey::Fs { op: FsOp::Open, path })));
				},
				res => res?,
			}
		}
		if let RedirFdIr::Var(name) = &r.fd
			&& !state::option(&mut k.root, cx.store, vp, OptId::VarredirClose).unwrap_or(false)
			&& let Some(fd) = var_fd(k, vp, cx, name)
		{
			// A `{var}` fd outlives its command (unless `varredir_close`).
			let saved = &mut io(vp).saved;
			let mut i = before;
			while i < saved.len() {
				if saved[i].fd == fd {
					saved.remove(i);
				} else {
					i += 1;
				}
			}
		}
		let sc = scratch(vp);
		let progress = &mut sc.io().redir;
		progress.done += 1;
		progress.target = None;
		sc.logs[Slot::Redirs as usize].clear();
		if k.mask.contains(crate::bash::event::EventKind::Redirect) {
			let fd = match r.fd {
				RedirFdIr::Num(n) => n as i32,
				_ => default_fd(r.op),
			};
			let info = RedirInfo { fd, op: r.op, target: target.clone() };
			k.emit_op(cx, vp, unit.words.get(word_of(r)).map_or(0, |w| w.node), EventData::Redirect {
				redir: &info,
			});
		}
	}
}

const fn word_of(r: &RedirIr) -> usize {
	match r.target {
		RedirTargetIr::Word(w) => w as usize,
		RedirTargetIr::HereDoc { .. } => usize::MAX,
	}
}

const fn default_fd(op: RedirKind) -> i32 {
	match op {
		RedirKind::In
		| RedirKind::ReadWrite
		| RedirKind::DupIn
		| RedirKind::HereDoc
		| RedirKind::HereString => 0,
		_ => 1,
	}
}

/// Source text of word `w` (for `ambiguous redirect`).
fn word_text(unit: &Unit, w: u32) -> BString {
	let node = unit.words[w as usize].node;
	unit
		.nodes
		.get(node as usize)
		.map_or_else(BString::default, |n| {
			BString::from(
				unit
					.source
					.get(n.lo as usize..n.hi as usize)
					.unwrap_or_default(),
			)
		})
}

/// The expanded target (a path, an fd number, or document bytes).
fn target_text(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	r: &RedirIr,
	line: u32,
) -> Result<BString, Halt> {
	match &r.target {
		RedirTargetIr::HereDoc { text, quoted: true } => Ok(text.clone()),
		RedirTargetIr::HereDoc { text, quoted: false } => {
			let mode = super::exec::mode_of(vp);
			let tunit = match k.engine.text_unit(
				text,
				TextKind::HereDoc,
				mode,
				k.mask.contains(crate::bash::event::EventKind::UnitCompiled),
			) {
				Ok(u) => u,
				Err(e) => {
					// bash reports the script line after the document.
					#[expect(
						clippy::naive_bytecount,
						reason = "one here-document per redirection; no bytecount dependency"
					)]
					let at = line + text.iter().filter(|&&c| c == b'\n').count() as u32 + 1;
					k.diag(cx, vp, line, Diag::ComsubSyntax { line: at, msg: e.msg });
					return Err(Halt::Failed);
				},
			};
			let w = tunit.words.last().cloned().unwrap_or_default();
			expanding(k, vp, cx, Slot::Redirs, true, line, |ex| ex.scalar(&tunit, &w))
				.map_err(Halt::Flow)
		},
		RedirTargetIr::Word(w) => {
			let word = &unit.words[*w as usize];
			if r.op == RedirKind::HereString {
				let mut s =
					expanding(k, vp, cx, Slot::Redirs, word.parks, line, |ex| ex.scalar(unit, word))
						.map_err(Halt::Flow)?;
				s.push(b'\n');
				Ok(s)
			} else {
				// Files and dup targets: no field or several is
				// `$word: ambiguous redirect` with the source text. Outside
				// posix mode the word is pathname-expanded too (a park
				// replays the expansion; the walk's answers are cached).
				let glob = !state::option(&mut k.root, cx.store, vp, OptId::Posix).unwrap_or(false);
				let (mut fields, globs) = expanding(k, vp, cx, Slot::Redirs, word.parks, line, |ex| {
					let mut out = Vec::new();
					let mut globs = Vec::new();
					if glob {
						ex.fields_glob(unit, word, &mut out, &mut globs)?;
					} else {
						ex.fields(unit, word, &mut out)?;
					}
					Ok((out, globs))
				})
				.map_err(Halt::Flow)?;
				if !globs.is_empty() {
					super::glob::expand_globs(k, vp, cx, &mut fields, &globs, line)
						.map_err(Halt::Flow)?;
				}
				if let Ok([one]) = <[BString; 1]>::try_from(fields) {
					Ok(one)
				} else {
					k.diag(cx, vp, line, Diag::AmbiguousRedirect { word: word_text(unit, *w) });
					Err(Halt::Failed)
				}
			}
		},
	}
}

/// Set fd `fd` to `h` (or close it), saving the previous object.
fn set_fd(vp: &mut Vproc, fd: i32, h: Option<FdRef>) {
	let prev = vp.fds.get(fd).cloned();
	io(vp).saved.push(Saved { fd, prev });
	vp.fds.set(fd, h);
}

/// The fd a redirection targets; `{var}` allocates one ≥ 10 and stores it
/// (`closing`: reads the fd it holds).
fn target_fd(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	r: &RedirIr,
	closing: bool,
	line: u32,
) -> Result<i32, Diag> {
	match &r.fd {
		RedirFdIr::Default => Ok(default_fd(r.op)),
		RedirFdIr::Num(n) => Ok(*n as i32),
		RedirFdIr::Var(name) => {
			if closing {
				return var_fd(k, vp, cx, name)
					.ok_or_else(|| Diag::AmbiguousRedirect { word: name.clone() });
			}
			let fd = super::jobctl::lowest_free_fd(k, vp, 10);
			assign_fd_var(k, vp, cx, name, fd, line)?;
			Ok(fd)
		},
	}
}

/// Store `fd` in the `{var}` named `name`.
fn assign_fd_var(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	name: &[u8],
	fd: i32,
	line: u32,
) -> Result<(), Diag> {
	let (base, index) = builtins::split_subscript(name);
	let lhs = Lhs { name: base, index, append: false };
	let value = AssignValue::Scalar(BString::from(fd.to_string()));
	if let Err(d) = builtins::set_value(k, cx, vp, lhs, value, Level::Dynamic) {
		// bash: the assignment's error, then this one. `sh_invalidid` is a
		// builtin error, named by the simple command's word if it has one
		// (`exec: `10': not a valid identifier`).
		let cmd = super::exec::scratch(vp)
			.exec
			.as_ref()
			.and_then(|e| e.argv.first())
			.map(|w| w.to_str_lossy().into_owned());
		let d = match (d, cmd) {
			(d @ Diag::InvalidIdent { .. }, Some(cmd)) => d.by(cmd),
			(d, _) => d,
		};
		k.diag(cx, vp, line, d);
		let msg = format!("{}: cannot assign fd to variable", name.as_bstr()).into();
		return Err(Diag::Usage { msg });
	}
	Ok(())
}

/// The fd number a `{var}` holds, if it holds one (through namerefs).
fn var_fd(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, name: &[u8]) -> Option<i32> {
	let (base, index) = builtins::split_subscript(name);
	let (base, index): (BString, Option<BString>) =
		match state::deref(&k.root, cx.store, vp, base).ok()? {
			state::Deref::Plain => (base.into(), index.map(BString::from)),
			state::Deref::To { name, index: to } => (name, to.or_else(|| index.map(BString::from))),
			state::Deref::Circular => return None,
		};
	let index = index.as_deref().map(|i| i.as_slice());
	// A positional parameter may hold an fd number.
	if index.is_none() && !base.is_empty() && base.iter().all(u8::is_ascii_digit) {
		let n: usize = std::str::from_utf8(&base).ok()?.parse().ok()?;
		let args = state::positional_ref(&k.root, cx.store, vp).ok()?;
		let text = args.get(n.checked_sub(1)?)?;
		return std::str::from_utf8(text).ok()?.trim().parse().ok();
	}
	let var = state::lookup(&k.root, cx.store, vp, &base)
		.ok()
		.flatten()?
		.clone();
	let text = match index {
		None => BString::from(var.as_scalar()?),
		Some(key) if matches!(var.value, VarValue::Assoc(_)) => BString::from(var.key(key)?),
		Some(sub) => {
			let i = arith_value(k, cx, vp, sub).ok()?;
			BString::from(var.index(i)?)
		},
	};
	std::str::from_utf8(&text).ok()?.trim().parse().ok()
}

fn install(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	r: &RedirIr,
	target: &BString,
	line: u32,
) -> Result<(), Halt> {
	match r.op {
		RedirKind::HereDoc | RedirKind::HereString => {
			let fd = target_fd(k, vp, cx, r, false, line).map_err(|d| fail(k, vp, cx, line, d))?;
			let h = FdRef::mem(MemBuf::new(target.to_vec()));
			set_fd(vp, fd, Some(h));
			Ok(())
		},
		RedirKind::DupIn | RedirKind::DupOut => {
			let closing = target.as_slice() == b"-";
			if closing {
				let fd = target_fd(k, vp, cx, r, true, line).map_err(|d| fail(k, vp, cx, line, d))?;
				set_fd(vp, fd, None);
				super::exec::coproc_fd_closed(k, vp, cx, fd);
				return Ok(());
			}
			let (digits, moving) = match target.strip_suffix(b"-") {
				Some(d) => (d, true),
				None => (target.as_slice(), false),
			};
			if !digits.is_empty() && digits.iter().all(u8::is_ascii_digit) {
				let src: i32 = std::str::from_utf8(digits)
					.ok()
					.and_then(|s| s.parse().ok())
					.unwrap_or(-1);
				let Some(h) = vp.fds.get(src).cloned().filter(FdRef::is_open) else {
					// bash names the word as written (`$fd: Bad file descriptor`).
					let path = match r.target {
						RedirTargetIr::Word(w) => word_text(unit, w),
						RedirTargetIr::HereDoc { .. } => target.clone(),
					};
					let err = std::io::Error::other(crate::bash::fd::BadFd);
					return Err(fail(k, vp, cx, line, Diag::Io { path, err }));
				};
				let fd = target_fd(k, vp, cx, r, false, line).map_err(|d| fail(k, vp, cx, line, d))?;
				set_fd(vp, fd, Some(h));
				if moving && src != fd {
					set_fd(vp, src, None);
					super::exec::coproc_fd_closed(k, vp, cx, src);
				}
				return Ok(());
			}
			if r.op == RedirKind::DupOut && matches!(r.fd, RedirFdIr::Default) {
				// `>&file` is `&>file`.
				return open_into(
					k,
					vp,
					cx,
					&[1, 2],
					target,
					OpenFlags::WRITE
						.with(OpenFlags::CREATE)
						.with(OpenFlags::TRUNC),
					line,
				);
			}
			Err(fail(k, vp, cx, line, Diag::AmbiguousRedirect { word: target.clone() }))
		},
		RedirKind::Close => {
			let fd = target_fd(k, vp, cx, r, true, line).map_err(|d| fail(k, vp, cx, line, d))?;
			set_fd(vp, fd, None);
			super::exec::coproc_fd_closed(k, vp, cx, fd);
			Ok(())
		},
		RedirKind::OutErr | RedirKind::AppendErr => {
			let flags = open_flags(k, vp, cx, r.op, target);
			open_into(k, vp, cx, &[1, 2], target, flags, line)
		},
		RedirKind::In
		| RedirKind::Out
		| RedirKind::Append
		| RedirKind::Clobber
		| RedirKind::ReadWrite => {
			let flags = open_flags(k, vp, cx, r.op, target);
			// bash opens the file first and assigns `{var}` after (a
			// readonly one leaves the file created); a parked open keeps
			// its slot free, so the fd is the same on resume.
			let fd = match &r.fd {
				RedirFdIr::Var(_) => super::jobctl::lowest_free_fd(k, vp, 10),
				_ => target_fd(k, vp, cx, r, false, line).map_err(|d| fail(k, vp, cx, line, d))?,
			};
			// bash moves a `{var}` fd to 10 or above with `F_DUPFD`, which
			// fails past `ulimit -n`.
			let limit = vp
				.rlimits
				.iter()
				.find(|(res, ..)| *res == crate::bash::host::Rlimit::Nofile)
				.and_then(|&(_, soft, _)| soft);
			if matches!(r.fd, RedirFdIr::Var(_))
				&& limit.is_some_and(|lim| u64::try_from(fd).is_ok_and(|fd| fd >= lim))
			{
				let mut msg = k.argv0.to_vec();
				msg.extend_from_slice(b": redirection error: cannot duplicate fd: Invalid argument\n");
				vp.out
					.push_back(super::proc::PendingWrite { fd: 2, bytes: msg.into(), off: 0 });
				let err = std::io::Error::from(std::io::ErrorKind::InvalidInput);
				return Err(fail(k, vp, cx, line, Diag::Io { path: target.clone(), err }));
			}
			open_into(k, vp, cx, &[fd], target, flags, line)?;
			if let RedirFdIr::Var(name) = &r.fd
				&& let Err(d) = assign_fd_var(k, vp, cx, name, fd, line)
			{
				set_fd(vp, fd, None);
				return Err(fail(k, vp, cx, line, d));
			}
			Ok(())
		},
	}
}

/// How a file redirection `op` to `target` opens it (`set -o noclobber`
/// makes `>` exclusive, but for `/dev/…`).
fn open_flags(
	k: &mut Kernel,
	vp: &Vproc,
	cx: &mut Cx<'_>,
	op: RedirKind,
	target: &BString,
) -> OpenFlags {
	let noclobber = op == RedirKind::Out
		&& !target.starts_with(b"/dev/")
		&& state::option(&mut k.root, cx.store, vp, OptId::Noclobber).unwrap_or(false);
	let write = OpenFlags::WRITE.with(OpenFlags::CREATE);
	match op {
		_ if noclobber => write.with(OpenFlags::EXCL),
		RedirKind::In => OpenFlags::READ,
		RedirKind::Out | RedirKind::Clobber => write.with(OpenFlags::TRUNC),
		RedirKind::Append | RedirKind::AppendErr => write.with(OpenFlags::APPEND),
		RedirKind::OutErr => write.with(OpenFlags::TRUNC),
		_ => write.with(OpenFlags::READ),
	}
}

/// Whether the process a command spawns can apply redirection `r` itself
/// ([`collect`]): a file open, a numeric duplication or a close of a
/// numbered fd (not a here-document, not a `{var}` fd).
const fn childable(r: &RedirIr) -> bool {
	!matches!(r.fd, RedirFdIr::Var(_))
		&& matches!(r.target, RedirTargetIr::Word(_))
		&& matches!(
			r.op,
			RedirKind::In
				| RedirKind::Out
				| RedirKind::Append
				| RedirKind::Clobber
				| RedirKind::ReadWrite
				| RedirKind::OutErr
				| RedirKind::AppendErr
				| RedirKind::DupIn
				| RedirKind::DupOut
				| RedirKind::Close
		)
}

/// The open of `path` for the first of the redirections `rest` would wait
/// (a FIFO without its other end) in a vproc deciding a background job's
/// pid ([`super::proc::Bang`]): `$!` readers must not wait on that
/// rendezvous, which may need them. A job's lone command may leave the
/// open and the redirections after it to the process it spawns, once its
/// name resolves to an external ([`super::proc::Deferral`]): the stage
/// stops here (`true`; the pending open is dropped, the process repeats
/// it). Otherwise the job keeps its virtual pid and the open waits here
/// (`false`).
fn defer(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	rest: &[RedirIr],
	path: &BString,
) -> bool {
	if !deferrable(k, vp, cx, rest, path) {
		k.settle_bang(vp.vpid, None);
		return false;
	}
	// The pending open is dropped here; the process repeats it.
	io(vp).redir.opening = None;
	start_deferral(vp, k);
	true
}

/// Whether redirection `r` to `target` opens a FIFO for one direction only,
/// the open that waits for the other end (`O_RDWR` never does). A stat the
/// filesystem cannot answer at once counts as a FIFO: the job defers the
/// open rather than start it and race the answer (which a 0 ms-latency
/// filesystem would win, installing the open here instead of leaving it to
/// the process).
fn waits_on_fifo(cx: &mut Cx<'_>, vp: &Vproc, r: &RedirIr, target: &BString) -> bool {
	let one_way = matches!(
		r.op,
		RedirKind::In
			| RedirKind::Out
			| RedirKind::Append
			| RedirKind::Clobber
			| RedirKind::OutErr
			| RedirKind::AppendErr
	);
	if !one_way || !childable(r) || dev_fd(target).is_some() {
		return false;
	}
	let path = absolute(&vp.cwd, target);
	match cx.host.fs().stat(BStr::new(&path), true) {
		FsPoll::Ready(Ok(st)) => st.kind == StatKind::Fifo,
		// A stat that cannot answer at once may still be a FIFO: count it
		// as one, so the open is decided (and left to the process) before
		// it starts.
		FsPoll::Pending(_) => true,
		FsPoll::Ready(Err(_)) => false,
	}
}

/// Whether the job's lone external may leave the open of `path` and the
/// redirections after it (`rest`) to the process it spawns.
fn deferrable(k: &Kernel, vp: &Vproc, cx: &mut Cx<'_>, rest: &[RedirIr], path: &BString) -> bool {
	let Some(bang) = k.bangs.iter().find(|b| b.vproc == vp.vpid) else {
		return false;
	};
	let command = vp
		.frames
		.last()
		.and_then(|f| f.scratch.as_ref())
		.and_then(|s| s.exec.as_ref())
		.is_some_and(|e| e.stage == Stage::Redirect && !e.argv.is_empty());
	bang.stage == BangStage::Lone
		&& command
		&& !k.deferrals.iter().any(|d| d.vproc == vp.vpid)
		&& rest.iter().all(childable)
		&& cx.host.child_opens(BStr::new(path))
}

/// Hand the current redirection and those after it to the spawned process.
fn start_deferral(vp: &mut Vproc, k: &mut Kernel) {
	let from = io(vp).redir.done;
	k.deferrals
		.push(Deferral { vproc: vp.vpid, from, phase: DeferPhase::Lookup, list: Vec::new() });
}

/// What a spawned process prints before an error's description for `what`
/// (`bash: line 1: f: `), as [`Diag::Io`] renders it here.
pub fn diag_prefix(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc, line: u32, what: &[u8]) -> BString {
	let err = std::io::Error::other("");
	let mut text = k.render_quiet(cx, vp, line, &Diag::Io { path: BString::from(what), err });
	if text.last() == Some(&b'\n') {
		text.pop();
	}
	BString::from(text)
}

/// Redirection `r` to `target` of a command whose process applies its
/// redirections itself ([`DeferPhase::Collect`]): added to what the process
/// gets; nothing changes here. Errors found here (a bad fd, an ambiguous
/// target) fail the redirection as [`install`] does.
fn collect(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	r: &RedirIr,
	target: &BString,
	line: u32,
) -> Result<(), Halt> {
	let mut add = Vec::with_capacity(2);
	match r.op {
		RedirKind::Close => add.push(ChildRedir::Close { fd: fd_number(k, vp, cx, r, true, line)? }),
		RedirKind::DupIn | RedirKind::DupOut if target.as_slice() == b"-" => {
			add.push(ChildRedir::Close { fd: fd_number(k, vp, cx, r, true, line)? });
		},
		RedirKind::DupIn | RedirKind::DupOut => {
			let (digits, moving) = match target.strip_suffix(b"-") {
				Some(d) => (d, true),
				None => (target.as_slice(), false),
			};
			if !digits.is_empty() && digits.iter().all(u8::is_ascii_digit) {
				let src: i32 = std::str::from_utf8(digits)
					.ok()
					.and_then(|s| s.parse().ok())
					.unwrap_or(-1);
				if !child_fd_open(k, vp, src) {
					let err = std::io::Error::other(crate::bash::fd::BadFd);
					return Err(fail(k, vp, cx, line, Diag::Io { path: target.clone(), err }));
				}
				let fd = fd_number(k, vp, cx, r, false, line)?;
				let diag = diag_prefix(k, cx, vp, line, digits);
				add.push(ChildRedir::Dup { fd, src, diag });
				if moving && src != fd {
					add.push(ChildRedir::Close { fd: src });
				}
			} else if r.op == RedirKind::DupOut && matches!(r.fd, RedirFdIr::Default) {
				// `>&file` is `&>file`.
				let flags = open_flags(k, vp, cx, RedirKind::OutErr, target);
				add.push(child_open(k, vp, cx, vec![1, 2], target, flags, line));
			} else {
				let d = Diag::AmbiguousRedirect { word: target.clone() };
				return Err(fail(k, vp, cx, line, d));
			}
		},
		RedirKind::OutErr | RedirKind::AppendErr => {
			let flags = open_flags(k, vp, cx, r.op, target);
			add.push(child_open(k, vp, cx, vec![1, 2], target, flags, line));
		},
		RedirKind::In
		| RedirKind::Out
		| RedirKind::Append
		| RedirKind::Clobber
		| RedirKind::ReadWrite => {
			let fd = fd_number(k, vp, cx, r, false, line)?;
			let flags = open_flags(k, vp, cx, r.op, target);
			add.push(child_open(k, vp, cx, vec![fd], target, flags, line));
		},
		RedirKind::HereDoc | RedirKind::HereString => {
			unreachable!("a here-document is never left to the process (`childable`)")
		},
	}
	if let Some(d) = k.deferral(vp.vpid) {
		d.list.extend(add);
	}
	Ok(())
}

/// The fd redirection `r` sets ([`target_fd`]); a bad one fails it.
fn fd_number(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	r: &RedirIr,
	closing: bool,
	line: u32,
) -> Result<i32, Halt> {
	target_fd(k, vp, cx, r, closing, line).map_err(|d| fail(k, vp, cx, line, d))
}

/// Whether `fd` is open in the process a command spawns at this point of
/// its collected redirections: inherited from the vproc, or set by one
/// collected before, and not closed since.
fn child_fd_open(k: &Kernel, vp: &Vproc, fd: i32) -> bool {
	let inherited = vp.fds.get(fd).is_some_and(FdRef::is_open);
	let list = k
		.deferrals
		.iter()
		.find(|d| d.vproc == vp.vpid)
		.map_or(&[][..], |d| d.list.as_slice());
	list.iter().fold(inherited, |open, redir| match redir {
		ChildRedir::Open { fds, .. } if fds.contains(&fd) => true,
		ChildRedir::Dup { fd: set, .. } if *set == fd => true,
		ChildRedir::Close { fd: closed } if *closed == fd => false,
		_ => open,
	})
}

/// The open of `target` onto `fds` by the process ([`ChildRedir::Open`]),
/// or the duplication `/dev/fd/N` (`/dev/stdin`, …) stands for.
fn child_open(
	k: &mut Kernel,
	vp: &Vproc,
	cx: &mut Cx<'_>,
	fds: Vec<i32>,
	target: &BString,
	flags: OpenFlags,
	line: u32,
) -> ChildRedir {
	let diag = diag_prefix(k, cx, vp, line, target);
	if let Some(src) = dev_fd(target)
		&& let [fd] = fds.as_slice()
	{
		return ChildRedir::Dup { fd: *fd, src, diag };
	}
	let umask = state::umask(cx.store, vp).unwrap_or(0o022);
	ChildRedir::Open { fds, path: absolute(&vp.cwd, target), flags, mode: 0o666 & !umask, diag }
}

/// Print `d` and fail the redirection.
fn fail(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, line: u32, d: Diag) -> Halt {
	k.diag(cx, vp, line, d);
	Halt::Failed
}

/// Open `path` (pollable) and install it on every fd of `fds`.
fn open_into(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	fds: &[i32],
	path: &BString,
	flags: OpenFlags,
	line: u32,
) -> Result<(), Halt> {
	if let Some(src) = dev_fd(path) {
		let Some(h) = vp.fds.get(src).cloned().filter(FdRef::is_open) else {
			k.diag(cx, vp, line, Diag::Io {
				path: path.clone(),
				err:  std::io::Error::other(crate::bash::fd::BadFd),
			});
			return Err(Halt::Failed);
		};
		for &fd in fds {
			set_fd(vp, fd, Some(h.clone()));
		}
		return Ok(());
	}
	let abs = absolute(&vp.cwd, path);
	// The vproc's own `umask` (a subshell's applies to its redirections).
	let umask = state::umask(cx.store, vp).unwrap_or(0o022);
	let mut tcx = Context::from_waker(&k.waker);
	let res = match io(vp).redir.opening.as_mut() {
		Some(p) => p.poll(&mut tcx),
		None => match cx.host.fs().open(BStr::new(&abs), flags, 0o666 & !umask) {
			FsPoll::Ready(r) => Poll::Ready(r),
			FsPoll::Pending(mut p) => {
				let r = p.poll(&mut tcx);
				if r.is_pending() {
					io(vp).redir.opening = Some(p);
				}
				r
			},
		},
	};
	match res {
		Poll::Pending => Err(Halt::Flow(Flow::Block(WaitKey::Fs { op: FsOp::Open, path: abs }))),
		Poll::Ready(Ok(file)) => {
			io(vp).redir.opening = None;
			let h = FdRef::open(file, FdOrigin::Host);
			for &fd in fds {
				set_fd(vp, fd, Some(h.clone()));
			}
			Ok(())
		},
		Poll::Ready(Err(err)) => {
			io(vp).redir.opening = None;
			let d =
				if err.kind() == std::io::ErrorKind::AlreadyExists && flags.contains(OpenFlags::EXCL) {
					Diag::NoClobber { path: path.clone() }
				} else {
					Diag::Io { path: path.clone(), err }
				};
			k.diag(cx, vp, line, d);
			Err(Halt::Failed)
		},
	}
}
