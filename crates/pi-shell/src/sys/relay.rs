//! Decoding relays for external programs' output on its way into shell text.
//!
//! Builtins write the shell's own text (UTF-8). A native Windows program may
//! write the ANSI code page to a pipe, and one program's output is one
//! encoding, but a stream several commands write into is not. So the encoding
//! is decided per program, here, rather than by whoever reads the mixed
//! stream.
//!
//! A host that can decode such output installs an [`OutputDecoding`]. Every
//! external whose stdout or stderr is a *text sink* — the run's capture pipe
//! and a command substitution's capture — then writes into a pipe of its own;
//! a relay decodes it with a fresh [`ByteDecoder`] and forwards the text into
//! the sink. Pipeline pipes and files are not text sinks: they carry the
//! program's bytes unchanged, so binary data stays intact.
//!
//! A relay is not a thread: the external's `ExtProc` ([`Relayed`]) polls it
//! with the polling task's waker. It reads what the program wrote from our
//! end of the pipe (non-blocking or overlapped, [`os::OsPipe`]), decodes it
//! and writes the text into the sink, returning `Pending` wherever it would
//! wait.
//!
//! A command's relays drain before its exit is reported, so its output
//! reaches the sink ahead of whatever the next command writes there. Only the
//! relay reads the pipe, and the task polling it is the one sizing the
//! drain, so at the exit what the relay has read and what the pipe holds are
//! one snapshot: everything the exited program wrote. The exit is reported
//! once the relay has forwarded that much. A process the program left
//! running may keep the pipe open forever; the drain never waits for the end
//! of the stream beyond a short grace for a character the program ended
//! inside. The relay itself goes on to the end of the stream, as a plain pipe
//! would carry that process's output: once the `ExtProc` is dropped it runs
//! as adopted work (`pump::orphan`), and releases what the decoder holds at
//! the end.

use std::{
	fs,
	future::Future,
	io,
	pin::Pin,
	task::{Context, Poll, Waker},
	time::Duration,
};

use crate::{
	bash::{ExitStatus, ExtProc, OsHandle, ProcEvent, Signal},
	sys::pump::{
		BUF, BURST, End, PollIo, orphan,
		os::{self, OsPipe, Timer},
	},
};

/// Hook decoding external programs' output into shell text.
pub trait OutputDecoding: Send + Sync {
	/// A decoder for the output stream of one external program.
	fn decoder(&self) -> Box<dyn ByteDecoder>;
}

/// Incremental decoder for one external program's output stream.
pub trait ByteDecoder: Send {
	/// Decode the next chunk; bytes of an incomplete character stay held.
	fn push(&mut self, bytes: &[u8]) -> String;
	/// Whether bytes are held back for more input or for [`Self::finish`].
	fn holds_bytes(&self) -> bool;
	/// Flush held bytes at the end of the stream.
	fn finish(&mut self) -> String;
}

/// How long the drain waits for the end of the stream when the decoder holds
/// the start of a character the program ended inside.
const HOLD_GRACE: Duration = Duration::from_millis(50);

/// The OS handle a spawned child's stdio can inherit for `writer`.
fn writer_handle(writer: &fs::File) -> OsHandle {
	#[cfg(unix)]
	{
		use std::os::fd::AsRawFd;
		OsHandle(writer.as_raw_fd() as u64)
	}
	#[cfg(windows)]
	{
		use std::os::windows::io::AsRawHandle;
		OsHandle(writer.as_raw_handle().addr() as u64)
	}
}

/// Where a relay is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
	/// Forwarding what the program writes.
	Reading,
	/// The stream ended (or the relay was ended): release what the decoder
	/// holds.
	Finish,
	/// Flush the sink.
	Flush,
	/// Nothing more to do.
	Done,
}

/// One relay: our end of a program's pipe, its decoder and the text sink.
struct Relay {
	/// `None` once the stream ended, the sink refused text or the relay was
	/// ended at its program's exit.
	pipe:     Option<OsPipe>,
	decoder:  Option<Box<dyn ByteDecoder>>,
	sink:     End,
	buf:      Box<[u8]>,
	/// Decoded text, written into the sink up to `sent`.
	text:     Vec<u8>,
	sent:     usize,
	/// Raw bytes pending in `buf`, without a copy through `text`.
	raw_len:  usize,
	/// Bytes read from the program so far.
	consumed: u64,
	phase:    Phase,
	/// Bytes the program wrote, once its exit sized them.
	target:   Option<u64>,
	/// The hold grace, once the drain waits on a held character.
	grace:    Option<Timer>,
}

