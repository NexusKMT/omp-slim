//! A persistent engine shell driven per command.
//!
//! **Threading.** The engine is step-driven and synchronous: [`Shell::step`]
//! runs a budget of work and returns, and everything it waits on (pipes,
//! externals, pending filesystem operations, timers) wakes a waker. A
//! [`Session`] gives the shell, its [`MemStore`] and its [`PiHost`] to one
//! task (the *driver*) on [`SessionConfig::runtime`], which steps the shell
//! and, while every virtual process waits, suspends on the engine's waker, a
//! wake bell (requests, cancellation, tool completion) and the next tool
//! deadline. Nothing blocks a thread: a current-thread runtime drives the
//! driver, the provider futures of a `pi_vfs`-backed [`Fs`], external
//! spawning and output pumps together, and a step that exhausts its budget
//! yields to the runtime. The async side ([`Session::run`]) only sends jobs
//! over a channel and awaits the reply. Between commands the driver keeps
//! stepping background work (`cmd &` in-engine jobs, reaping background
//! externals).
//! **State.** Variables, functions, aliases, options, traps and the working
//! directory live in the store and the root virtual process; every command
//! runs on the root ([`VprocSel::Root`]), so they persist across commands.
//! An `EXIT` trap is consumed when it fires at a run boundary; other traps
//! remain installed.
//! Each command starts with its own standard streams, even if an earlier
//! command redirected them with `exec`. Higher-numbered descriptors persist;
//! duplicates of standard streams follow the current command's streams.
//!
//! **Forks.** Between engine calls the store holds the whole root state, so
//! the driver publishes a copy of it at each command boundary
//! ([`Session::latest_image`]); [`Session::restore`] starts a second session
//! from that copy while the first one keeps running its command.
//!
//! **`exit`.** A root run is a `bash -c` script: `exit N` (or `set -e`)
//! unwinds the run with status `N`, runs the `EXIT` trap at the run boundary,
//! and the shell stays usable for the next command with its state intact
//! (pi's `exit_and_errexit_keep_session_state`). The engine does this
//! itself; the session only reports the status.
//!
//! **Cancellation.** A cancelled run is stopped through the engine's
//! [`ControlHandle::cancel`](crate::bash::ControlHandle::cancel): first `TERM`
//! (signal traps run, externals get `TERM`, status 143), then, if the run
//! has not ended after [`TERM_GRACE`], `KILL` (no traps, status 137).
//! Unwinding drops the externals the run waits for; the spawner sends their
//! process groups `TERM` and `KILL` after [`TERM_GRACE`] in the background.
//! The cancel request reaches the engine only from the driver, while the run
//! it targets is still in flight, so a late cancel never leaks into the next
//! command. What `nohup` started ([`crate::tools`]) is detached: neither a
//! cancel nor closing the session ends it.
//!
//! **Subshell jobs.** Unlike bash, a subshell's background jobs that run
//! in-engine work (builtins, loops) end when the subshell exits
//! ([`EngineConfig::end_orphan_jobs`]): no process stands for them, so
//! nothing could reach them afterwards. A job that is just an external runs
//! on as its own process, as in bash.
//!
//! **Tools.** `timeout`, `nohup` and (with `PI_SMART_GIT`/`PI_GIT_GUARD`)
//! `git` are host callouts: the driver hands them to its
//! [`ToolCalls`](crate::tools::ToolCalls), routes the `Done` of their
//! subshells there, polls them every turn, and parks no longer than their
//! next deadline.

use std::{
	future::poll_fn,
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicU8, Ordering},
	},
	task::{Wake, Waker},
	time::Duration,
};

use bstr::{BString, ByteSlice};
use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;

