//! The OS side of pumps and relays: our private end of a pipe (or a socket
//! pair) as pollable I/O, and a one-shot timer, both waking the polling task
//! without blocking it.
//!
//! Our end is non-blocking (it is ours alone: close-on-exec and never handed to
//! a child, so `O_NONBLOCK` on its open file description affects nobody else).
//! I/O that would wait registers the task's waker with the process-wide
//! readiness poller ([`ready::watch`]). The timer is a `timerfd` (Linux) or a
//! kqueue timer (BSD, macOS), watched the same way.
//!
//! [`ready::watch`]: crate::sys::ready::watch

use std::{
	fs, io,
	task::{Context, Poll},
	time::{Duration, Instant},
};

#[cfg(unix)]
pub use self::imp::socket_pair;
pub use self::imp::{OsPipe, Timer, reclaim};

/// A pipe between a pump and a child: our end, and the child's end (`true`
/// = the child reads).
pub fn pipe(child_reads: bool) -> io::Result<(OsPipe, fs::File)> {
	imp::pipe(child_reads)
}

impl OsPipe {
	/// Read into `buf`; `Ok(0)` at end of file (every writer closed).
	pub fn poll_read(&mut self, cx: &Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
		self.0.poll_read(cx, buf)
	}

	/// Write a prefix of `buf`; fails once the child's end is closed.
	pub fn poll_write(&mut self, cx: &Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
		self.0.poll_write(cx, buf)
	}

	/// Ready once every byte accepted by [`OsPipe::poll_write`] is in the pipe.
	#[cfg_attr(unix, allow(clippy::missing_const_for_fn, reason = "keeps the platform I/O shape"))]
	pub fn poll_flush(&mut self, cx: &Context<'_>) -> Poll<io::Result<()>> {
		self.0.poll_flush(cx)
	}

	/// Bytes waiting to be read in the pipe.
	#[cfg_attr(
		unix,
		allow(clippy::needless_pass_by_ref_mut, reason = "keeps the platform I/O shape")
	)]
	pub fn available(&mut self) -> io::Result<usize> {
		self.0.available()
	}

	/// Our end of a [`named_pipe`] the child reads, before there is data
	/// for it: keep it listening (spares, and instances whose client left),
	/// so the child's opens find an instance however slow the producer is.
	#[cfg_attr(
		unix,
		allow(
			clippy::unused_self,
			clippy::missing_const_for_fn,
			clippy::needless_pass_by_ref_mut,
			reason = "Unix pipes are connected"
		)
	)]
	pub fn poll_listening(&mut self, cx: &Context<'_>) {
		#[cfg(unix)]
		let _ = cx;
	}

	/// Our end of a [`named_pipe`] no client holds: the child never opened
	/// it, or left without writing (no end of file comes from it).
	#[cfg_attr(
		unix,
		allow(
			clippy::unused_self,
			clippy::missing_const_for_fn,
			clippy::needless_pass_by_ref_mut,
			reason = "Unix pipes are connected"
		)
	)]
	pub fn poll_unopened(&mut self, cx: &Context<'_>) -> bool {
		#[cfg(unix)]
		{
			let _ = cx;
			false
		}
	}
}

impl Timer {
	/// A timer due `after` from now.
	pub fn after(after: Duration) -> Self {
		Self(imp::TimerImp::new(Instant::now() + after))
	}

	/// Ready once due. A timer the OS cannot arm is due at once, so a wait
	/// bounded by it ends early rather than never.
	pub fn poll(&mut self, cx: &Context<'_>) -> Poll<()> {
		self.0.poll(cx)
	}
}

#[cfg(unix)]
mod imp {
	use std::{
		fs,
		io::{self, Read, Write},
		os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
		ptr,
		task::{Context, Poll},
		time::{Duration, Instant},
	};

	use crate::sys::ready;

	/// Our non-blocking end of a pump pipe or socket pair.
	pub struct OsPipe(pub(super) UnixEnd);

	/// A one-shot timer.
	pub struct Timer(pub(super) TimerImp);

	pub struct UnixEnd {
		/// Readiness waits, one per direction (a socket pair end is pumped
		/// both ways). Declared first: forgotten by the readiness thread
		/// before the descriptor closes.
		read_watch:  Option<ready::Watch>,
		write_watch: Option<ready::Watch>,
		file:        fs::File,
	}

