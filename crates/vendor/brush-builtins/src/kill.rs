use std::io::Write;

use brush_core::{ExecutionExitCode, ExecutionResult, builtins, sys, traps::TrapSignal};
use clap::Parser;

/// Signal a job or process.
#[derive(Parser)]
pub(crate) struct KillCommand {
	/// Name of the signal to send.
	#[arg(short = 's', value_name = "SIG_NAME")]
	signal_name: Option<String>,

	/// Number of the signal to send.
	#[arg(short = 'n', value_name = "SIG_NUM")]
	signal_number: Option<usize>,

	//
	// TODO(kill): implement -sigspec syntax
	/// List known signal names.
	#[arg(short = 'l', short_alias = 'L')]
	list_signals: bool,

	// Interpretation of these depends on whether -l is present.
	#[arg(allow_hyphen_values = true)]
	args: Vec<String>,
}

impl builtins::Command for KillCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		// Match shell and POSIX defaults by allowing graceful termination.
		let mut trap_signal = TrapSignal::Signal(nix::sys::signal::Signal::SIGTERM);

		// Try parsing the signal name (if specified).
		if let Some(signal_name) = &self.signal_name {
			if let Ok(parsed_trap_signal) = TrapSignal::try_from(signal_name.as_str()) {
				trap_signal = parsed_trap_signal;
			} else {
				writeln!(
					context.stderr(),
					"{}: invalid signal name: {}",
					context.command_name,
					signal_name
				)?;
				return Ok(ExecutionExitCode::InvalidUsage.into());
			}
		}

		// Try parsing the signal number (if specified).
		if let Some(signal_number) = &self.signal_number {
			#[expect(clippy::cast_possible_truncation)]
			#[expect(clippy::cast_possible_wrap)]
			if let Ok(parsed_trap_signal) = TrapSignal::try_from(*signal_number as i32) {
				trap_signal = parsed_trap_signal;
			} else {
				writeln!(
					context.stderr(),
					"{}: invalid signal number: {}",
					context.command_name,
					signal_number
				)?;
				return Ok(ExecutionExitCode::InvalidUsage.into());
			}
		}

		// Parse the remaining args: an optional leading `-sigspec` in the option
		// position, an optional `--` end-of-options marker, then pid/jobspec
		// operands. A hyphen is only a sigspec while still in the option position;
		// once a sigspec or an operand is seen, later hyphen-led args are operands
		// so negative PIDs (process groups per `kill(2)`) survive — e.g.
		// `kill -TERM -- -10 123` signals process group 10 and PID 123.
		let mut operands: Vec<&String> = Vec::new();
		let mut options_done = false;
		let mut consumed_end_of_options = false;
		for arg in &self.args {
			// The first `--` ends option parsing and is not itself an operand.
			if !consumed_end_of_options && arg == "--" {
				consumed_end_of_options = true;
				options_done = true;
				continue;
			}
			if options_done {
				operands.push(arg);
				continue;
			}
			match arg.strip_prefix('-') {
				Some(possible_sigspec) if !possible_sigspec.is_empty() => {
					// Option position: interpret as a signal specification. The
					// sigspec may be a signal name (e.g. -TERM) or number (e.g. -9).
					if let Ok(parsed_trap_signal) = possible_sigspec.parse::<TrapSignal>() {
						trap_signal = parsed_trap_signal;
						options_done = true;
					} else {
						writeln!(context.stderr(), "{}: invalid signal name", context.command_name)?;
						return Ok(ExecutionExitCode::InvalidUsage.into());
					}
				},
				_ => {
					// First operand ends the option position.
					operands.push(arg);
					options_done = true;
				},
			}
		}

		if self.list_signals {
			return print_signals(&context, self.args.as_ref());
		}
		if operands.is_empty() {
			writeln!(context.stderr(), "{}: invalid usage", context.command_name)?;
			return Ok(ExecutionExitCode::InvalidUsage.into());
		}

		let mut had_failure = false;
		for pid_or_job_spec in operands {
			let signal_result = if pid_or_job_spec.starts_with('%') {
				// It's a job spec.
				if let Some(job) = context.shell.jobs_mut().resolve_job_spec(pid_or_job_spec) {
					job.kill(trap_signal)
				} else {
					writeln!(
						context.stderr(),
						"{}: {}: no such job",
						context.command_name,
						pid_or_job_spec
					)?;
					had_failure = true;
					continue;
				}
			} else {
				brush_core::int_utils::parse(pid_or_job_spec.as_str(), 10)
					.and_then(|pid| sys::signal::kill_process(pid, trap_signal))
			};

			if let Err(err) = signal_result {
				writeln!(
					context.stderr(),
					"{}: {}: {}",
					context.command_name,
					pid_or_job_spec,
					err
				)?;
				had_failure = true;
			}
		}

		if had_failure {
			Ok(ExecutionResult::general_error())
		} else {
			Ok(ExecutionResult::success())
		}
	}
}

fn print_signals(
	context: &brush_core::ExecutionContext<'_, impl brush_core::ShellExtensions>,
	signals: &[String],
) -> Result<ExecutionResult, brush_core::Error> {
	let mut exit_code = ExecutionResult::success();
	if !signals.is_empty() {
		for s in signals {
			// If the user gives us a code, we print the name; if they give a name, we print
			// its code.
			enum PrintSignal {
				Name(&'static str),
				Num(i32),
			}

			let signal = if let Ok(n) = s.parse::<i32>() {
				// bash compatibility. `SIGHUP` -> `HUP`
				TrapSignal::try_from(n)
					.map(|s| PrintSignal::Name(s.as_str().strip_prefix("SIG").unwrap_or(s.as_str())))
			} else {
				TrapSignal::try_from(s.as_str()).map(|sig| {
					i32::try_from(sig).map_or(PrintSignal::Name(sig.as_str()), PrintSignal::Num)
				})
			};

			match signal {
				Ok(PrintSignal::Num(n)) => {
					writeln!(context.stdout(), "{n}")?;
				},
				Ok(PrintSignal::Name(s)) => {
					writeln!(context.stdout(), "{s}")?;
				},
				Err(e) => {
					writeln!(context.stderr(), "{e}")?;
					exit_code = ExecutionResult::general_error();
				},
			}
		}
	} else {
		return brush_core::traps::format_signals(
			context.stdout(),
			TrapSignal::iterator().filter(|s| !matches!(s, TrapSignal::Exit)),
		)
		.map(|()| ExecutionResult::success());
	}

	Ok(exit_code)
}
