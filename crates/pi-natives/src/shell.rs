//! Embedded bash engine (pi-shell) shell execution exported via N-API.

pub mod vfs;

use std::{
	collections::HashMap,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	time::Duration,
};

use napi::{
	Env, Result,
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, UnknownReturnValue},
};
use napi_derive::napi;
use pi_shell::{
	MinimizerResult as CoreMinimizerResult, PipeTaps, Shell as CoreShell,
	ShellExecuteOptions as CoreShellExecuteOptions, ShellOptions as CoreShellOptions,
	ShellRunOptions as CoreShellRunOptions, ShellRunResult as CoreShellRunResult,
	bash::trace::viz::{self, model},
	execute_shell as core_execute_shell, minimizer,
};

use self::vfs::ShellFilesystem;
use crate::task;

/// Native non-executing visualization transformations.
#[napi(object)]
pub struct ShellVizLayers {
	pub color:   bool,
	pub inline:  bool,
	pub idioms:  bool,
	pub effects: bool,
	pub unwrap:  bool,
}

/// Native presentation controls. Node identities are opaque engine keys.
#[napi(object)]
pub struct ShellVizOptions {
	#[napi(ts_type = "'raw' | 'pseudo'")]
	pub view:           String,
	pub layers:         ShellVizLayers,
	pub split:          bool,
	pub cursor:         Option<u32>,
	pub cursor_seq:     Option<f64>,
	pub playing:        bool,
	pub speed:          f64,
	pub selected_node:  Option<String>,
	pub expanded_nodes: Vec<String>,
}

impl TryFrom<ShellVizOptions> for model::Options {
	type Error = Error;

	fn try_from(value: ShellVizOptions) -> Result<Self> {
		let view = match value.view.as_str() {
			"raw" => model::View::Raw,
			"pseudo" => model::View::Pseudo,
			_ => return Err(Error::from_reason("view must be raw or pseudo")),
		};
		let node = |value: String| value.parse::<model::NodeKey>().map_err(Error::from_reason);
		let cursor_seq = value
			.cursor_seq
			.map(|seq| {
				if seq.is_finite() && seq >= 0.0 && seq.fract() == 0.0 && seq <= 9_007_199_254_740_991.0
				{
					Ok(seq as u64)
				} else {
					Err(Error::from_reason("cursorSeq must be a nonnegative safe integer"))
				}
			})
			.transpose()?;
		Ok(Self {
			view,
			layers: model::Layers {
				color:   value.layers.color,
				inline:  value.layers.inline,
				idioms:  value.layers.idioms,
				effects: value.layers.effects,
				unwrap:  value.layers.unwrap,
			},
			split: value.split,
			cursor: value.cursor.map(|cursor| cursor as usize),
			cursor_seq,
			playing: value.playing,
			speed: value.speed,
			selected_node: value.selected_node.map(node).transpose()?,
			expanded_nodes: value
				.expanded_nodes
				.into_iter()
				.map(node)
				.collect::<Result<_>>()?,
		})
	}
}

/// Persisted native visualization, restored once rather than reparsed on each
/// frame.
#[napi]
pub struct ShellVisualization {
	inner: viz::StoredVisualization,
}

#[napi]
impl ShellVisualization {
	#[napi(constructor)]
	pub fn new(snapshot: String) -> Result<Self> {
		Ok(Self {
			inner: viz::StoredVisualization::from_snapshot_json(&snapshot)
				.map_err(|error| Error::from_reason(error.to_string()))?,
		})
	}

	#[napi]
	pub fn present(&self, options: ShellVizOptions) -> Result<String> {
		self
			.inner
			.presentation_json(&options.try_into()?)
			.map_err(|error| Error::from_reason(error.to_string()))
	}
}

/// Expand Windows 8.3 components without resolving symlinks or junctions.
#[napi]
#[allow(clippy::missing_const_for_fn, reason = "windows branch calls non-const path helpers")]
pub fn expand_windows_long_path(path: String) -> String {
	#[cfg(windows)]
	{
		pi_shell::expand_to_long_path(std::path::Path::new(&path))
			.into_string()
			.unwrap_or(path)
	}
	#[cfg(not(windows))]
	{
		path
	}
}

