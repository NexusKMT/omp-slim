//! `Fs` and `File` over `std::fs`.
//!
//! Every operation is a local syscall and returns `Ready`, except opening a
//! FIFO for reading or for writing only: that waits for the other end, so it
//! returns `Pending` and a helper thread performs the open (dropping the
//! pending open releases the helper).
//!
//! Reads and writes on pipes, FIFOs, sockets and terminals never wait in the
//! kernel on Unix: the other end may be a vproc of the same engine (a FIFO, a
//! `/dev/fd/N` of a process substitution), and a terminal read must not stop
//! the scheduler (`read -t` timers, other vprocs). [`StdFile`] checks
//! readiness first and returns `Pending` with the waker registered on the
//! shared readiness thread (`ready`); the descriptor's flags stay untouched,
//! since externals inherit them. Windows pipes and consoles keep blocking
//! I/O (anonymous pipes cannot be polled).
//!
//! Windows specifics: `test -x` holds for directories, files with a
//! `PATHEXT` extension and files starting with `#!`; process substitution
//! uses a named pipe `\\.\pipe\obash-<pid>-<n>` (a regular temp file when
//! the engine asks for [`TempPurpose::HereDoc`], e.g. for a consumer that
//! must seek).

use std::{
	cell::RefCell,
	fs::{self, OpenOptions},
	io::{self, IsTerminal, Read, Seek, Write},
	path::Path,
	sync::atomic::{AtomicU32, Ordering},
	task::{Context, Poll},
	time::UNIX_EPOCH,
};

use bstr::{BStr, BString, ByteSlice};

use crate::bash::{
	DirEntry, DirIter, File, FileKind, Fs, FsPoll, OpenFlags, OsHandle, Stat, StdFd,
	fs::{Access, StatKind, TempNode, TempPurpose},
};

/// `Fs` over the host filesystem.
#[derive(Clone, Copy, Debug, Default)]
pub struct StdFs {
	/// The process's file-creation mask, when nothing changes it while this
	/// filesystem is in use (obash reads it once at startup; an embedding
	/// process may change its mask at any time and leaves this `None`). A
	/// create whose mode the mask leaves intact then takes a single `open`
	/// instead of an exclusive-create probe first ([`create_with_mode`]).
	pub umask: Option<u32>,
}

/// A host file, pipe or terminal as an engine [`File`].
#[derive(Debug)]
pub struct StdFile {
	/// Pending readiness waits (pipes, sockets, terminals), one for reading
	/// and one for writing: a terminal the line editor reads keys from is
	/// written to meanwhile (job notices, the display), which must not
	/// drop the read wait. Declared first so they are dropped, and
	/// forgotten by the waiting thread, before `file` closes.
	#[cfg(unix)]
	watch:  [Option<crate::sys::ready::Watch>; 2],
	file:   fs::File,
	kind:   FileKind,
	/// Access mode of the open file description (`O_ACCMODE` bits of
	/// `F_GETFL`; `None` when unknown).
	#[cfg(unix)]
	access: Option<libc::c_int>,
	/// The null device: a write is complete without a syscall.
	null:   bool,
	/// Read-ahead of a regular file this engine opened for reading only
	/// ([`StdFile::opened`]); `None` for every other file and once the
	/// descriptor was handed out ([`File::os_handle`], [`File::dup`]).
	ahead:  RefCell<Option<Ahead>>,
}

/// Bytes of a regular file read from the kernel beyond what the engine
/// consumed. `read` takes a chunk and gives back what follows its line
/// (`SeekFrom::Current(-n)`): with these at hand that is a move of `pos`, not
/// an `lseek`, and the next line needs no `read`. Only the kernel offset is
/// ahead of the engine's, and nothing else sees it until the descriptor is
/// handed out, which first [syncs](Ahead::sync) it.
#[derive(Debug, Default)]
struct Ahead {
	/// Allocated on the first read.
	buf:    Box<[u8]>,
	filled: usize,
	/// Next byte the engine reads.
	pos:    usize,
	/// The kernel offset: the file offset of `buf[filled]`.
	end:    u64,
}

/// Bytes an [`Ahead`] reads per `read`.
const AHEAD: usize = 32 << 10;

impl Ahead {
	fn read(&mut self, file: &mut fs::File, out: &mut [u8]) -> io::Result<usize> {
		if out.is_empty() {
			return Ok(0);
		}
		if self.pos == self.filled {
			if self.buf.is_empty() {
				self.buf = vec![0; AHEAD].into_boxed_slice();
			}
			let n = loop {
				match file.read(&mut self.buf) {
					Err(e) if e.kind() == io::ErrorKind::Interrupted => {},
					got => break got?,
				}
			};
			self.filled = n;
			self.pos = 0;
			self.end += n as u64;
		}
		let n = out.len().min(self.filled - self.pos);
		out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
		self.pos += n;
		Ok(n)
	}

	/// Move the kernel offset back to the engine's and drop the bytes ahead.
	fn sync(&mut self, mut file: &fs::File) -> io::Result<()> {
		let ahead = self.filled - self.pos;
		if ahead > 0 {
			self.end = file.seek(io::SeekFrom::Current(-(ahead as i64)))?;
		}
		self.filled = 0;
		self.pos = 0;
		Ok(())
	}

	fn seek(&mut self, file: &mut fs::File, pos: io::SeekFrom) -> io::Result<u64> {
		if let io::SeekFrom::Current(back @ ..=0) = pos
			&& let Some(pos) = self.pos.checked_sub(back.unsigned_abs() as usize)
		{
			self.pos = pos;
			return Ok(self.end - (self.filled - self.pos) as u64);
		}
		self.sync(file)?;
		self.end = file.seek(pos)?;
		Ok(self.end)
	}
}

impl StdFile {
	/// Wrap an open file, classifying it.
	pub fn new(file: fs::File) -> Self {
		let (kind, null) = classify(&file);
		Self::with_kind(file, kind, null)
	}

	/// Wrap a file this engine opened with `flags`. A regular file opened
	/// for reading only gets a read-ahead: its open file description is the
	/// engine's own until handed out.
	fn opened(file: fs::File, flags: OpenFlags) -> Self {
		let new = Self::new(file);
		if new.kind == FileKind::Regular && !flags.contains(OpenFlags::WRITE) {
			new.ahead.replace(Some(Ahead::default()));
		}
		new
	}

