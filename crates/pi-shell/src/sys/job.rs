//! Whole-job pause and exit classification for Windows Job Objects, written
//! against a small trait so the state machine is tested on every platform.
//!
//! Windows has no `SIGSTOP`: a job pauses by suspending each member process
//! (`NtSuspendProcess`) and resumes by resuming exactly the processes it
//! suspended (`NtResumeProcess`), through the handles it opened, so a pid
//! recycled in between is never touched. Pause and resume are idempotent per
//! job: several `ExtProc`s of one pipeline share the job, and the engine
//! calls `stop`/`cont` on each.

use std::io;

use crate::bash::{ExitStatus, Signal};

/// The operations a job pause needs from the OS.
pub trait JobOps {
	/// An opened member process (keeps its identity).
	type Member;
	/// The job's current members, opened for suspend/resume.
	fn members(&self) -> io::Result<Vec<Self::Member>>;
	/// Suspend one member.
	fn suspend(&self, m: &Self::Member) -> io::Result<()>;
	/// Resume one member.
	fn resume(&self, m: &Self::Member) -> io::Result<()>;
}

/// Pause state of one job.
#[derive(Debug)]
pub struct JobPause<M> {
	/// Members suspended by the current pause; `None` when running.
	suspended: Option<Vec<M>>,
}

impl<M> Default for JobPause<M> {
	fn default() -> Self {
		Self { suspended: None }
	}
}

impl<M> JobPause<M> {
	

	/// Suspend every member (no-op when paused). Members that exit while
	/// being listed are skipped; the first other failure resumes what was
	/// suspended and is returned.
	pub fn pause<O: JobOps<Member = M>>(&mut self, ops: &O) -> io::Result<()> {
		if self.suspended.is_some() {
			return Ok(());
		}
		let mut done = Vec::new();
		for m in ops.members()? {
			match ops.suspend(&m) {
				Ok(()) => done.push(m),
				Err(e) if e.kind() == io::ErrorKind::NotFound => {},
				Err(e) => {
					for m in &done {
						let _ = ops.resume(m);
					}
					return Err(e);
				},
			}
		}
		self.suspended = Some(done);
		Ok(())
	}

	/// Resume exactly the members the pause suspended (no-op when running).
	/// Every member is attempted; the first failure is returned.
	pub fn resume<O: JobOps<Member = M>>(&mut self, ops: &O) -> io::Result<()> {
		let Some(done) = self.suspended.take() else {
			return Ok(());
		};
		let mut first = Ok(());
		for m in &done {
			if let Err(e) = ops.resume(m)
				&& first.is_ok()
			{
				first = Err(e);
			}
		}
		first
	}
}

/// Exit code `TerminateJobObject` gives every member when the job is killed
/// (`128 + SIGKILL`, what bash shows for a killed command).
pub const KILL_EXIT_CODE: u32 = 137;

/// `STATUS_CONTROL_C_EXIT`: the exit code of a console process ended by its
/// default `CTRL_C`/`CTRL_BREAK` handler.
pub const CONTROL_C_EXIT: u32 = 0xc000_013a;

/// Classify a Windows exit code: our own job kill reads as
/// `Signaled(KILL)`, the console-control exit as the signal we mapped to a
/// console control event (`console`, else INT), anything else as a plain
/// exit. An MSYS or Cygwin program killed by signal S exits with `S << 8`
/// (its runtime hands a parent it did not start the Unix wait status
/// byte-swapped): that reads as `Signaled(S)`, in the runtime's BSD
/// numbering.
pub fn exit_status(code: u32, killed: bool, console: Option<Signal>) -> ExitStatus {
	let msys_signal = || {
		let n = u8::try_from(code >> 8).ok()? & 0x7f;
		Signal::from_number(n, crate::bash::Platform::MacOs)
	};
	match code {
		KILL_EXIT_CODE if killed => ExitStatus::Signaled(Signal::Kill),
		CONTROL_C_EXIT => ExitStatus::Signaled(console.unwrap_or(Signal::Int)),
		0x100..=0xffff
			if code & 0xff == 0
				&& let Some(sig) = msys_signal() =>
		{
			ExitStatus::Signaled(sig)
		},
		code => ExitStatus::Exited(code as i32),
	}
}