use crate::{
	bash::{
		Budget, CallId, Cx, Engine, EngineConfig, EventMask, EventSink, Fs, MemStore, PipeTap,
		Profile, RestoreError, RestoreOpts, RunId, Script, Shell, ShellError, ShellInit, Signal,
		Step, ToolCall, VprocSel,
		store::{Key, MiscKey, Record},
	},
	host::{PiHost, SpawnObserver, TERM_GRACE},
	sys::OutputDecoding,
	tools::{ToolCalls, ToolConfig},
	vfs::VfsFs,
};

/// How long a run may take to end after the `KILL` cancel before the session
/// gives up on it ([`SessionError::Unresponsive`]).
const KILL_WAIT: Duration = Duration::from_secs(5);

/// Most default-budget steps of background work a command's end waits for
/// ([`Driver::settle`]): about 8 ms.
const SETTLE_STEPS: u32 = 4;

/// Longest suspension of the driver: every wake it waits for is delivered by
/// a waker, so this only bounds the cost of a lost one.
const MAX_PARK: Duration = Duration::from_secs(1);

/// Configuration of a new [`Session`].
pub struct SessionConfig {
	/// The shell's initial environment, all exported (no inheritance from
	/// the pi process beyond what is listed).
	pub env:             Vec<(BString, BString)>,
	/// Initial working directory (absolute).
	pub cwd:             BString,
	/// The filesystem: `crate::vfs::VfsFs`, or `crate::sys::StdFs`.
	pub fs:              Box<dyn Fs + Send>,
	/// The pi-vfs filesystem slot behind [`SessionConfig::fs`] (a clone of
	/// the same [`VfsFs`]), when there is one: pi's utilities and in-process
	/// `git worktree add` ([`crate::tools`]) work on the filesystem it holds
	/// when they run, and externals get the host files its URLs alias
	/// ([`PiHost::spawn`](crate::bash::Host::spawn)). `None`: every path is
	/// native.
	pub vfs:             Option<VfsFs>,
	/// Runtime the host's timers (`read -t`, `TMOUT`) sleep on.
	pub runtime:         tokio::runtime::Handle,
	/// Decodes what externals write into a text capture
	/// ([`RunOptions::text_capture`]); `None` is the platform default
	/// ([`crate::output_decode::external_output_decoding`]).
	pub output_decoding: Option<Arc<dyn OutputDecoding>>,
}

/// One command of a [`Session`].
#[derive(Clone, Default)]
pub struct RunOptions {
	/// The command string (`bash -c` semantics).
	pub command:        String,
	/// Variables exported to this command only (pi's per-run env). They are
	/// visible to everything the command runs; afterwards each named
	/// variable is back to what it was before, whatever the command did to
	/// it.
	pub env:            Vec<(BString, BString)>,
	/// Working directory to change to before the command (absolute, or a
	/// `scheme://` URL path the filesystem serves); like `cd`, it persists.
	pub cwd:            Option<BString>,
	/// Gets a copy of the bytes crossing the pipes of the command's pipelines
	/// ([`crate::bash::Host::pipe_tap`]); pipelines it leaves running in the
	/// background stay tapped.
	pub pipe_tap:       Option<Arc<dyn PipeTap>>,
	/// Set when a utility reports an error its exit status hides (`jq`
	/// after a failing input that is not the last).
	pub reported_error: Option<Arc<AtomicBool>>,
	/// The command's stdout and stderr are one pipe whose reader takes its
	/// bytes as shell text: what externals write there is decoded per
	/// program by the host's output decoding
	/// ([`PiHost::set_output_decoding`](crate::host::PiHost::set_output_decoding)),
	/// through one relay for both streams. Pipeline pipes and files are
	/// never decoded.
	pub text_capture:   bool,
	/// Observes the engine events of this command (a
	/// [`RunTrace`](crate::bash::trace::RunTrace)); the shell's event mask
	/// is the sink's while the command runs and `NONE` otherwise. Each
	/// observer receives units lazily, including persistent function bodies
	/// only when this command executes them.
	pub events:         Option<Arc<dyn EventSink>>,
}