/// Get the existing Windows 8.3 spelling; preserve the input when unavailable.
#[napi]
#[allow(clippy::missing_const_for_fn, reason = "windows branch calls non-const path helpers")]
pub fn get_windows_short_path(path: String) -> String {
	#[cfg(windows)]
	{
		pi_shell::get_short_path(std::path::Path::new(&path))
			.into_string()
			.unwrap_or(path)
	}
	#[cfg(not(windows))]
	{
		path
	}
}

/// N-API opt-in handle for the minimizer.
#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct MinimizerOptions {
	/// Master switch. Absent / false = disabled.
	pub enabled:              Option<bool>,
	/// Optional path to a TOML settings file whose values override
	/// field-level defaults. `~` is expanded.
	pub settings_path:        Option<String>,
	/// Optional xxHash64 digest (hex) of the settings file contents. When
	/// supplied, the engine refuses to honor a settings file whose hash does
	/// not match — a lightweight trust gate for agent-controllable paths.
	pub settings_hash:        Option<String>,
	/// Opt-in allowlist of program names (e.g. `"git"`). When empty or
	/// absent, all built-in filters are active.
	pub only:                 Option<Vec<String>>,
	/// Program names explicitly excluded from minimization.
	pub except:               Option<Vec<String>>,
	/// Maximum captured bytes per command before the engine falls back to
	/// the raw, un-minimized output. Default 4 MiB.
	pub max_capture_bytes:    Option<u32>,
	/// Source-outline level for `cat <source-file>` minimization. Accepts
	/// `"default"` (current behavior) or `"aggressive"` (strip function bodies).
	pub source_outline_level: Option<String>,
	/// Kill-switch to fall back to the pre-PR (legacy) filter behavior for
	/// grep / find / pytest. When `Some(true)`, filters that opted into the
	/// always-shrink Tier 1 / Tier 2 behavior skip the new code path. When
	/// `None`, defers to the `OMP_MINIMIZER_LEGACY_FILTERS` env var.
	pub legacy_filters:       Option<bool>,
}

impl From<MinimizerOptions> for minimizer::MinimizerOptions {
	fn from(value: MinimizerOptions) -> Self {
		Self {
			enabled:              value.enabled,
			settings_path:        value.settings_path,
			settings_hash:        value.settings_hash,
			only:                 value.only,
			except:               value.except,
			max_capture_bytes:    value.max_capture_bytes,
			source_outline_level: value.source_outline_level,
			legacy_filters:       value.legacy_filters,
		}
	}
}

/// Options for configuring a persistent shell session.
#[napi(object, object_to_js = false)]
pub struct ShellOptions {
	/// Environment variables to apply once per session.
	pub session_env:   Option<HashMap<String, String>>,
	/// Optional snapshot file to source on session creation.
	pub snapshot_path: Option<String>,
	/// Optional per-command output minimizer configuration.
	pub minimizer:     Option<MinimizerOptions>,
	/// Filesystem backing every run of this session (native when absent).
	pub filesystem:    Option<ShellFilesystem>,
}

impl From<ShellOptions> for CoreShellOptions {
	fn from(value: ShellOptions) -> Self {
		Self {
			session_env:   value.session_env,
			snapshot_path: value.snapshot_path,
			minimizer:     value.minimizer.map(Into::into),
			filesystem:    value.filesystem.map_or_default(ShellFilesystem::into_fs),
		}
	}
}

/// Options for running a shell command.
#[napi(object, object_to_js = false)]
pub struct ShellRunOptions<'env> {
	/// Command string to execute in the shell.
	pub command:    String,
	/// Working directory for the command.
	pub cwd:        Option<String>,
	/// Environment variables to apply for this command only.
	pub env:        Option<HashMap<String, String>>,
	/// Timeout in milliseconds before cancelling the command.
	pub timeout_ms: Option<u32>,
	/// Abort signal for cancelling the operation.
	pub signal:     Option<Unknown<'env>>,
	/// Filesystem for this run only, replacing the session's; the session's
	/// filesystem applies again to later runs.
	pub filesystem: Option<ShellFilesystem>,
	/// Receives a copy of every byte crossing the run's pipeline pipes.
	pub streams:    Option<ClassInstance<'env, PipeStreams>>,
	/// Folds the run's engine events into a live model of the command.
	pub trace:      Option<ClassInstance<'env, RunTrace>>,
}