	/// Sync and drop the read-ahead: the descriptor is about to be shared.
	fn hand_out(&self) {
		if let Some(mut ahead) = self.ahead.take() {
			// A regular file seeks back within what it read; were that to
			// fail, the receiver could only see a later offset.
			let _ = ahead.sync(&self.file);
		}
	}

	#[cfg_attr(
		not(unix),
		expect(clippy::missing_const_for_fn, reason = "reads the access mode with fcntl on Unix")
	)]
	fn with_kind(file: fs::File, kind: FileKind, null: bool) -> Self {
		// Only a descriptor that waits for readiness consults its access
		// mode ([`Self::gated`]); a regular file or device skips the `fcntl`.
		#[cfg(unix)]
		let access = waits(kind)
			.then(|| {
				use std::os::fd::AsRawFd;
				// SAFETY: F_GETFL only reads the flags of our open descriptor.
				let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFL) };
				(flags >= 0).then_some(flags & libc::O_ACCMODE)
			})
			.flatten();
		Self {
			file,
			kind,
			#[cfg(unix)]
			watch: [None, None],
			#[cfg(unix)]
			access,
			null,
			ahead: RefCell::new(None),
		}
	}

	/// Whether I/O in this direction must wait for readiness instead of
	/// blocking. A direction the descriptor was not opened for is never
	/// gated: the syscall fails at once with `EBADF`, while readiness would
	/// never come (`poll` on a pipe's read end never reports `POLLOUT`).
	#[cfg(unix)]
	fn gated(&self, write: bool) -> bool {
		let wanted = if write {
			libc::O_WRONLY
		} else {
			libc::O_RDONLY
		};
		let allowed = self
			.access
			.is_none_or(|acc| acc == libc::O_RDWR || acc == wanted);
		allowed && waits(self.kind)
	}

	/// `Ready` when `events` are ready now; else registers `cx`'s waker.
	#[cfg(unix)]
	fn ready(&mut self, cx: &Context<'_>, events: i16) -> Poll<io::Result<()>> {
		use std::os::fd::AsRawFd;

		use crate::sys::ready;
		let fd = self.file.as_raw_fd();
		let slot = usize::from(events != ready::READ);
		match ready::now(fd, events) {
			Ok(true) => {
				self.watch[slot] = None;
				return Poll::Ready(Ok(()));
			},
			Ok(false) => {},
			Err(e) => return Poll::Ready(Err(e)),
		}
		// Replace any earlier watch of this direction, so only the latest
		// waker is kept.
		self.watch[slot] = None;
		match ready::watch(fd, events, cx.waker()) {
			Ok(w) => self.watch[slot] = Some(w),
			Err(e) => return Poll::Ready(Err(e)),
		}
		// It may have become ready before the watch was registered; the
		// poller would see that too, this only saves a round trip.
		match ready::now(fd, events) {
			Ok(true) => {
				self.watch[slot] = None;
				Poll::Ready(Ok(()))
			},
			Ok(false) => Poll::Pending,
			Err(e) => Poll::Ready(Err(e)),
		}
	}

	/// Write what fits without waiting: `ready::WRITE_CHUNK` bytes per
	/// readiness check, as long as the descriptor stays writable.
	#[cfg(unix)]
	fn write_ready(&mut self, buf: &[u8]) -> io::Result<usize> {
		use std::os::fd::AsRawFd;

		use crate::sys::ready;
		let fd = self.file.as_raw_fd();
		let mut done = 0;
		while done < buf.len() {
			if done > 0 && !ready::now(fd, ready::WRITE)? {
				break;
			}
			let end = buf.len().min(done + ready::WRITE_CHUNK);
			match self.file.write(&buf[done..end]) {
				Ok(n) => done += n,
				Err(e) if done > 0 && e.kind() != io::ErrorKind::Interrupted => break,
				Err(e) if e.kind() == io::ErrorKind::Interrupted => {},
				Err(e) => return Err(e),
			}
		}
		Ok(done)
	}
}

/// Whether I/O on a descriptor of `kind` waits for readiness instead of
/// blocking ([`StdFile::gated`]).
#[cfg(unix)]
const fn waits(kind: FileKind) -> bool {
	matches!(kind, FileKind::Pipe | FileKind::Socket | FileKind::Tty)
}

/// The file's kind, and whether it is the null device. Only a character
/// device (or a handle `fstat` cannot read) can be a terminal, so a regular
/// file, pipe or socket costs one `fstat` and no terminal probe.
#[cfg(unix)]
fn classify(file: &fs::File) -> (FileKind, bool) {
	use std::{
		os::unix::fs::{FileTypeExt, MetadataExt},
		sync::LazyLock,
	};
	let Ok(meta) = file.metadata() else {
		return if file.is_terminal() {
			(FileKind::Tty, false)
		} else {
			(FileKind::Device, false)
		};
	};
	let ft = meta.file_type();
	if ft.is_file() {
		return (FileKind::Regular, false);
	}
	if ft.is_fifo() {
		return (FileKind::Pipe, false);
	}
	if ft.is_socket() {
		return (FileKind::Socket, false);
	}
	if ft.is_char_device() && file.is_terminal() {
		return (FileKind::Tty, false);
	}
	/// `/dev/null`'s device number.
	static NULL: LazyLock<Option<u64>> =
		LazyLock::new(|| fs::metadata("/dev/null").ok().map(|m| m.rdev()));
	if ft.is_char_device() && Some(meta.rdev()) == *NULL {
		return (FileKind::Device, true);
	}
	(FileKind::Device, false)
}

/// The file's kind (the null device is not told apart). The handle's type
/// decides, not its metadata: `GetFileInformationByHandle` can succeed on
/// a pipe and report a plain file, which made the line reader read ahead
/// on a pipe and lose what it could not seek back over.
#[cfg(windows)]
fn classify(file: &fs::File) -> (FileKind, bool) {
	use std::os::windows::io::AsRawHandle;

	use windows_sys::Win32::Storage::FileSystem::{
		FILE_TYPE_CHAR, FILE_TYPE_DISK, FILE_TYPE_PIPE, GetFileType,
	};
	// SAFETY: `GetFileType` only inspects the handle `file` owns.
	let kind = match unsafe { GetFileType(file.as_raw_handle()) } {
		FILE_TYPE_DISK => FileKind::Regular,
		FILE_TYPE_PIPE => FileKind::Pipe,
		// A console; `NUL` and serial ports are character devices too.
		FILE_TYPE_CHAR if file.is_terminal() => FileKind::Tty,
		_ => FileKind::Device,
	};
	(kind, false)
}