impl RunOptions {
	/// Run `command` with no env overlay in the current directory.
	pub fn new(command: impl Into<String>) -> Self {
		Self {
			command:        command.into(),
			env:            Vec::new(),
			cwd:            None,
			pipe_tap:       None,
			reported_error: None,
			text_capture:   false,
			events:         None,
		}
	}
}

impl std::fmt::Debug for RunOptions {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("RunOptions")
			.field("command", &self.command)
			.field("env", &self.env)
			.field("cwd", &self.cwd)
			.field("pipe_tap", &self.pipe_tap.is_some())
			.field("reported_error", &self.reported_error)
			.field("events", &self.events.is_some())
			.finish()
	}
}

/// The standard streams of one command, as OS handles.
///
/// `None` behaves like `/dev/null`. The session closes its copies when the
/// command ends, so a reader of a pipe passed here sees end of file once the
/// command (and any external still holding the pipe) is done.
#[derive(Debug, Default)]
pub struct RunStdio {
	/// fd 0.
	pub stdin:  Option<std::fs::File>,
	/// fd 1.
	pub stdout: Option<std::fs::File>,
	/// fd 2.
	pub stderr: Option<std::fs::File>,
}

/// How a command ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunOutcome {
	/// Exit status, bash semantics (127 not found, 128 + n for a signal).
	pub status:    i32,
	/// The run was stopped by its cancellation token.
	pub cancelled: bool,
	/// `exit` or `set -e` ended the command (rather than its end): a caller
	/// running one command as several runs stops here, as bash would have.
	pub exited:    bool,
	/// The shell's working directory after the command.
	pub cwd:       BString,
}