/// Actual command state, source units and bounded history for one shell run,
/// including observed assignments and producer-attributed output.
///
/// Create one over the command text and
/// pass it as [`ShellRunOptions::trace`]; poll [`RunTrace::version`] while the
/// run is in flight and take [`RunTrace::snapshot`] when it changed.
#[napi]
pub struct RunTrace {
	inner: Arc<pi_shell::bash::trace::RunTrace>,
}

#[napi]
impl RunTrace {
	/// A trace of `script`, the exact command text about to run.
	#[napi(constructor)]
	pub fn new(script: String) -> Self {
		Self { inner: Arc::new(pi_shell::bash::trace::RunTrace::new(script)) }
	}

	/// Revision of semantic events, assignments and visible output; unchanged
	/// means `snapshot()` is unchanged, even when adjacent output coalesces.
	#[napi]
	pub fn version(&self) -> f64 {
		self.inner.version() as f64
	}

	/// The `ShellTrace` JSON with byte-offset layout, current node states and
	/// ordered replay `history`. The newest 20,000 records retain at most
	/// 2 MiB visible output and 8 MiB payload; `historyTruncated` explicitly
	/// reports eviction. History timestamps are measured ns since `RunStart`;
	/// output identifies its real producer (`u`, `n`, `command`) when known.
	/// Semantic entries carry their actual `vpid`; `rootVpid` distinguishes
	/// root lifecycle from owned tool children even after journal trimming.
	/// A UTF-8 scalar spanning producers has exact byte `contributors`
	/// instead of an invented primary producer. Decoding ends at capture EOF.
	/// Segmented minimizer submissions share one epoch and final status;
	/// their history carries `segment`, with `logicalEnd`/`logicalStatus`
	/// finalizing the last actual root `RunEnd` after output draining.
	/// Serialization borrows the locked model rather than cloning its history.
	#[napi]
	pub fn snapshot(&self) -> String {
		self.inner.snapshot_json()
	}

	/// Render directly over the borrowed native state; no snapshot or syntax
	/// roundtrip.
	#[napi]
	pub fn present(&self, options: ShellVizOptions) -> Result<String> {
		self
			.inner
			.presentation_json(&options.try_into()?)
			.map_err(|error| Error::from_reason(error.to_string()))
	}
}

/// The bytes crossing one shell run's pipeline pipes, during and after the run.
///
/// For `cargo build 2>&1 | tail -5`, stream 1 holds what `cargo` has written
/// so far while `tail` still holds it back. Create one per run and pass it as
/// [`ShellRunOptions::streams`]. Streams are numbered from 1 in the order the
/// run opened its pipes; each keeps its most recent 1 MiB, and a run keeps its
/// 4 newest finished streams.
#[derive(Default)]
#[napi]
pub struct PipeStreams {
	taps: Arc<PipeTaps>,
}

/// A tapped pipe of a run.
#[napi(object)]
pub struct PipeStreamInfo {
	/// Stream number, from 1.
	pub id:       u32,
	/// Source text of the stage writing into the pipe.
	pub producer: String,
	/// Source text of the stage reading from it.
	pub consumer: String,
	/// Bytes written so far, including those no longer retained.
	pub total:    f64,
	/// Whether bytes may still arrive.
	pub open:     bool,
}

/// Retained bytes of a stream, as stream offsets `start..end`.
#[napi(object)]
pub struct PipeStreamChunk {
	/// Stream offset of `data`'s first byte; past 0 once older bytes were
	/// dropped.
	pub start: f64,
	/// Stream offset just past `data`: the next read's `from`.
	pub end:   f64,
	/// The bytes `start..end`.
	pub data:  Buffer,
	/// Whether bytes may still arrive.
	pub open:  bool,
}

#[napi]
impl PipeStreams {
	#[napi(constructor)]
	pub fn new() -> Self {
		Self::default()
	}

	/// The run's retained streams, oldest first.
	#[napi]
	pub fn list(&self) -> Vec<PipeStreamInfo> {
		self
			.taps
			.list()
			.into_iter()
			.map(|stream| PipeStreamInfo {
				id:       stream.id,
				producer: stream.producer,
				consumer: stream.consumer,
				total:    stream.total as f64,
				open:     stream.open,
			})
			.collect()
	}