/// How long a console read that ended with nothing read waits for the
/// console's control handler (it runs on a thread of its own) to report a
/// Ctrl-C before the read counts as end of input.
#[cfg(windows)]
const CTRL_C_GRACE: std::time::Duration = std::time::Duration::from_millis(100);

/// A read of a console in line mode. Ctrl-C ends it with nothing read,
/// which is no end of input: as a terminal read interrupted by `SIGINT`
/// (`EINTR`), the shell takes the signal (its trap runs, or it ends) and
/// reads on. The console reports it as `ERROR_OPERATION_ABORTED`, a
/// pseudoconsole not at all, so a Ctrl-C the shell's handler claimed
/// ([`console::ctrl_c_since`](crate::sys::console::ctrl_c_since)) counts
/// too. `ReadFile` itself: the standard library reads through
/// `NtReadFile`, which sets no last error.
#[cfg(windows)]
fn console_read(
	file: &fs::File,
	cx: &std::task::Context<'_>,
	buf: &mut [u8],
) -> Poll<io::Result<usize>> {
	use std::os::windows::io::AsRawHandle;

	use windows_sys::Win32::{
		Foundation::{ERROR_BROKEN_PIPE, ERROR_OPERATION_ABORTED, GetLastError, SetLastError},
		Storage::FileSystem::ReadFile,
	};

	use crate::sys::console;
	let len = u32::try_from(buf.len()).unwrap_or(u32::MAX);
	let mut got = 0u32;
	let before = console::ctrl_c_count();
	// SAFETY: `buf` holds at least `len` bytes; a synchronous read of the
	// handle `file` owns; the last-error value is the calling thread's.
	let (ok, err) = unsafe {
		SetLastError(0);
		let ok =
			ReadFile(file.as_raw_handle(), buf.as_mut_ptr(), len, &raw mut got, std::ptr::null_mut());
		(ok != 0, GetLastError())
	};
	if got != 0 {
		return Poll::Ready(Ok(got as usize));
	}
	let claimed = console::ctrl_c_since(before, CTRL_C_GRACE);
	if !claimed && err != ERROR_OPERATION_ABORTED {
		return Poll::Ready(if ok || err == ERROR_BROKEN_PIPE {
			Ok(0)
		} else {
			Err(io::Error::from_raw_os_error(err as i32))
		});
	}
	// The handler has posted the signal: the shell takes it before it
	// polls this read again.
	cx.waker().wake_by_ref();
	Poll::Pending
}

/// The process's own standard stream `fd` (a duplicate of it), `None` when
/// it is closed.
pub fn std_stream(fd: StdFd) -> Option<Box<dyn File>> {
	#[cfg(unix)]
	let owned = {
		use std::os::fd::AsFd;
		match fd {
			StdFd::Stdin => io::stdin().as_fd().try_clone_to_owned(),
			StdFd::Stdout => io::stdout().as_fd().try_clone_to_owned(),
			StdFd::Stderr => io::stderr().as_fd().try_clone_to_owned(),
		}
	};
	#[cfg(windows)]
	let owned = {
		use std::os::windows::io::AsHandle;
		match fd {
			StdFd::Stdin => io::stdin().as_handle().try_clone_to_owned(),
			StdFd::Stdout => io::stdout().as_handle().try_clone_to_owned(),
			StdFd::Stderr => io::stderr().as_handle().try_clone_to_owned(),
		}
	};
	owned
		.ok()
		.map(|h| Box::new(StdFile::new(fs::File::from(h))) as Box<dyn File>)
}

impl File for StdFile {
	fn poll_read(&mut self, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
		if let Some(ahead) = self.ahead.get_mut() {
			return Poll::Ready(ahead.read(&mut self.file, buf));
		}
		#[cfg(unix)]
		if self.gated(false) {
			if let Err(e) = std::task::ready!(self.ready(cx, crate::sys::ready::READ)) {
				return Poll::Ready(Err(e));
			}
			// Readable (or hung up): this read returns without waiting.
			return Poll::Ready(self.file.read(buf));
		}
		#[cfg(windows)]
		if self.kind == FileKind::Tty && !buf.is_empty() {
			return console_read(&self.file, cx, buf);
		}
		#[cfg(not(unix))]
		let _ = cx;
		Poll::Ready(self.file.read(buf))
	}

	fn poll_write(&mut self, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
		if self.null {
			return Poll::Ready(Ok(buf.len()));
		}
		#[cfg(unix)]
		if self.gated(true) && !buf.is_empty() {
			if let Err(e) = std::task::ready!(self.ready(cx, crate::sys::ready::WRITE)) {
				return Poll::Ready(Err(e));
			}
			return Poll::Ready(self.write_ready(buf));
		}
		#[cfg(not(unix))]
		let _ = cx;
		Poll::Ready(self.file.write(buf))
	}

	fn poll_flush(&mut self, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		Poll::Ready(self.file.flush())
	}

	fn seek(&mut self, pos: io::SeekFrom) -> io::Result<u64> {
		match self.ahead.get_mut() {
			Some(ahead) => ahead.seek(&mut self.file, pos),
			None => self.file.seek(pos),
		}
	}

	fn kind(&self) -> FileKind {
		self.kind
	}

	fn os_handle(&self) -> Option<OsHandle> {
		self.hand_out();
		#[cfg(unix)]
		{
			use std::os::fd::AsRawFd;
			u64::try_from(self.file.as_raw_fd()).ok().map(OsHandle)
		}
		#[cfg(windows)]
		{
			use std::os::windows::io::AsRawHandle;
			Some(OsHandle(self.file.as_raw_handle().addr() as u64))
		}
	}

	fn stat(&self) -> io::Result<Stat> {
		self.file.metadata().map(|m| stat_of(&m))
	}