/// Failure of a [`Session`] call.
#[derive(Debug, thiserror::Error)]
pub enum SessionError {
	/// The engine refused the initial state.
	#[error("could not create the shell")]
	Create(#[source] ShellError),
	/// The engine refused the [`Image`] of [`Session::restore`].
	#[error("could not restore the shell")]
	Restore(#[source] RestoreError),
	/// The driver task is gone (it panicked, or its runtime shut down), or
	/// an earlier run became
	/// [`SessionError::Unresponsive`].
	#[error("the shell session is closed")]
	Closed,
	/// A cancelled run did not end even after the `KILL` cancel; the session
	/// is closed.
	#[error("the shell did not stop after cancellation")]
	Unresponsive,
	/// [`RunOptions::cwd`] is not absolute.
	#[error("working directory {0} is not absolute")]
	RelativeCwd(BString),
}

/// The live externals of the run in flight (pi's `Shell::pids()`). Cheap to
/// clone; clones share the list.
#[derive(Clone, Default)]
pub struct Children(Arc<ChildrenState>);

#[derive(Default)]
struct ChildrenState {
	/// A run is in flight.
	active: AtomicBool,
	/// Live pids in spawn order.
	pids:   Mutex<Vec<u32>>,
}

impl Children {
	/// Pids of the live externals spawned by the run in flight, in spawn
	/// order; empty while no run is in flight.
	pub fn pids(&self) -> Vec<i32> {
		if !self.0.active.load(Ordering::Acquire) {
			return Vec::new();
		}
		self
			.0
			.pids
			.lock()
			.iter()
			.filter_map(|&pid| i32::try_from(pid).ok())
			.collect()
	}

	fn set_active(&self, active: bool) {
		self.0.active.store(active, Ordering::Release);
	}
}

impl SpawnObserver for Children {
	fn spawned(&self, pid: u32) {
		self.0.pids.lock().push(pid);
	}

	fn released(&self, pid: u32) {
		let mut pids = self.0.pids.lock();
		if let Some(i) = pids.iter().position(|&p| p == pid) {
			pids.remove(i);
		}
	}
}

/// The root state of a [`Session`] between two commands.
///
/// Variables, functions, aliases, options, traps, the working directory and
/// the job table; [`Session::restore`] starts a new session from it. Cheap to
/// clone; clones share the state.
#[derive(Clone)]
pub struct Image(Arc<MemStore>);

impl Image {
	/// The shell's working directory in this state.
	pub fn cwd(&self) -> BString {
		store_cwd(&self.0)
	}
}

/// The [`Image`] a [`Session`] published at its last command boundary.
///
/// Boundaries are its creation and the end of each command. Readable while a
/// command runs: pi forks a busy session from it. Cheap to clone; clones share
/// the slot.
#[derive(Clone)]
pub struct LatestImage(Arc<Mutex<Image>>);

impl LatestImage {
	/// The state as of the last command boundary: while a command runs, the
	/// state it started from.
	pub fn get(&self) -> Image {
		self.0.lock().clone()
	}

	fn new(store: &MemStore) -> Self {
		Self(Arc::new(Mutex::new(Image(Arc::new(store.clone())))))
	}

	fn publish(&self, store: &MemStore) {
		*self.0.lock() = Image(Arc::new(store.clone()));
	}
}

/// The shell's working directory as `store` records it.
fn store_cwd(store: &MemStore) -> BString {
	match store.record(Key::Misc(MiscKey::Cwd)) {
		Some(Record::Misc(cwd)) => cwd.clone(),
		_ => BString::default(),
	}
}

/// The wake bell of a driver task: its waker (handed to worker threads and
/// held by the [`Session`]) stores a permit the driver awaits; it never
/// blocks.
#[derive(Default)]
struct Bell(tokio::sync::Notify);

impl Wake for Bell {
	fn wake(self: Arc<Self>) {
		self.0.notify_one();
	}

	fn wake_by_ref(self: &Arc<Self>) {
		self.0.notify_one();
	}
}

/// A persistent shell: commands run one at a time on a driver task of the
/// session's runtime (see the module docs), and state persists between them.
pub struct Session {
	/// Requests for the driver; `None` once the session is closed.
	jobs:     Option<flume::Sender<Request>>,
	/// Rings the driver's bell.
	waker:    Waker,
	children: Children,
	image:    LatestImage,
}

impl Session {
	/// Start a shell with `config`'s environment and working directory.
	///
	/// The shell is created here (no I/O) and its driver task is spawned on
	/// [`SessionConfig::runtime`], which must keep running for the session
	/// to answer.
	///
	/// # Errors
	///
	/// [`SessionError::Create`] when the engine refuses the initial state.
	pub fn new(config: SessionConfig) -> Result<Self, SessionError> {
		Self::start(config, None)
	}

	/// Start a shell from `image` (a fork of the session it came from): its
	/// variables, functions, options and working directory are the image's,
	/// so [`SessionConfig::env`] only configures pi's commands and
	/// [`SessionConfig::cwd`] is unused. Background jobs the image lists as
	/// running belong to the source session; here they are done (status
	/// 137). `$RANDOM` is reseeded.
	///
	/// # Errors
	///
	/// [`SessionError::Restore`] when the engine refuses the image.
	pub fn restore(config: SessionConfig, image: &Image) -> Result<Self, SessionError> {
		Self::start(config, Some(image))
	}

	fn start(config: SessionConfig, image: Option<&Image>) -> Result<Self, SessionError> {
		let SessionConfig { env, cwd, fs, vfs, runtime, output_decoding } = config;
		let (jobs, rx) = flume::unbounded();
		let children = Children::default();
		let bell = Arc::new(Bell::default());
		let waker = Waker::from(Arc::clone(&bell));
		let tools = ToolConfig::from_env(&env, vfs.clone(), runtime.clone());
		let mut host = PiHost::new(fs, runtime.clone());
		if output_decoding.is_some() {
			host.set_output_decoding(output_decoding);
		}
		host.set_spawn_observer(Arc::new(children.clone()));
		host.set_vfs(vfs);
		host.set_tools(tools.clone());
		let tools = ToolCalls::new(tools, host.spawn_log(), waker.clone());
		// A subshell's background in-engine work ends with it: nothing
		// (no process for `pkill`, no job for `kill %N`) could reach it.
		let engine = Engine::new(EngineConfig { end_orphan_jobs: true, ..EngineConfig::default() });
		let (mut shell, store) = match image {
			None => {
				let mut store = MemStore::new();
				// A program's shell: no history, line editor or completion system.
				let init = ShellInit { env, cwd, profile: Profile::Tool, ..ShellInit::default() };
				let shell =
					Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, init)
						.map_err(SessionError::Create)?;
				(shell, store)
			},
			Some(image) => {
				let mut store = MemStore::clone(&image.0);
				let opts = RestoreOpts { reseed_random: true, ..RestoreOpts::default() };
				let (shell, _) =
					Shell::restore(&engine, &mut Cx { host: &mut host, store: &mut store }, opts)
						.map_err(SessionError::Restore)?;
				(shell, store)
			},
		};
		// Nothing observes events: skip building them.
		shell.set_event_mask(EventMask::NONE);
		let image = LatestImage::new(&store);
		let driver = Driver {
			shell,
			store,
			host,
			bell,
			jobs: rx,
			children: children.clone(),
			tools,
			image: image.clone(),
		};
		runtime.spawn(driver.serve());
		Ok(Self { jobs: Some(jobs), waker, children, image })
	}

	/// The session's state as of its last command boundary; see
	/// [`LatestImage`].
	pub fn latest_image(&self) -> LatestImage {
		self.image.clone()
	}

	/// The live externals of the run in flight; usable while
	/// [`Session::run`] borrows the session.
	pub fn children(&self) -> Children {
		self.children.clone()
	}

	/// Number of background jobs (`cmd &`) still running an external
	/// process ([`Shell::live_external_jobs`]); jobs of in-engine work only
	/// are not counted. Exited externals are reaped between commands, so
	/// a later `wait` still reports their status.
	///
	/// # Errors
	///
	/// [`SessionError::Closed`] when the session is closed.
	pub async fn live_external_jobs(&self) -> Result<usize, SessionError> {
		let jobs = self.jobs.as_ref().ok_or(SessionError::Closed)?;
		let (reply_tx, reply_rx) = flume::bounded(1);
		jobs
			.send(Request::LiveJobs(reply_tx))
			.map_err(|_| SessionError::Closed)?;
		self.waker.wake_by_ref();
		reply_rx
			.recv_async()
			.await
			.map_err(|_| SessionError::Closed)
	}

	/// Run `command` with `stdio`; see [`Session::run_with`].
	///
	/// # Errors
	///
	/// See [`Session::run_with`].
	pub async fn run(
		&mut self,
		command: &str,
		stdio: RunStdio,
		cancel: CancellationToken,
	) -> Result<RunOutcome, SessionError> {
		self.run_with(RunOptions::new(command), stdio, cancel).await
	}

	/// Run one command to completion and report how it ended.
	///
	/// When `cancel` fires the run is stopped (`TERM`, then `KILL` after
	/// [`TERM_GRACE`]) and the outcome says `cancelled`. Dropping the future
	/// stops the run with `KILL`. A non-zero status (`exit 3`, `set -e`,
	/// `nosuchcmd`) is an outcome, not an error: the session stays usable.
	///
	/// # Errors
	///
	/// [`SessionError::RelativeCwd`] for a relative [`RunOptions::cwd`];
	/// [`SessionError::Closed`] when the session is closed;
	/// [`SessionError::Unresponsive`] (closing the session) when a cancelled
	/// run does not end.
	pub async fn run_with(
		&mut self,
		options: RunOptions,
		stdio: RunStdio,
		cancel: CancellationToken,
	) -> Result<RunOutcome, SessionError> {
		if let Some(cwd) = &options.cwd
			&& !is_absolute(cwd)
		{
			return Err(SessionError::RelativeCwd(cwd.clone()));
		}
		let jobs = self.jobs.as_ref().ok_or(SessionError::Closed)?;
		let level = Arc::new(CancelLevel::default());
		let (reply_tx, reply_rx) = flume::bounded(1);
		let job = Job { options, stdio, cancel: Arc::clone(&level), reply: reply_tx };
		jobs
			.send(Request::Run(job))
			.map_err(|_| SessionError::Closed)?;
		self.waker.wake_by_ref();
		let mut guard = CancelOnDrop { level: &level, waker: &self.waker, armed: true };
		let reply = reply_rx.recv_async();
		tokio::pin!(reply);
		let outcome = tokio::select! {
			r = &mut reply => Some(r),
			() = cancel.cancelled() => None,
		};
		let outcome = if let Some(r) = outcome {
			Some(r)
		} else {
			guard.raise(CancelLevel::TERM);
			if let Ok(r) = tokio::time::timeout(TERM_GRACE, &mut reply).await {
				Some(r)
			} else {
				guard.raise(CancelLevel::KILL);
				tokio::time::timeout(KILL_WAIT, &mut reply).await.ok()
			}
		};
		guard.armed = false;
		drop(guard);
		match outcome {
			Some(Ok(outcome)) => Ok(outcome),
			Some(Err(_)) => {
				self.close();
				Err(SessionError::Closed)
			},
			None => {
				self.close();
				Err(SessionError::Unresponsive)
			},
		}
	}

	/// Stop accepting jobs and let the driver task end (it drops the
	/// shell; externals still running are terminated by the spawner).
	fn close(&mut self) {
		if self.jobs.take().is_some() {
			self.waker.wake_by_ref();
		}
	}
}

impl Drop for Session {
	fn drop(&mut self) {
		self.close();
	}
}

/// Whether `path` is absolute for the engine (a Windows drive path, or a
/// `scheme://` URL path, too).
fn is_absolute(path: &[u8]) -> bool {
	path.first() == Some(&b'/')
		|| (cfg!(windows)
			&& path.get(1) == Some(&b':')
			&& path.first().is_some_and(u8::is_ascii_alphabetic))
		|| path.to_path().is_ok_and(pi_vfs::is_virtual_path)
}

/// Cancellation requested for one run: none, `TERM` or `KILL`.
#[derive(Default)]
struct CancelLevel(AtomicU8);

impl CancelLevel {
	const KILL: u8 = 2;
	const TERM: u8 = 1;