	pub fn pipe(child_reads: bool) -> io::Result<(OsPipe, fs::File)> {
		let (r, w) = io::pipe()?;
		let (ours, theirs) = if child_reads {
			(OwnedFd::from(w), OwnedFd::from(r))
		} else {
			(OwnedFd::from(r), OwnedFd::from(w))
		};
		Ok((OsPipe(UnixEnd::new(ours)?), fs::File::from(theirs)))
	}

	/// A socket pair for a duplex pump: our end, and the child's.
	pub fn socket_pair() -> io::Result<(OsPipe, fs::File)> {
		let (ours, theirs) = std::os::unix::net::UnixStream::pair()?;
		Ok((OsPipe(UnixEnd::new(OwnedFd::from(ours))?), fs::File::from(OwnedFd::from(theirs))))
	}

	impl OsPipe {
		/// Shut down one direction of a socket pair end (`shutdown(2)`):
		/// the child reads end of file, or its writes fail.
		pub fn shutdown(&self, how: std::net::Shutdown) {
			let how = match how {
				std::net::Shutdown::Read => libc::SHUT_RD,
				std::net::Shutdown::Write => libc::SHUT_WR,
				std::net::Shutdown::Both => libc::SHUT_RDWR,
			};
			// SAFETY: plain syscall on our open descriptor.
			unsafe { libc::shutdown(self.0.file.as_raw_fd(), how) };
		}
	}

	impl UnixEnd {
		fn new(fd: OwnedFd) -> io::Result<Self> {
			let raw = fd.as_raw_fd();
			// SAFETY: fcntl on a descriptor we own. Its open file description
			// is ours alone (close-on-exec, never handed to a child).
			let flags = unsafe { libc::fcntl(raw, libc::F_GETFL) };
			// SAFETY: as above.
			if flags < 0 || unsafe { libc::fcntl(raw, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
				return Err(io::Error::last_os_error());
			}
			Ok(Self { read_watch: None, write_watch: None, file: fs::File::from(fd) })
		}

		pub fn poll_read(&mut self, cx: &Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
			let Self { read_watch, file, .. } = self;
			let fd = file.as_raw_fd();
			poll_io(cx, fd, ready::READ, read_watch, || (&*file).read(buf))
		}

		pub fn poll_write(&mut self, cx: &Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
			let Self { write_watch, file, .. } = self;
			let fd = file.as_raw_fd();
			poll_io(cx, fd, ready::WRITE, write_watch, || (&*file).write(buf))
		}

		#[allow(
			clippy::unused_self,
			clippy::needless_pass_by_ref_mut,
			reason = "keeps the platform I/O shape"
		)]
		pub const fn poll_flush(&mut self, _cx: &Context<'_>) -> Poll<io::Result<()>> {
			Poll::Ready(Ok(()))
		}