	fn dup(&self) -> io::Result<Box<dyn File>> {
		self.hand_out();
		Ok(Box::new(Self::with_kind(self.file.try_clone()?, self.kind, self.null)))
	}
}

/// Engine path → host path (UTF-8 required on Windows). A URL path
/// ([`crate::bash::fs::url_root_len`]) names no host file: `NotFound`, rather
/// than a lookup relative to the process's working directory. On Windows,
/// `/dev/null` is the null device `NUL` (else `\dev\null` on the current
/// drive, which does not exist).
pub fn host_path(p: &[u8]) -> io::Result<&Path> {
	if crate::bash::fs::url_root_len(p).is_some() {
		return Err(io::Error::from(io::ErrorKind::NotFound));
	}
	if cfg!(windows) && p == b"/dev/null" {
		return Ok(Path::new("NUL"));
	}
	p.to_path()
		.map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))
}

/// Host path → engine bytes.
fn engine_path(p: &Path) -> BString {
	BString::from(p.as_os_str().as_encoded_bytes())
}

fn kind_of(ft: fs::FileType) -> StatKind {
	if ft.is_dir() {
		return StatKind::Dir;
	}
	if ft.is_symlink() {
		return StatKind::Symlink;
	}
	if ft.is_file() {
		return StatKind::File;
	}
	#[cfg(unix)]
	{
		use std::os::unix::fs::FileTypeExt;
		if ft.is_fifo() {
			return StatKind::Fifo;
		}
		if ft.is_socket() {
			return StatKind::Socket;
		}
		if ft.is_block_device() {
			return StatKind::BlockDev;
		}
	}
	StatKind::CharDev
}

fn stat_of(meta: &fs::Metadata) -> Stat {
	let kind = kind_of(meta.file_type());
	let since_epoch = |t: io::Result<std::time::SystemTime>| {
		t.ok()
			.and_then(|t| t.duration_since(UNIX_EPOCH).ok())
			.map_or(0, |d| d.as_nanos() as i64)
	};
	let mtime_ns = since_epoch(meta.modified());
	let atime_ns = since_epoch(meta.accessed());
	#[cfg(unix)]
	{
		use std::os::unix::fs::MetadataExt;
		Stat {
			kind,
			mode: meta.mode() & 0o7777,
			size: meta.size(),
			uid: meta.uid(),
			gid: meta.gid(),
			dev: meta.dev(),
			ino: meta.ino(),
			nlink: meta.nlink(),
			mtime_ns,
			atime_ns,
			ctime_ns: meta
				.ctime()
				.saturating_mul(1_000_000_000)
				.saturating_add(meta.ctime_nsec()),
			blocks: meta.blocks(),
			rdev: meta.rdev(),
			blksize: meta.blksize(),
		}
	}
	#[cfg(windows)]
	{
		let mode = match (kind, meta.permissions().readonly()) {
			(StatKind::Dir, _) => 0o755,
			(_, true) => 0o444,
			(_, false) => 0o644,
		};
		let (uid, gid) = crate::sys::user::owner();
		Stat {
			kind,
			mode,
			size: meta.len(),
			uid,
			gid,
			dev: 0,
			ino: 0,
			nlink: 1,
			mtime_ns,
			atime_ns,
			// Windows has no status-change time: the creation time stands in.
			ctime_ns: since_epoch(meta.created()),
			blocks: meta.len().div_ceil(512),
			rdev: 0,
			blksize: 4096,
		}
	}
}

fn open(path: &BStr, flags: OpenFlags, mode: u32, umask: Option<u32>) -> io::Result<Box<dyn File>> {
	#[cfg(windows)]
	if let Some(server) = pipe::take(path, flags) {
		return server;
	}
	let path = host_path(path)?;
	Ok(Box::new(StdFile::opened(create_with_mode(path, flags, mode, umask, false)?, flags)))
}

/// [`open`] for writing only, without waiting for a FIFO's reader: such a
/// FIFO fails at once with `ENXIO` (the caller then waits on the helper
/// thread), and nothing is stat'ed first. The descriptor is left blocking,
/// as a plain open leaves it, since externals inherit its flags.
#[cfg(unix)]
fn open_for_writing(
	path: &BStr,
	flags: OpenFlags,
	mode: u32,
	umask: Option<u32>,
) -> io::Result<Box<dyn File>> {
	use std::os::fd::AsRawFd;
	let file = create_with_mode(host_path(path)?, flags, mode, umask, true)?;
	let mut status = if flags.contains(OpenFlags::APPEND) {
		libc::O_APPEND
	} else {
		0
	};
	if flags.contains(OpenFlags::NONBLOCK) {
		status |= libc::O_NONBLOCK;
	}
	// SAFETY: F_SETFL sets the status flags of our own open descriptor.
	if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETFL, status) } < 0 {
		return Err(io::Error::last_os_error());
	}
	Ok(Box::new(StdFile::opened(file, flags)))
}

/// Opens `path`, giving a file the open creates exactly `mode`.
///
/// The engine passes `0o666 & !umask` with the shell's own umask, but the
/// kernel still applies the process umask (`process_umask`) on creation, so
/// a looser shell mask (`umask 000`) would lose the bits the process mask
/// clears. When the process mask is known and clears none of `mode`, a plain
/// open already creates exactly `mode`. Otherwise only an exclusive create
/// proves the file is new (an existing file keeps its mode), so a plain
/// `O_CREAT` open tries one first and falls back on `EEXIST`.
fn create_with_mode(
	path: &std::path::Path,
	flags: OpenFlags,
	mode: u32,
	process_umask: Option<u32>,
	nonblock: bool,
) -> io::Result<fs::File> {
	let options = || {
		#[cfg_attr(not(unix), expect(unused_mut, reason = "custom flags are Unix's"))]
		let mut o = options(flags, mode);
		#[cfg(unix)]
		if nonblock {
			use std::os::unix::fs::OpenOptionsExt;
			// `custom_flags` replaces the earlier ones.
			o.custom_flags(libc::O_NONBLOCK | custom_flags(flags));
		}
		#[cfg(not(unix))]
		let _ = nonblock;
		o
	};
	#[cfg(not(unix))]
	let _ = process_umask;
	#[cfg(unix)]
	if flags.contains(OpenFlags::CREATE) && process_umask.is_none_or(|mask| mode & mask != 0) {
		use std::os::unix::fs::PermissionsExt as _;
		let mut exclusive = options();
		exclusive.create_new(true);
		match exclusive.open(path) {
			Ok(file) => {
				// Best effort: without it the file keeps the stricter mode
				// the process umask left.
				let _ = file.set_permissions(fs::Permissions::from_mode(mode & 0o7777));
				return Ok(file);
			},
			Err(err)
				if err.kind() == io::ErrorKind::AlreadyExists && !flags.contains(OpenFlags::EXCL) => {},
			Err(err) => return Err(err),
		}
	}
	options().open(path)
}