	fn get(&self) -> u8 {
		self.0.load(Ordering::Acquire)
	}
}

/// Escalates the run's cancel level and wakes the driver; stops the run with
/// `KILL` when the run future is dropped before the reply.
struct CancelOnDrop<'a> {
	level: &'a CancelLevel,
	waker: &'a Waker,
	armed: bool,
}

impl CancelOnDrop<'_> {
	fn raise(&self, level: u8) {
		self.level.0.fetch_max(level, Ordering::AcqRel);
		self.waker.wake_by_ref();
	}
}

impl Drop for CancelOnDrop<'_> {
	fn drop(&mut self) {
		if self.armed {
			self.raise(CancelLevel::KILL);
		}
	}
}

/// What the driver is asked to do.
enum Request {
	/// Run a command.
	Run(Job),
	/// Count the background jobs running an external.
	LiveJobs(flume::Sender<usize>),
}

/// One command for the driver.
struct Job {
	options: RunOptions,
	stdio:   RunStdio,
	cancel:  Arc<CancelLevel>,
	reply:   flume::Sender<RunOutcome>,
}

/// The driver task's state: the shell and everything it is stepped with.
struct Driver {
	shell:    Shell,
	store:    MemStore,
	host:     PiHost,
	bell:     Arc<Bell>,
	jobs:     flume::Receiver<Request>,
	children: Children,
	/// The host callouts in flight (`timeout`, `nohup`, `git`).
	tools:    ToolCalls,
	/// Updated at the end of each command.
	image:    LatestImage,
}