		pub fn available(&self) -> io::Result<usize> {
			let mut n: libc::c_int = 0;
			// SAFETY: FIONREAD stores the byte count into `n` for our open
			// descriptor.
			if unsafe { libc::ioctl(self.file.as_raw_fd(), libc::FIONREAD as _, &raw mut n) } < 0 {
				return Err(io::Error::last_os_error());
			}
			Ok(usize::try_from(n).unwrap_or(0))
		}
	}

	/// What a feed's pipe still holds, read through the child's end `read`
	/// once our write end `pipe` is closed: the pipe's only writer is gone,
	/// so the read ends at end of file instead of waiting.
	pub fn reclaim(pipe: Option<OsPipe>, mut read: &fs::File) -> Vec<u8> {
		drop(pipe);
		let mut back = Vec::new();
		let _ = read.read_to_end(&mut back);
		back
	}

	/// Run `op` on the non-blocking `fd`; on `WouldBlock` register the
	/// waker for `events` (replacing the earlier wait, so only the latest
	/// waker is kept) and try once more, as readiness may have come before
	/// the registration did.
	fn poll_io(
		cx: &Context<'_>,
		fd: RawFd,
		events: i16,
		watch: &mut Option<ready::Watch>,
		mut op: impl FnMut() -> io::Result<usize>,
	) -> Poll<io::Result<usize>> {
		let mut registered = false;
		loop {
			match op() {
				Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
				Err(e) if e.kind() == io::ErrorKind::WouldBlock => {},
				r => {
					*watch = None;
					return Poll::Ready(r);
				},
			}
			if registered {
				return Poll::Pending;
			}
			*watch = None;
			match ready::watch(fd, events, cx.waker()) {
				Ok(w) => *watch = Some(w),
				Err(e) => return Poll::Ready(Err(e)),
			}
			registered = true;
		}
	}

	pub struct TimerImp {
		/// Declared first: forgotten before the timer descriptor closes.
		watch:    Option<ready::Watch>,
		fd:       Option<OwnedFd>,
		deadline: Instant,
	}

	impl TimerImp {
		pub const fn new(deadline: Instant) -> Self {
			Self { watch: None, fd: None, deadline }
		}

		pub fn poll(&mut self, cx: &Context<'_>) -> Poll<()> {
			if Instant::now() >= self.deadline {
				self.watch = None;
				return Poll::Ready(());
			}
			if self.fd.is_none() {
				match arm(self.deadline) {
					Ok(fd) => self.fd = Some(fd),
					Err(_) => return Poll::Ready(()),
				}
			}
			let Some(fd) = self.fd.as_ref().map(AsRawFd::as_raw_fd) else {
				return Poll::Ready(());
			};
			self.watch = None;
			match ready::watch(fd, ready::READ, cx.waker()) {
				Ok(w) => self.watch = Some(w),
				Err(_) => return Poll::Ready(()),
			}
			if Instant::now() >= self.deadline {
				Poll::Ready(())
			} else {
				Poll::Pending
			}
		}
	}

	/// Time left until `deadline`, rounded up so the OS timer never fires
	/// before the [`Instant`] check agrees.
	fn left(deadline: Instant) -> Duration {
		deadline.saturating_duration_since(Instant::now()) + Duration::from_millis(1)
	}

	/// A descriptor that turns readable at `deadline` (`timerfd`).
	#[cfg(any(target_os = "linux", target_os = "android"))]
	fn arm(deadline: Instant) -> io::Result<OwnedFd> {
		let left = left(deadline);
		// SAFETY: plain syscall; the descriptor it returns is ours.
		let fd = unsafe {
			libc::timerfd_create(libc::CLOCK_MONOTONIC, libc::TFD_CLOEXEC | libc::TFD_NONBLOCK)
		};
		if fd < 0 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: a fresh descriptor nobody else owns.
		let fd = unsafe { OwnedFd::from_raw_fd(fd) };
		let spec = libc::itimerspec {
			it_interval: libc::timespec { tv_sec: 0, tv_nsec: 0 },
			it_value:    libc::timespec {
				tv_sec:  left.as_secs() as _,
				tv_nsec: left.subsec_nanos() as _,
			},
		};
		// SAFETY: `spec` is valid; the old value is not wanted.
		if unsafe { libc::timerfd_settime(fd.as_raw_fd(), 0, &raw const spec, ptr::null_mut()) } < 0 {
			return Err(io::Error::last_os_error());
		}
		Ok(fd)
	}

	/// A descriptor that turns readable at `deadline`: a kqueue holding one
	/// timer event (a kqueue polls readable while it has pending events).
	#[cfg(any(
		target_vendor = "apple",
		target_os = "freebsd",
		target_os = "netbsd",
		target_os = "openbsd",
		target_os = "dragonfly"
	))]
	fn arm(deadline: Instant) -> io::Result<OwnedFd> {
		let left = left(deadline);
		// SAFETY: plain syscall; the descriptor it returns is ours.
		let kq = unsafe { libc::kqueue() };
		if kq < 0 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: a fresh descriptor nobody else owns.
		let kq = unsafe { OwnedFd::from_raw_fd(kq) };
		// SAFETY: fcntl on our descriptor (a kqueue is not inherited by a fork;
		// close-on-exec keeps it out of an exec'd child as well).
		unsafe { libc::fcntl(kq.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) };
		// SAFETY: `kevent` is plain data; zero is a valid value of every field.
		let mut ev: libc::kevent = unsafe { std::mem::zeroed() };
		ev.ident = 1;
		ev.filter = libc::EVFILT_TIMER;
		ev.flags = libc::EV_ADD | libc::EV_ONESHOT;
		// Milliseconds, the default unit.
		ev.data = left.as_millis().min(i32::MAX as u128) as _;
		// SAFETY: one valid change, no event list, no timeout.
		if unsafe { libc::kevent(kq.as_raw_fd(), &raw const ev, 1, ptr::null_mut(), 0, ptr::null()) }
			< 0
		{
			return Err(io::Error::last_os_error());
		}
		Ok(kq)
	}

	/// No pollable timer here: the timer is due at once.
	#[cfg(not(any(
		target_os = "linux",
		target_os = "android",
		target_vendor = "apple",
		target_os = "freebsd",
		target_os = "netbsd",
		target_os = "openbsd",
		target_os = "dragonfly"
	)))]
	fn arm(_deadline: Instant) -> io::Result<OwnedFd> {
		Err(io::ErrorKind::Unsupported.into())
	}
}
