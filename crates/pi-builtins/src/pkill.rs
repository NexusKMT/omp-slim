//! `pkill` process-signalling builtin moved from `pi-shell`.

use clap::Parser;

use crate::{
	host::{ProcContext, Process},
	proc_match,
};

/// Selects processes by name or attributes and sends them a signal.
#[derive(Parser)]
#[command(disable_help_flag = true, disable_version_flag = true)]
pub(crate) struct PkillCommand {
	/// Arguments interpreted by the shared process-matching engine.
	#[arg(num_args = 0.., trailing_var_arg = true, allow_hyphen_values = true)]
	argv: Vec<String>,
}

impl Process for PkillCommand {
	const USES_PATHS: bool = true;

	fn run(&self, context: &ProcContext) -> impl Future<Output = std::io::Result<i32>> + Send {
		proc_match::run(proc_match::ProcMatchMode::Kill, &self.argv, context)
	}
}


