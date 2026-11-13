//! The `sleep` builtin, moved from `pi-shell`.

use std::{future::Future, io::Write, time::Duration};

use clap::Parser;
use tokio::time;

use crate::{
	duration::parse_duration,
	host::{INTERRUPTED_EXIT_CODE, ProcContext, Process},
};

/// Pause execution for the sum of the requested durations.
#[derive(Parser)]
#[command(disable_help_flag = true)]
pub(crate) struct SleepCommand {
	// GNU reports `sleep -1` as an invalid time interval (exit 1), not as an
	// unknown option; let hyphenated operands through to `parse_duration`.
	#[arg(required = true, allow_hyphen_values = true)]
	durations: Vec<String>,
}

impl Process for SleepCommand {
	fn run(&self, context: &ProcContext) -> impl Future<Output = std::io::Result<i32>> + Send {
		let durations = &self.durations;
		async move {
			if context.is_cancelled() {
				return Ok(INTERRUPTED_EXIT_CODE);
			}
			let mut total = Duration::ZERO;
			for duration in durations {
				let Some(parsed) = parse_duration(duration) else {
					let _ = writeln!(context.stderr(), "sleep: invalid time interval '{duration}'");
					return Ok(1);
				};
				// `infinity` parses as `Duration::MAX`; keep the sum saturating.
				total = total.saturating_add(parsed);
			}
			context.flush_output().await?;
			let sleep = time::sleep(total);
			tokio::pin!(sleep);
			if let Some(cancel_token) = context.cancel_token() {
				tokio::select! {
					() = &mut sleep => Ok(0),
					() = cancel_token.cancelled() => Ok(INTERRUPTED_EXIT_CODE),
				}
			} else {
				sleep.await;
				Ok(0)
			}
		}
	}
}