	/// Retained bytes of stream `id` from stream offset `from` on (all of them
	/// without it), or `null` for a stream the run never opened or no longer
	/// keeps.
	#[napi]
	pub fn read(&self, id: u32, from: Option<f64>) -> Option<PipeStreamChunk> {
		let from = from.map(|from| from.max(0.0) as u64);
		self.taps.read(id, from).map(|read| PipeStreamChunk {
			start: read.start as f64,
			end:   read.end as f64,
			data:  read.data.into(),
			open:  read.open,
		})
	}
}

/// Options for executing a shell command via the embedded bash engine
/// (pi-shell).
#[napi(object, object_to_js = false)]
pub struct ShellExecuteOptions<'env> {
	/// Command string to execute in the shell.
	pub command:       String,
	/// Working directory for the command.
	pub cwd:           Option<String>,
	/// Environment variables to apply for this command only.
	pub env:           Option<HashMap<String, String>>,
	/// Environment variables to apply once per session.
	pub session_env:   Option<HashMap<String, String>>,
	/// Timeout in milliseconds before cancelling the command.
	pub timeout_ms:    Option<u32>,
	/// Optional snapshot file to source on session creation.
	pub snapshot_path: Option<String>,
	/// Optional per-command output minimizer configuration.
	pub minimizer:     Option<MinimizerOptions>,
	/// Abort signal for cancelling the operation.
	pub signal:        Option<Unknown<'env>>,
	/// Filesystem backing the command (native when absent).
	pub filesystem:    Option<ShellFilesystem>,
}

/// Telemetry for a single minimization.
///
/// Surfaced when the minimizer actually rewrote the command's output. The
/// session layer is expected to persist `original_text` via its
/// `ArtifactManager`, splice the resulting `artifact://<id>` reference
/// into `text`, and replace any previously streamed raw output with the
/// minimized text.
#[napi(object)]
pub struct MinimizerResult {
	/// Dispatch label produced by the minimizer (e.g. `"git"`,
	/// `"pipeline:gradle"`, `"pipeline+builtin"`).
	pub filter:        String,
	/// The minimized replacement text. Callers that streamed raw chunks
	/// during execution should clear and replace their accumulated output
	/// with this text.
	pub text:          String,
	/// The full original capture, before minimization.
	pub original_text: String,
	/// Captured byte length before minimization.
	pub input_bytes:   u32,
	/// Byte length of the minimized text the consumer received.
	pub output_bytes:  u32,
}

impl From<CoreMinimizerResult> for MinimizerResult {
	fn from(value: CoreMinimizerResult) -> Self {
		Self {
			filter:        value.filter,
			text:          value.text,
			original_text: value.original_text,
			input_bytes:   value.input_bytes,
			output_bytes:  value.output_bytes,
		}
	}
}

/// Result of running a shell command.
#[napi(object)]
pub struct ShellRunResult {
	/// Exit code when the command completes normally.
	pub exit_code: Option<i32>,
	/// Whether the command was cancelled via abort.
	pub cancelled: bool,
	/// Whether the command timed out before completion.
	pub timed_out: bool,

	/// When the minimizer rewrote the captured output, this carries the
	/// original buffer + telemetry so the session layer can persist it as
	/// an artifact and splice an `artifact://<id>` reference into the
	/// minimized text shown to the agent. `None` when nothing was rewritten.
	pub minimized:   Option<MinimizerResult>,
	/// Shell working directory after command completion.
	pub working_dir: Option<String>,
}

impl From<CoreShellRunResult> for ShellRunResult {
	fn from(value: CoreShellRunResult) -> Self {
		Self {
			exit_code:   value.exit_code,
			cancelled:   value.cancelled,
			timed_out:   value.timed_out,
			minimized:   value.minimized.map(Into::into),
			working_dir: value.working_dir,
		}
	}
}

/// Persistent embedded bash engine (pi-shell) shell session.
#[napi]
pub struct Shell {
	inner: Arc<CoreShell>,
}