impl Driver {
	/// Run jobs until the session is closed; step background work between
	/// them.
	async fn serve(mut self) {
		loop {
			match self.jobs.try_recv() {
				Ok(Request::Run(job)) => self.run(job).await,
				Ok(Request::LiveJobs(reply)) => {
					let _ = reply.send(self.shell.live_external_jobs());
				},
				Err(flume::TryRecvError::Disconnected) => break,
				Err(flume::TryRecvError::Empty) => self.idle_turn().await,
			}
		}
	}

	/// One step of background work while no command runs, or a suspension
	/// when there is none to do (a new job's ring ends it).
	async fn idle_turn(&mut self) {
		self.poll_tools();
		match self.step(Budget::default()) {
			Step::Done { run, status } => self.on_done(run, status),
			Step::Call { id, call } => self.on_call(id, call),
			Step::Yield => tokio::task::yield_now().await,
			Step::Blocked | Step::Paused => self.wait().await,
			Step::Idle => self.idle().await,
			Step::SuspendReady => {},
		}
	}

	/// Run one job to completion and send its outcome.
	async fn run(&mut self, job: Job) {
		let Job { options, stdio, cancel, reply } = job;
		let RunOptions { command, env, cwd, pipe_tap, reported_error, text_capture, events } =
			options;
		self.host.set_pipe_tap(pipe_tap);
		// A command owns its observer generation, even when successive
		// observers request identical event masks.
		self
			.shell
			.set_event_mask(events.as_ref().map_or(EventMask::NONE, |sink| sink.mask()));
		self.host.set_reported_error(reported_error);
		// The values the overlay hides, restored after the run.
		let saved: Vec<(BString, Option<Record>)> = env
			.iter()
			.map(|(name, _)| (name.clone(), self.store.record(Key::Var(name.as_bstr())).cloned()))
			.collect();
		// Submission only queues the script. Bind its exact identity before
		// any scheduler turn can announce an older background tool child.
		let run = self.shell.submit(Script {
			cwd,
			env,
			vproc: VprocSel::Root,
			..Script::command(command.as_bytes())
		});
		if let Some(sink) = &events {
			sink.run_submitted(run);
		}
		self.host.set_event_sink(events);
		self
			.host
			.streams()
			.install([stdio.stdin, stdio.stdout, stdio.stderr], text_capture);
		self.shell.reset_root_stdio(&mut self.host);
		self.children.set_active(true);
		let mut applied = 0;
		let status = loop {
			let wanted = cancel.get();
			if wanted > applied {
				applied = wanted;
				let sig = if wanted >= CancelLevel::KILL {
					Signal::Kill
				} else {
					Signal::Term
				};
				self.shell.control().cancel(sig);
			}
			self.poll_tools();
			match self.step(Budget::default()) {
				Step::Done { run: done, status } if done == run => break status,
				Step::Done { run, status } => self.on_done(run, status),
				Step::Call { id, call } => self.on_call(id, call),
				Step::Yield => tokio::task::yield_now().await,
				Step::Blocked | Step::Paused => self.wait().await,
				Step::SuspendReady => {},
				// Unreachable while the run is queued (its `Done` is reported
				// before `Idle`); end the run rather than spin.
				Step::Idle => break 1,
			}
		};
		if applied > 0 {
			// A cancel that raced the run's natural end is still pending:
			// apply it now (it ends background work too, as pi's cancel
			// does), not at the start of the next command.
			match self.step(Budget { max_ops: 1, max_ns: u64::MAX }) {
				Step::Done { run, status } => self.on_done(run, status),
				Step::Call { id, call } => self.on_call(id, call),
				_ => {},
			}
		}
		let exited = self.shell.ended_by_exit(run);
		self.settle().await;
		self.children.set_active(false);
		self.host.streams().clear();
		self.host.set_pipe_tap(None);
		self.host.set_event_sink(None);
		self.shell.set_event_mask(EventMask::NONE);
		self.host.set_reported_error(None);
		self.restore_overlay(saved);
		self.image.publish(&self.store);
		let cwd = store_cwd(&self.store);
		// The caller may have stopped waiting (dropped future).
		let _ = reply.send(RunOutcome { status, cancelled: applied > 0, exited, cwd });
	}