fn options(flags: OpenFlags, mode: u32) -> OpenOptions {
	let mut o = OpenOptions::new();
	// `OpenOptions` refuses append with truncate, which `open(2)` takes
	// (zsh `sysopen -a -o trunc`): on Unix the append flag then goes in as
	// a custom flag ([`custom_flags`]).
	let append_trunc =
		cfg!(unix) && flags.contains(OpenFlags::APPEND) && flags.contains(OpenFlags::TRUNC);
	o.read(flags.contains(OpenFlags::READ))
		.write(flags.contains(OpenFlags::WRITE) || append_trunc)
		.append(flags.contains(OpenFlags::APPEND) && !append_trunc)
		.truncate(flags.contains(OpenFlags::TRUNC))
		.create(flags.contains(OpenFlags::CREATE));
	if flags.contains(OpenFlags::EXCL) {
		o.create_new(true);
	}
	#[cfg(unix)]
	{
		use std::os::unix::fs::OpenOptionsExt;
		o.mode(mode);
		let custom = custom_flags(flags);
		if custom != 0 {
			o.custom_flags(custom);
		}
	}
	#[cfg(windows)]
	let _ = mode;
	o
}

/// The `open(2)` flags of `flags` that [`OpenOptions`] has no setter for.
#[cfg(unix)]
const fn custom_flags(flags: OpenFlags) -> libc::c_int {
	let mut custom = 0;
	if flags.contains(OpenFlags::APPEND) && flags.contains(OpenFlags::TRUNC) {
		custom |= libc::O_APPEND;
	}
	if flags.contains(OpenFlags::NOFOLLOW) {
		custom |= libc::O_NOFOLLOW;
	}
	if flags.contains(OpenFlags::SYNC) {
		custom |= libc::O_SYNC;
	}
	#[cfg(any(target_os = "linux", target_os = "android"))]
	if flags.contains(OpenFlags::NOATIME) {
		custom |= libc::O_NOATIME;
	}
	if flags.contains(OpenFlags::NONBLOCK) {
		custom |= libc::O_NONBLOCK;
	}
	custom
}

/// Opening a FIFO in one direction blocks until the other end opens; it runs
/// on a helper thread and completes as a pending fs op.
#[cfg(unix)]
mod fifo {
	use std::{
		fs::{self, OpenOptions},
		io,
		os::unix::fs::{FileTypeExt, OpenOptionsExt},
		path::PathBuf,
		sync::Arc,
		task::{Context, Poll, Waker},
		thread,
	};

	use bstr::BStr;
	use parking_lot::Mutex;

	use super::{StdFile, host_path, options};
	use crate::bash::{File, FsPending, OpenFlags};

	/// Result slot shared with the helper thread.
	#[derive(Default)]
	struct Slot {
		result:    Option<io::Result<fs::File>>,
		waker:     Option<Waker>,
		/// The result was handed to the engine.
		finished:  bool,
		/// The engine dropped the open: the helper closes what it gets.
		cancelled: bool,
	}

	/// A FIFO open in flight.
	struct FifoOpen {
		slot:  Arc<Mutex<Slot>>,
		path:  PathBuf,
		write: bool,
	}

	/// `Some` when `path` is a FIFO opened for reading only or writing only
	/// (`O_RDWR` never blocks on a FIFO).
	pub fn pending(
		path: &BStr,
		flags: OpenFlags,
		mode: u32,
	) -> Option<Box<dyn FsPending<Box<dyn File>>>> {
		let write = flags.contains(OpenFlags::WRITE);
		if flags.contains(OpenFlags::READ) == write {
			return None;
		}
		let host = host_path(path).ok()?;
		if !fs::metadata(host).ok()?.file_type().is_fifo() {
			return None;
		}
		let slot = Arc::new(Mutex::new(Slot::default()));
		let (opts, target, helper) = (options(flags, mode), host.to_path_buf(), Arc::clone(&slot));
		let spawned = thread::Builder::new()
			.name("obash-fifo".into())
			.stack_size(64 << 10)
			.spawn(move || {
				let opened = opts.open(&target);
				let mut s = helper.lock();
				if s.cancelled {
					return;
				}
				s.result = Some(opened);
				let waker = s.waker.take();
				drop(s);
				if let Some(w) = waker {
					w.wake();
				}
			});
		if let Err(e) = spawned {
			slot.lock().result = Some(Err(e));
		}
		Some(Box::new(FifoOpen { slot, path: host.to_path_buf(), write }))
	}

	impl FsPending<Box<dyn File>> for FifoOpen {
		fn poll(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<Box<dyn File>>> {
			let mut s = self.slot.lock();
			if let Some(r) = s.result.take() {
				s.finished = true;
				return Poll::Ready(r.map(|f| Box::new(StdFile::new(f)) as Box<dyn File>));
			}
			if !s.waker.as_ref().is_some_and(|w| w.will_wake(cx.waker())) {
				s.waker = Some(cx.waker().clone());
			}
			Poll::Pending
		}

		/// Cancelling releases the helper by briefly opening the other end,
		/// which the real other end can observe (a writer that comes and
		/// goes reads as end of file).
		fn reissuable(&self) -> bool {
			false
		}
	}