#[napi]
impl Shell {
	/// Create a new shell session from optional configuration.
	///
	/// The options set session-scoped environment variables and a snapshot path.
	#[napi(constructor)]
	pub fn new(options: Option<ShellOptions>) -> Self {
		Self { inner: Arc::new(CoreShell::new(options.map(Into::into))) }
	}

	/// A new shell with this one's options whose session starts from this
	/// session's state (variables, functions, aliases, options, working
	/// directory) as of its last command boundary: while a command runs, the
	/// state that command started from. What the fork sets stays in the
	/// fork. Never waits for the running command.
	#[napi]
	pub fn fork(&self) -> Self {
		Self { inner: Arc::new(self.inner.fork()) }
	}

	/// Run a shell command using the provided options.
	///
	/// The `on_chunk` callback receives streamed stdout/stderr output. Returns
	/// the exit code when the command completes, or flags when cancelled or
	/// timed out.
	#[napi]
	pub fn run<'env>(
		&self,
		env: &'env Env,
		options: ShellRunOptions<'env>,
		#[napi(ts_arg_type = "((error: Error | null, chunk: string) => void) | undefined | null")]
		on_chunk: Option<ThreadsafeFunction<String, UnknownReturnValue>>,
	) -> Result<PromiseRaw<'env, ShellRunResult>> {
		let cancel_token = task::CancelToken::new(options.timeout_ms, options.signal);
		let inner = Arc::clone(&self.inner);
		let run_options = CoreShellRunOptions {
			command:    options.command,
			cwd:        options.cwd,
			env:        options.env,
			timeout_ms: options.timeout_ms,
			filesystem: options.filesystem.map(ShellFilesystem::into_fs),
			pipe_taps:  options.streams.map(|streams| Arc::clone(&streams.taps)),
			trace:      options.trace.map(|trace| Arc::clone(&trace.inner)),
		};
		task::future(env, "shell.run", async move {
			let (chunk_tx, drain_handle) = bridge_chunks(on_chunk);
			let result = inner
				.run(run_options, chunk_tx, cancel_token.into_core())
				.await
				.map(Into::into)
				.map_err(|err| Error::from_reason(err.to_string()));
			await_drain(drain_handle, &result).await;
			result
		})
	}

	/// Abort all running commands for this shell session.
	///
	/// Returns `Ok(())` even when no commands are running.
	#[napi]
	pub async fn abort(&self) -> Result<()> {
		self.inner.abort().await;
		Ok(())
	}

	/// Count live background jobs (`&`/`nohup` children still running) on this
	/// session. Completed jobs are reaped first. The host uses this to retain a
	/// per-call shell whose background processes are still running instead of
	/// dropping it (which would SIGKILL them via kill-on-drop).
	#[napi]
	pub async fn live_background_job_count(&self) -> u32 {
		self.inner.live_background_job_count().await
	}

	/// Pids of the still-alive processes spawned by this session's in-flight
	/// `run`, in spawn order: foreground commands, pipeline stages, and `&`
	/// jobs started by that run. Builtins run in-process and never appear.
	/// Empty when no run is executing; children that outlive their run are no
	/// longer reported once it returns. Synchronous and never waits on the
	/// running command.
	#[napi]
	pub fn pids(&self) -> Vec<i32> {
		self.inner.pids()
	}
}

/// Run the pi-shell engine as a process shell in this process (`omp zsh`,
/// `omp bash`, `omp sh`).
///
/// `argv` is the shell's whole command line,
/// `argv[0]` naming it (`zsh`, `bash` or `sh` pick the dialect), as a real
/// shell gets it. Synchronous: blocks the calling thread until the shell
/// exits and returns the status the process should exit with (0–255; 101
/// after a panic). The shell uses the process's own stdin, stdout, stderr,
/// terminal and inherited descriptors (duplicated, never taken over); the
/// job-control and termination signals the runtime handles are reset to
/// their defaults for the run and restored after it.
#[napi]
pub fn run_shell_main(argv: Vec<String>) -> i32 {
	let opts = pi_shell::process::ProcessOptions { embedded: true };
	std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| pi_shell::process::main(argv, opts)))
		.unwrap_or(101)
}