	/// Let the background work a command started reach its first wait (an
	/// external spawned, a pipe read) before the command reports, so the
	/// caller's next look at the session (`live_external_jobs`) sees what the
	/// command left running. Bounded: a busy background loop never waits.
	async fn settle(&mut self) {
		for _ in 0..SETTLE_STEPS {
			self.poll_tools();
			match self.step(Budget::default()) {
				Step::Done { run, status } => self.on_done(run, status),
				Step::Call { id, call } => self.on_call(id, call),
				Step::Yield => tokio::task::yield_now().await,
				Step::SuspendReady => {},
				Step::Blocked | Step::Paused | Step::Idle => break,
			}
		}
	}

	/// Put back the variables a run's env overlay replaced, newest first so
	/// a name given twice ends at its original value.
	fn restore_overlay(&mut self, saved: Vec<(BString, Option<Record>)>) {
		for (name, record) in saved.into_iter().rev() {
			let key = Key::Var(name.as_bstr());
			match record {
				// A variable record always fits a variable key.
				Some(record) => drop(self.store.put_out_of_band(key, record)),
				None => self.store.del_out_of_band(key),
			}
		}
	}

	/// A script other than the current command finished: a subshell of a
	/// host callout ([`ToolCalls::on_done`]); nothing else submits scripts.
	fn on_done(&mut self, run: RunId, status: i32) {
		let signal = self.shell.exec_signal(run);
		self.tools.on_done(run, status, signal);
	}