impl Relay {
	fn new(pipe: OsPipe, decoder: Option<Box<dyn ByteDecoder>>, sink: End) -> Self {
		Self {
			pipe: Some(pipe),
			decoder,
			sink,
			buf: vec![0; BUF].into_boxed_slice(),
			text: Vec::new(),
			sent: 0,
			raw_len: 0,
			consumed: 0,
			phase: Phase::Reading,
			target: None,
			grace: None,
		}
	}

	/// Forward what can move now; ready once done. Yields after a burst.
	fn poll(&mut self, cx: &mut Context<'_>) -> Poll<()> {
		for _ in 0..BURST {
			let pending = if self.decoder.is_some() {
				self.text.len()
			} else {
				self.raw_len
			};
			while self.sent < pending {
				let bytes = if self.decoder.is_some() {
					&self.text[..]
				} else {
					&self.buf[..self.raw_len]
				};
				match std::task::ready!(self.sink.poll_write(cx, &bytes[self.sent..])) {
					Ok(n) if n > 0 => self.sent += n,
					Err(e) if e.kind() == io::ErrorKind::Interrupted => {},
					_ => {
						// Refused (the sink's reader is gone) or failed: closing
						// our end makes that visible to the program, whose next
						// write fails as on a pipe whose reader is gone. Nothing
						// more reaches the sink.
						self.pipe = None;
						self.text.clear();
						self.sent = 0;
						self.phase = Phase::Done;
						return Poll::Ready(());
					},
				}
			}
			self.text.clear();
			self.raw_len = 0;
			self.sent = 0;
			match self.phase {
				Phase::Reading => {
					let read = match &mut self.pipe {
						Some(pipe) => std::task::ready!(pipe.poll_read(cx, &mut self.buf)),
						None => Ok(0),
					};
					match read {
						Ok(n) if n > 0 => {
							self.consumed += n as u64;
							if let Some(decoder) = &mut self.decoder {
								self.text = decoder.push(&self.buf[..n]).into_bytes();
							} else {
								self.raw_len = n;
							}
						},
						// End of file, or a failed pipe.
						_ => self.end(),
					}
				},
				Phase::Finish => {
					if let Some(decoder) = &mut self.decoder {
						self.text = decoder.finish().into_bytes();
					}
					self.phase = Phase::Flush;
				},
				Phase::Flush => {
					let _ = std::task::ready!(self.sink.poll_flush(cx));
					self.phase = Phase::Done;
				},
				Phase::Done => return Poll::Ready(()),
			}
		}
		// A burst moved: let the engine run, then go on.
		cx.waker().wake_by_ref();
		Poll::Pending
	}

	/// The stream ended: our end of the pipe closes first, then the decoder
	/// releases what it holds and the sink is flushed.
	fn end(&mut self) {
		self.pipe = None;
		if self.phase == Phase::Reading {
			self.phase = Phase::Finish;
		}
	}

	/// After the program's exit: whether everything it wrote has been
	/// forwarded. The relay itself goes on to the end of the stream, which a
	/// process the program left running may hold open.
	fn drained(&mut self, cx: &Context<'_>) -> bool {
		match self.phase {
			Phase::Done => return true,
			// The stream ended: drained once its rest is out and flushed.
			Phase::Finish | Phase::Flush => return false,
			Phase::Reading => {},
		}
		if self.target.is_none() {
			// Nothing but this relay reads the pipe, and this task polls it:
			// what it read and what the pipe holds now are one snapshot. A
			// pipe that cannot say is forwarded to its end.
			let waiting = self.pipe.as_mut().map_or(Ok(0), OsPipe::available);
			self.target = waiting.ok().map(|n| self.consumed + n as u64);
		}
		let Some(target) = self.target else {
			return false;
		};
		self.consumed >= target
			&& self.sent >= self.text.len().max(self.raw_len)
			&& (!self
				.decoder
				.as_ref()
				.is_some_and(|decoder| decoder.holds_bytes())
				|| self
					.grace
					.get_or_insert_with(|| Timer::after(HOLD_GRACE))
					.poll(cx)
					.is_ready())
	}
}