/// Execute a command in the embedded bash engine (pi-shell).
///
/// Creates a fresh session for each call. The `on_chunk` callback receives
/// streamed stdout/stderr output. Returns the exit code when the command
/// completes, or flags when cancelled or timed out.
#[napi]
pub fn execute_shell<'env>(
	env: &'env Env,
	options: ShellExecuteOptions<'env>,
	#[napi(ts_arg_type = "((error: Error | null, chunk: string) => void) | undefined | null")]
	on_chunk: Option<ThreadsafeFunction<String, UnknownReturnValue>>,
) -> Result<PromiseRaw<'env, ShellRunResult>> {
	let cancel_token = task::CancelToken::new(options.timeout_ms, options.signal);
	let exec_options = CoreShellExecuteOptions {
		command:       options.command,
		cwd:           options.cwd,
		env:           options.env,
		session_env:   options.session_env,
		timeout_ms:    options.timeout_ms,
		snapshot_path: options.snapshot_path,
		minimizer:     options.minimizer.map(Into::into),
		filesystem:    options.filesystem.map_or_default(ShellFilesystem::into_fs),
	};
	task::future(env, "shell.execute", async move {
		let (chunk_tx, drain_handle) = bridge_chunks(on_chunk);
		let result = core_execute_shell(exec_options, chunk_tx, cancel_token.into_core())
			.await
			.map(Into::into)
			.map_err(|err| Error::from_reason(err.to_string()));
		await_drain(drain_handle, &result).await;
		result
	})
}

/// Capacity (in chunks) of the queue between the output readers (pipe or PTY)
/// and the JS forwarding pump. One queued chunk is at most one read (≤64 KiB),
/// so the Rust side of the bridge holds ~4 MiB worst case before the readers'
/// sends park — which in turn parks the child on its stdout/stderr pipe or PTY
/// (ordinary backpressure) instead of buffering the surplus in process memory
/// (#4078).
pub(crate) const BRIDGE_QUEUE_CHUNKS: usize = 64;

/// Maximum time a single chunk-forwarding `call_async` may take before the
/// pump treats the JS consumer as wedged and disconnects the bridge.
///
/// A healthy consumer runs each callback in microseconds; a slow-but-alive one
/// still returns per chunk, resetting this deadline, so output is never dropped
/// from a consumer that is merely behind. This bound only fires when a single
/// napi callback never returns — the wedge that otherwise leaves the bridge
/// queue full, the pipe reader parked on `send_async`, and the child blocked in
/// `write(2)` so it never exits and the run never settles (#12657). 30s is far
/// beyond any legitimate per-callback latency while still recovering a stranded
/// background job in bounded time.
pub(crate) const FORWARD_STALL_TIMEOUT: Duration = Duration::from_secs(30);

fn bridge_chunks(
	on_chunk: Option<ThreadsafeFunction<String, UnknownReturnValue>>,
) -> (Option<flume::Sender<String>>, Option<napi::tokio::task::JoinHandle<()>>) {
	let Some(on_chunk) = on_chunk else {
		return (None, None);
	};
	let (tx, rx) = flume::bounded::<String>(BRIDGE_QUEUE_CHUNKS);
	let handle = napi::tokio::spawn(pump_chunks(
		rx,
		FORWARD_STALL_TIMEOUT,
		None,
		async move |payload: String| {
			// `call_async` resolves only after the JS callback ran, so at most
			// one batch sits in the napi queue at a time and the JS event loop's
			// actual consumption rate backpressures the whole pipeline. An error
			// means the JS side is gone (env teardown) — stop forwarding.
			on_chunk.call_async(Ok(payload)).await.is_ok()
		},
	));
	(Some(tx), Some(handle))
}

/// One item on a reader→JS bridge queue.
pub(crate) trait BridgeItem {
	/// The output text, or `None` for an explicit end-of-output marker. The
	/// marker ends the pump even while a sender clone is still alive (the PTY
	/// keeps one to inspect queue depth).
	fn into_text(self) -> Option<String>;
}

impl BridgeItem for String {
	fn into_text(self) -> Option<String> {
		Some(self)
	}
}