	impl Drop for FifoOpen {
		fn drop(&mut self) {
			{
				let mut s = self.slot.lock();
				if s.finished || s.result.is_some() {
					return;
				}
				s.cancelled = true;
			}
			// Release the helper blocked in open(2): be the other end for a
			// moment, without blocking ourselves.
			let mut other = OpenOptions::new();
			if self.write {
				other.read(true);
			} else {
				other.write(true);
			}
			other.custom_flags(libc::O_NONBLOCK);
			let _ = other.open(&self.path);
		}
	}
}

fn access(path: &BStr, mode: Access) -> io::Result<()> {
	#[cfg(unix)]
	{
		let c = std::ffi::CString::new(path.as_bytes())
			.map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
		let mut m = libc::F_OK;
		if mode.contains(Access::READ) {
			m |= libc::R_OK;
		}
		if mode.contains(Access::WRITE) {
			m |= libc::W_OK;
		}
		if mode.contains(Access::EXEC) {
			m |= libc::X_OK;
		}
		// SAFETY: `c` is a valid NUL-terminated string for the duration of the
		// call.
		if unsafe { libc::access(c.as_ptr(), m) } == 0 {
			Ok(())
		} else {
			Err(io::Error::last_os_error())
		}
	}
	#[cfg(windows)]
	{
		if path.as_bytes() == b"/dev/null" {
			// The null device takes reads and writes; it runs nothing.
			return if mode.contains(Access::EXEC) {
				Err(io::ErrorKind::PermissionDenied.into())
			} else {
				Ok(())
			};
		}
		let p = host_path(path)?;
		let meta = fs::metadata(p)?;
		if mode.contains(Access::WRITE) && meta.permissions().readonly() {
			return Err(io::ErrorKind::PermissionDenied.into());
		}
		if mode.contains(Access::EXEC)
			&& !meta.is_dir()
			&& !crate::sys::pathext::Pathext::from_env().has_executable_extension(p)
			&& !crate::sys::shebang::has_shebang(p)
		{
			return Err(io::ErrorKind::PermissionDenied.into());
		}
		Ok(())
	}
}

/// Directory listing collected up front (a local readdir).
struct StdDir(std::vec::IntoIter<io::Result<DirEntry>>);

impl DirIter for StdDir {
	fn poll_next(&mut self, _cx: &mut Context<'_>) -> Poll<Option<io::Result<DirEntry>>> {
		Poll::Ready(self.0.next())
	}
}

fn read_dir(path: &BStr) -> io::Result<Box<dyn DirIter>> {
	let entries: Vec<io::Result<DirEntry>> = fs::read_dir(host_path(path)?)?
		.map(|e| {
			e.map(|e| DirEntry {
				name: BString::from(e.file_name().as_encoded_bytes()),
				kind: e.file_type().ok().map(kind_of),
			})
		})
		.collect();
	Ok(Box::new(StdDir(entries.into_iter())))
}

/// Unique temp names within this process.
static TEMP_SEQ: AtomicU32 = AtomicU32::new(0);

fn temp(purpose: TempPurpose) -> io::Result<TempNode> {
	let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
	#[cfg(windows)]
	if let TempPurpose::ProcSub { output } = purpose {
		return pipe::create(output, seq);
	}
	let path = std::env::temp_dir().join(format!("obash-{}-{seq}", std::process::id()));
	let fifo = matches!(purpose, TempPurpose::ProcSub { .. }) && cfg!(unix);
	if fifo {
		#[cfg(unix)]
		{
			let c = std::ffi::CString::new(path.as_os_str().as_encoded_bytes())
				.map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
			// SAFETY: `c` is a valid NUL-terminated path for the duration of the
			// call.
			if unsafe { libc::mkfifo(c.as_ptr(), 0o600) } != 0 {
				return Err(io::Error::last_os_error());
			}
		}
	} else {
		fs::File::create_new(&path)?;
	}
	Ok(TempNode { path: engine_path(&path), fifo })
}

fn chdir_check(path: &BStr) -> io::Result<()> {
	if !fs::metadata(host_path(path)?)?.is_dir() {
		return Err(io::ErrorKind::NotADirectory.into());
	}
	access(path, Access::EXEC)
}

/// Named pipes for process substitution on Windows.
///
/// [`pipe::create`] makes the server end and parks it; the producer side of
/// the substitution takes it with [`Fs::open`] in its direction (write for
/// `<( )`, read for `>( )`), the consumer opens the path as a client. The
/// server end is overlapped ([`OsPipe::server`](crate::sys::pump::os::OsPipe)):
/// it connects on first I/O, which stays `Pending` until the consumer has
/// opened the path, and its reads and writes never wait either. It reports
/// no OS handle, so an external producer is fed through a pump.
#[cfg(windows)]
mod pipe {
	use std::{
		collections::HashMap,
		io,
		os::windows::io::{FromRawHandle, OwnedHandle},
		ptr,
		sync::{Arc, LazyLock},
		task::{Context, Poll},
	};

	use bstr::{BStr, BString};
	use parking_lot::Mutex;
	use windows_sys::Win32::{
		Storage::FileSystem::{
			FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, PIPE_ACCESS_INBOUND,
			PIPE_ACCESS_OUTBOUND,
		},
		System::Pipes::{
			CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
			PIPE_WAIT,
		},
	};

	use crate::{
		bash::{File, FileKind, OpenFlags, OsHandle, fs::TempNode},
		sys::pump::os::OsPipe,
	};

	/// Server ends not yet taken, by path; `true` when the server writes.
	static PENDING: LazyLock<Mutex<HashMap<BString, (OwnedHandle, bool)>>> =
		LazyLock::new(|| Mutex::new(HashMap::new()));

	const BUF: u32 = 64 << 10;

	/// Create the pipe for a `<( )` (`output == false`: we write, the
	/// consumer reads) or `>( )` substitution.
	pub fn create(output: bool, seq: u32) -> io::Result<TempNode> {
		let name = format!(r"\\.\pipe\obash-{}-{seq}", std::process::id());
		let wide: Vec<u16> = name.encode_utf16().chain([0]).collect();
		let access = if output {
			PIPE_ACCESS_INBOUND
		} else {
			PIPE_ACCESS_OUTBOUND
		};
		// SAFETY: `wide` is NUL-terminated; null security attributes.
		let h = unsafe {
			CreateNamedPipeW(
				wide.as_ptr(),
				access | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
				PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
				1,
				BUF,
				BUF,
				0,
				ptr::null(),
			)
		};
		if h.is_null() || h as isize == -1 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: a fresh handle we own.
		let h = unsafe { OwnedHandle::from_raw_handle(h.cast()) };
		let path = BString::from(name);
		PENDING.lock().insert(path.clone(), (h, !output));
		Ok(TempNode { path, fifo: true })
	}