/// Relays that outlived their `Relayed`, forwarding to the ends of their
/// streams as one piece of adopted work.
struct Forward(Vec<Relay>);

impl Future for Forward {
	type Output = ();

	fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
		self.0.retain_mut(|r| r.poll(cx).is_pending());
		if self.0.is_empty() {
			Poll::Ready(())
		} else {
			Poll::Pending
		}
	}
}

/// The relays being set up for one spawn.
///
/// Each [`Relays::attach`] sets up a relay and returns the handle the
/// child's stdout or stderr inherits. The parent's copies of those handles
/// close when the set is wrapped around the spawned child ([`Relays::wrap`]),
/// which then polls the relays, or dropped with the relays (the spawn
/// failed).
pub(crate) struct Relays<'a> {
	decoding: Option<&'a dyn OutputDecoding>,
	writers:  Vec<fs::File>,
	set:      Vec<Relay>,
}

impl<'a> Relays<'a> {
	pub(crate) fn new(decoding: Option<&'a dyn OutputDecoding>) -> Self {
		Self { decoding, writers: Vec::new(), set: Vec::new() }
	}

	/// Set up a relay into `sink`, decoding only explicitly designated text
	/// sinks. Returns the OS handle the program writes to.
	pub(crate) fn attach(&mut self, sink: End, text: bool) -> io::Result<OsHandle> {
		let (pipe, writer) = os::pipe(false)?;
		self.set.push(Relay::new(
			pipe,
			self
				.decoding
				.filter(|_| text)
				.map(|decoding| decoding.decoder()),
			sink,
		));
		let os = writer_handle(&writer);
		self.writers.push(writer);
		Ok(os)
	}

	/// The spawned `child`, reporting its exit once the relays drained.
	pub(crate) fn wrap(self, child: Box<dyn ExtProc>) -> Box<dyn ExtProc> {
		if self.set.is_empty() {
			return child;
		}
		Box::new(Relayed { child, relays: self.set, status: None })
	}
}

/// An external whose output runs through relays, which its `poll_wait`
/// drives: its exit is reported once they have forwarded everything it
/// wrote.
struct Relayed {
	child:  Box<dyn ExtProc>,
	relays: Vec<Relay>,
	status: Option<ExitStatus>,
}

impl ExtProc for Relayed {
	fn pid(&self) -> u32 {
		self.child.pid()
	}

	fn poll_wait(&mut self, cx: &mut Context<'_>) -> Poll<ExitStatus> {
		loop {
			match std::task::ready!(self.poll_event(cx)) {
				ProcEvent::Exited(status) => return Poll::Ready(status),
				ProcEvent::Stopped(_) | ProcEvent::Continued => {},
			}
		}
	}

	fn poll_event(&mut self, cx: &mut Context<'_>) -> Poll<ProcEvent> {
		for relay in &mut self.relays {
			let _ = relay.poll(cx);
		}
		let status = if let Some(status) = self.status {
			status
		} else {
			match std::task::ready!(self.child.poll_event(cx)) {
				ProcEvent::Exited(status) => {
					self.status = Some(status);
					status
				},
				change => return Poll::Ready(change),
			}
		};
		let mut drained = true;
		for relay in &mut self.relays {
			drained &= relay.drained(cx);
		}
		orphan::poll(cx);
		if drained {
			Poll::Ready(ProcEvent::Exited(status))
		} else {
			Poll::Pending
		}
	}

	fn pgid(&self) -> Option<u32> {
		self.child.pgid()
	}

	fn signal(&mut self, sig: Signal) -> io::Result<()> {
		self.child.signal(sig)
	}

	fn stop(&mut self) -> io::Result<()> {
		self.child.stop()
	}

	fn cont(&mut self) -> io::Result<()> {
		self.child.cont()
	}
}

impl Drop for Relayed {
	/// Relays still forwarding (the program runs on, or a process it left
	/// running holds the pipe) go on to the ends of their streams as adopted
	/// work, as the program's output would through a plain pipe.
	fn drop(&mut self) {
		// Usually the stream has ended with the program: its end of file is
		// already readable and the relay finishes here.
		let mut now = Context::from_waker(Waker::noop());
		let open: Vec<Relay> = self
			.relays
			.drain(..)
			.filter_map(|mut r| r.poll(&mut now).is_pending().then_some(r))
			.collect();
		if !open.is_empty() {
			orphan::adopt(Forward(open));
		}
	}
}


