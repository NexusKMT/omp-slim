//! Engine behavior suites driven through the testkit host.

use std::path::{Path, PathBuf};

/// The testkit fixture directory `sub` (`events`, `skeleton`), relative to the
/// crate root.
fn fixtures(sub: &str) -> PathBuf {
	Path::new(env!("CARGO_MANIFEST_DIR"))
		.join("src/testkit/fixtures")
		.join(sub)
}

mod bang_pid;
mod cancel_latency;
mod cancel_traps;
mod control;
mod coproc_jobs;
mod errexit;
mod events;
mod executor;
mod expand;
mod getopts;
mod host_hooks;
mod interactive_builtins;
mod jobs;
mod kill;
mod lineage;
mod mem_fds;
mod nested_shell;
mod orphan_jobs;
mod procsub;
mod restore_fidelity;
mod skeleton;
mod startup_vars;
mod stdin_script;
mod tool_profile;
mod trace;
mod trap;
mod vars;