/// Drain `rx`, greedily coalescing queued chunks into ≤64 KiB batches, and
/// feed each batch to `forward`, awaiting its completion before pulling more.
/// Returns when `rx` disconnects (all senders dropped), on an end-of-output
/// item, when `forward` reports the consumer is gone, or when a single
/// `forward` stalls past `stall_timeout` (a wedged JS consumer). In every case
/// dropping `rx` disconnects the channel so parked/future senders fail fast and
/// the readers keep draining the child instead of wedging it (#12657).
///
/// `busy` is held from the moment a chunk is taken until its batch has been
/// forwarded, so an empty queue with `busy` clear really means no output is
/// in transit (the PTY's stuck-open-slave check).
pub(crate) async fn pump_chunks<T: BridgeItem + Send>(
	rx: flume::Receiver<T>,
	stall_timeout: Duration,
	busy: Option<&AtomicBool>,
	mut forward: impl AsyncFnMut(String) -> bool,
) {
	// Hard cap on one coalesced batch so the JS main thread never sees a
	// multi-MB napi callback (a giant single string would stall sanitize +
	// tail-buffer maintenance for the whole copy).
	const MAX_BATCH_BYTES: usize = 64 * 1024;
	// Initial capacity sized for typical bursty pipe output. Re-allocated
	// each batch because `String` ownership is moved into the napi call.
	const INITIAL_BATCH_CAP: usize = 8 * 1024;
	let set_busy = |value: bool| {
		if let Some(busy) = busy {
			busy.store(value, Ordering::Release);
		}
	};
	let mut batch = String::with_capacity(INITIAL_BATCH_CAP);
	let mut ended = false;
	while !ended
		&& let Ok(first) = rx.recv_async().await
		&& let Some(first) = first.into_text()
	{
		set_busy(true);
		batch.push_str(&first);
		// Greedily drain everything already queued. Child processes that
		// write byte-at-a-time (printf-style progress, llama-cli token
		// streams) otherwise produce one napi callback per `write(2)`,
		// saturating the JS main thread (~200% CPU observed) and leaving
		// the queue draining long after the child exits.
		while batch.len() < MAX_BATCH_BYTES {
			match rx.try_recv().map(BridgeItem::into_text) {
				Ok(Some(more)) => batch.push_str(&more),
				Ok(None) => {
					ended = true;
					break;
				},
				Err(_) => break,
			}
		}
		let payload = std::mem::replace(&mut batch, String::with_capacity(INITIAL_BATCH_CAP));
		// A single napi `call_async` that never returns (a wedged JS consumer)
		// must not park the pump forever: that keeps the bridge queue full, the
		// reader parked on its send, and the child blocked in `write(2)` so it
		// never exits and the run never settles (#12657). Bound each forward;
		// on a stall, return so `rx` drops and the bridge disconnects,
		// unblocking the reader and child. The deadline resets per forward, so a
		// slow-but-progressing consumer still drains losslessly.
		let forwarded = napi::tokio::time::timeout(stall_timeout, forward(payload)).await;
		set_busy(false);
		if !matches!(forwarded, Ok(true)) {
			return;
		}
	}
}

/// Upper bound on how long to wait for the chunk-forwarding pump after an
/// interrupted run resolves. Native cancellation may detach a pipe reader whose
/// sender never closes when a grandchild inherited stdout; waiting for channel
/// disconnect would then wedge the run promise past its requested timeout
/// (#10308). Successful and failed runs remain unbounded so every chunk already
/// accepted by the bridge reaches JavaScript before the result resolves.
const INTERRUPTED_DRAIN_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

/// Finish forwarding accepted output after a native shell run resolves.
///
/// Normal completion and errors drain without a deadline to preserve every
/// accepted chunk. Cancellation and timeout are bounded because an orphaned
/// pipe reader can otherwise keep a sender alive forever; aborting the pump
/// drops its `flume::Receiver`, disconnecting that reader.
async fn await_drain(
	handle: Option<napi::tokio::task::JoinHandle<()>>,
	result: &Result<ShellRunResult>,
) {
	let Some(mut handle) = handle else {
		return;
	};
	if !matches!(result, Ok(result) if result.cancelled || result.timed_out) {
		let _ = handle.await;
		return;
	}
	if napi::tokio::time::timeout(INTERRUPTED_DRAIN_SHUTDOWN_TIMEOUT, &mut handle)
		.await
		.is_err()
	{
		handle.abort();
		let _ = handle.await;
	}
}