	/// The parked server end of `path`, when `flags` open it in the server's
	/// direction; `None` leaves the open to the client path.
	pub fn take(path: &BStr, flags: OpenFlags) -> Option<io::Result<Box<dyn File>>> {
		let mut pending = PENDING.lock();
		let &(_, writes) = pending.get(path)?;
		if flags.contains(OpenFlags::WRITE) != writes {
			return None;
		}
		let (h, _) = pending.remove(path)?;
		Some(OsPipe::server(h).map(|pipe| {
			Box::new(Server(Arc::new(Mutex::new(ServerEnd { pipe, connected: false }))))
				as Box<dyn File>
		}))
	}

	/// Server end of a substitution pipe. Duplicates share it, as the
	/// duplicates of one open file do.
	struct Server(Arc<Mutex<ServerEnd>>);

	struct ServerEnd {
		pipe:      OsPipe,
		connected: bool,
	}

	impl ServerEnd {
		/// Ready once the consumer has connected (`Pending` until it opens
		/// the path, like opening a FIFO, without waiting).
		fn poll_connected(&mut self, cx: &Context<'_>) -> Poll<io::Result<()>> {
			if !self.connected {
				std::task::ready!(self.pipe.poll_connect(cx))?;
				self.connected = true;
			}
			Poll::Ready(Ok(()))
		}
	}

	impl File for Server {
		fn poll_read(&mut self, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
			let mut end = self.0.lock();
			if let Err(e) = std::task::ready!(end.poll_connected(cx)) {
				return Poll::Ready(Err(e));
			}
			end.pipe.poll_read(cx, buf)
		}

		fn poll_write(&mut self, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
			let mut end = self.0.lock();
			if let Err(e) = std::task::ready!(end.poll_connected(cx)) {
				return Poll::Ready(Err(e));
			}
			end.pipe.poll_write(cx, buf)
		}

		fn poll_flush(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
			let mut end = self.0.lock();
			if !end.connected {
				return Poll::Ready(Ok(()));
			}
			end.pipe.poll_flush(cx)
		}

		fn seek(&mut self, _pos: io::SeekFrom) -> io::Result<u64> {
			Err(io::ErrorKind::NotSeekable.into())
		}

		fn kind(&self) -> FileKind {
			FileKind::Pipe
		}

		fn os_handle(&self) -> Option<OsHandle> {
			// Externals would write before the consumer connects: pump instead.
			None
		}

		fn dup(&self) -> io::Result<Box<dyn File>> {
			Ok(Box::new(Self(Arc::clone(&self.0))))
		}
	}
}

impl Fs for StdFs {
	fn open(&mut self, path: &BStr, flags: OpenFlags, mode: u32) -> FsPoll<Box<dyn File>> {
		// The console, as `/dev/tty` is the controlling terminal on Unix.
		#[cfg(windows)]
		if path.as_bytes() == b"/dev/tty" {
			return FsPoll::Ready(crate::sys::console::open_tty());
		}
		#[cfg(unix)]
		if flags.contains(OpenFlags::WRITE) && !flags.contains(OpenFlags::READ) {
			match open_for_writing(path, flags, mode, self.umask) {
				// No reader (or not a FIFO at all: the checks below tell).
				Err(err) if err.raw_os_error() == Some(libc::ENXIO) => {},
				opened => return FsPoll::Ready(opened),
			}
		}
		#[cfg(unix)]
		if let Some(pending) = fifo::pending(path, flags, mode) {
			return FsPoll::Pending(pending);
		}
		FsPoll::Ready(open(path, flags, mode, self.umask))
	}

	fn stat(&mut self, path: &BStr, follow: bool) -> FsPoll<Stat> {
		// `NUL` has no metadata on Windows (`GetFileAttributesEx` fails):
		// answer as Unix does for `/dev/null`, a world-writable character
		// device.
		#[cfg(windows)]
		if path.as_bytes() == b"/dev/null" {
			return FsPoll::Ready(Ok(Stat {
				kind:     StatKind::CharDev,
				mode:     0o666,
				size:     0,
				uid:      0,
				gid:      0,
				dev:      0,
				ino:      0,
				nlink:    1,
				mtime_ns: 0,
				atime_ns: 0,
				ctime_ns: 0,
				blocks:   0,
				rdev:     0,
				blksize:  4096,
			}));
		}
		FsPoll::Ready(
			host_path(path)
				.and_then(|p| {
					if follow {
						fs::metadata(p)
					} else {
						fs::symlink_metadata(p)
					}
				})
				.map(|m| stat_of(&m)),
		)
	}

	fn access(&mut self, path: &BStr, mode: Access) -> FsPoll<()> {
		FsPoll::Ready(access(path, mode))
	}

	fn read_dir(&mut self, path: &BStr) -> FsPoll<Box<dyn DirIter>> {
		FsPoll::Ready(read_dir(path))
	}

	fn readlink(&mut self, path: &BStr) -> FsPoll<BString> {
		FsPoll::Ready(
			host_path(path)
				.and_then(fs::read_link)
				.map(|p| engine_path(&p)),
		)
	}

	fn realpath(&mut self, path: &BStr) -> FsPoll<BString> {
		FsPoll::Ready(host_path(path).and_then(fs::canonicalize).map(|p| {
			// `C:\x`, not `\\?\C:\x`, where both name the file.
			let p = engine_path(&p);
			if cfg!(windows) {
				BString::from(crate::bash::fs::plain_windows_path(&p).into_owned())
			} else {
				p
			}
		}))
	}

	fn mkfifo_or_temp(&mut self, purpose: TempPurpose) -> FsPoll<TempNode> {
		FsPoll::Ready(temp(purpose))
	}

	fn chdir_check(&mut self, path: &BStr) -> FsPoll<()> {
		FsPoll::Ready(chdir_check(path))
	}

	fn unlink(&mut self, path: &BStr) -> FsPoll<()> {
		FsPoll::Ready(host_path(path).and_then(fs::remove_file))
	}

	fn rename(&mut self, from: &BStr, to: &BStr) -> FsPoll<()> {
		FsPoll::Ready(host_path(from).and_then(|f| fs::rename(f, host_path(to)?)))
	}