	/// Start a host callout ([`crate::bash::Resolved::Tool`]).
	fn on_call(&mut self, id: CallId, call: ToolCall) {
		let mut cx = Cx { host: &mut self.host, store: &mut self.store };
		self.tools.on_call(&mut self.shell, &mut cx, id, call);
	}

	/// Let the host callouts in flight make progress (answering the calls
	/// that finished).
	fn poll_tools(&mut self) {
		let mut cx = Cx { host: &mut self.host, store: &mut self.store };
		self.tools.poll(&mut self.shell, &mut cx);
	}

	fn step(&mut self, budget: Budget) -> Step {
		self
			.shell
			.step(&mut Cx { host: &mut self.host, store: &mut self.store }, budget)
	}

	/// Suspend until the shell may make progress, a job or cancel request
	/// rings the bell, or a host callout's deadline comes.
	///
	/// The future owns what it waits on, so it does not hold the driver.
	fn wait(&self) -> impl Future<Output = ()> + Send + use<> {
		let ctl = self.shell.control();
		let bell = Arc::clone(&self.bell);
		let now = crate::bash::Host::now_ns(&self.host);
		let limit = self
			.tools
			.next_deadline()
			.map_or(MAX_PARK, |at| Duration::from_nanos(at.saturating_sub(now)).min(MAX_PARK));
		async move {
			tokio::select! {
				biased;
				() = poll_fn(|cx| ctl.poll_runnable(cx)) => {},
				() = bell.0.notified() => {},
				() = tokio::time::sleep(limit) => {},
			}
		}
	}

	/// Suspend while there is nothing to run: until a job, a tool worker
	/// or the loss-bound timeout rings.
	fn idle(&self) -> impl Future<Output = ()> + Send + use<> {
		let bell = Arc::clone(&self.bell);
		async move {
			tokio::select! {
				biased;
				() = bell.0.notified() => {},
				() = tokio::time::sleep(MAX_PARK) => {},
			}
		}
	}
}