	fn symlink(&mut self, target: &BStr, path: &BStr) -> FsPoll<()> {
		#[cfg(unix)]
		let res = host_path(path).and_then(|p| std::os::unix::fs::symlink(host_path(target)?, p));
		#[cfg(not(unix))]
		let res = {
			let _ = (target, path);
			Err(io::ErrorKind::Unsupported.into())
		};
		FsPoll::Ready(res)
	}

	fn link(&mut self, from: &BStr, to: &BStr) -> FsPoll<()> {
		FsPoll::Ready(host_path(from).and_then(|f| fs::hard_link(f, host_path(to)?)))
	}

	fn lock(&mut self, path: &BStr) -> FsPoll<Box<dyn File>> {
		FsPoll::Ready(lock_file(path))
	}

	fn lock_fd(&mut self, file: OsHandle, lock: crate::bash::fs::FdLock) -> FsPoll<()> {
		FsPoll::Ready(lock_fd(file, lock))
	}

	fn mkdir(&mut self, path: &BStr, mode: u32) -> FsPoll<()> {
		FsPoll::Ready(host_path(path).and_then(|p| super::fs_ops::mkdir(p, mode, self.umask)))
	}

	fn rmdir(&mut self, path: &BStr) -> FsPoll<()> {
		FsPoll::Ready(host_path(path).and_then(fs::remove_dir))
	}

	fn chmod(&mut self, path: &BStr, mode: u32) -> FsPoll<()> {
		FsPoll::Ready(host_path(path).and_then(|p| super::fs_ops::chmod(p, mode)))
	}

	fn chown(
		&mut self,
		path: &BStr,
		uid: Option<u32>,
		gid: Option<u32>,
		follow: bool,
	) -> FsPoll<()> {
		FsPoll::Ready(host_path(path).and_then(|p| super::fs_ops::chown(p, uid, gid, follow)))
	}

	fn sync(&mut self) -> FsPoll<()> {
		super::fs_ops::sync();
		FsPoll::Ready(Ok(()))
	}

	fn getxattr(&mut self, path: &BStr, name: &BStr, follow: bool) -> FsPoll<BString> {
		FsPoll::Ready(host_path(path).and_then(|p| super::fs_ops::getxattr(p, name, follow)))
	}

	fn setxattr(&mut self, path: &BStr, name: &BStr, value: &[u8], follow: bool) -> FsPoll<()> {
		FsPoll::Ready(host_path(path).and_then(|p| super::fs_ops::setxattr(p, name, value, follow)))
	}

	fn removexattr(&mut self, path: &BStr, name: &BStr, follow: bool) -> FsPoll<()> {
		FsPoll::Ready(host_path(path).and_then(|p| super::fs_ops::removexattr(p, name, follow)))
	}

	fn listxattr(&mut self, path: &BStr, follow: bool) -> FsPoll<Vec<BString>> {
		FsPoll::Ready(host_path(path).and_then(|p| super::fs_ops::listxattr(p, follow)))
	}

	fn user_db(
		&mut self,
		query: &crate::bash::fs::PwQuery,
	) -> FsPoll<Vec<crate::bash::fs::PwEntry>> {
		FsPoll::Ready(super::fs_ops::user_db(query))
	}
}

/// `fcntl(F_SETLK)` of a whole-file lock on descriptor `file`
/// ([`Fs::lock_fd`]): `WouldBlock` on contention.
#[cfg(unix)]
fn lock_fd(file: OsHandle, lock: crate::bash::fs::FdLock) -> io::Result<()> {
	use crate::bash::fs::FdLock;
	let fd = libc::c_int::try_from(file.0).map_err(|_| io::Error::from_raw_os_error(libc::EBADF))?;
	// SAFETY: `flock` is plain data; all-zero is a valid value.
	let mut lck: libc::flock = unsafe { std::mem::zeroed() };
	lck.l_type = (match lock {
		FdLock::Shared => libc::F_RDLCK,
		FdLock::Exclusive => libc::F_WRLCK,
		FdLock::Unlock => libc::F_UNLCK,
	}) as _;
	lck.l_whence = libc::SEEK_SET as _;
	loop {
		// SAFETY: `fcntl` on a caller-supplied descriptor with a valid
		// `flock`; a stale descriptor fails with `EBADF`.
		if unsafe { libc::fcntl(fd, libc::F_SETLK, &lck) } != -1 {
			return Ok(());
		}
		let err = io::Error::last_os_error();
		match err.raw_os_error() {
			Some(libc::EINTR) => {},
			Some(libc::EAGAIN | libc::EACCES) => return Err(io::ErrorKind::WouldBlock.into()),
			_ => return Err(err),
		}
	}
}

/// Record locks on descriptors need `fcntl` ([`Fs::lock_fd`]).
#[cfg(not(unix))]
fn lock_fd(_file: OsHandle, _lock: crate::bash::fs::FdLock) -> io::Result<()> {
	Err(io::ErrorKind::Unsupported.into())
}

/// [`Fs::lock`]: open `path` read-write and take a non-waiting `F_WRLCK`
/// record lock on the whole file.
fn lock_file(path: &BStr) -> io::Result<Box<dyn File>> {
	let file = OpenOptions::new()
		.read(true)
		.write(true)
		.open(host_path(path)?)?;
	#[cfg(unix)]
	{
		use std::os::fd::AsRawFd;
		// SAFETY: `flock` is plain data; all-zero is a valid value.
		let mut lck: libc::flock = unsafe { std::mem::zeroed() };
		lck.l_type = libc::F_WRLCK as _;
		lck.l_whence = libc::SEEK_SET as _;
		// SAFETY: a valid open descriptor and a valid `flock`.
		if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETLK, &lck) } == -1 {
			let err = io::Error::last_os_error();
			return Err(match err.raw_os_error() {
				Some(libc::EAGAIN | libc::EACCES) => io::ErrorKind::WouldBlock.into(),
				_ => err,
			});
		}
	}
	#[cfg(not(unix))]
	file.try_lock().map_err(|e| match e {
		fs::TryLockError::WouldBlock => io::Error::from(io::ErrorKind::WouldBlock),
		fs::TryLockError::Error(e) => e,
	})?;
	Ok(Box::new(StdFile::new(file)))
}




