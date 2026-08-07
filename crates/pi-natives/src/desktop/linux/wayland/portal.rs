use std::{fs, path::PathBuf, sync::LazyLock};

use tokio::runtime::{Builder, Runtime};

use crate::desktop::error::{CoreResult, DesktopError};

pub(super) const REMOTE_DESKTOP_TOKEN: &str = "remote-desktop-token";

/// Process-wide Tokio runtime shared by every xdg-desktop-portal call.
///
/// `ashpd` caches a single process-global D-Bus connection whose background
/// I/O tasks are bound to whichever runtime first creates it
/// (`ashpd::proxy::SESSION`). If each portal user spun up its own short-lived
/// runtime, that connection's tasks would be orphaned the moment the runtime
/// was dropped, silently breaking every later portal call made from a
/// different runtime — this is why libei input init poisoned PipeWire capture
/// (issue #7886). Routing all portal work through one long-lived runtime keeps
/// the cached connection's I/O alive for the life of the process. A
/// multi-thread runtime drives that I/O on its own worker even while the
/// caller blocks the calling thread on PipeWire's main loop.
static PORTAL_RUNTIME: LazyLock<Result<Runtime, String>> = LazyLock::new(|| {
	Builder::new_multi_thread()
		.worker_threads(1)
		.enable_all()
		.build()
		.map_err(|err| err.to_string())
});

/// Borrow the shared portal runtime, surfacing a one-time build failure.
pub(super) fn portal_runtime() -> CoreResult<&'static Runtime> {
	PORTAL_RUNTIME
		.as_ref()
		.map_err(|err| DesktopError::internal(format!("xdg-desktop-portal runtime: {err}")))
}

fn token_path(name: &str) -> Option<PathBuf> {
	let base = std::env::var_os("XDG_STATE_HOME")
		.map(PathBuf::from)
		.or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/state")))?;
	Some(base.join("omp").join(name))
}

pub(super) fn read_token(name: &str) -> Option<String> {
	fs::read_to_string(token_path(name)?)
		.ok()
		.map(|token| token.trim().to_string())
		.filter(|token| !token.is_empty())
}

pub(super) fn store_token(name: &str, token: Option<&str>) {
	let (Some(path), Some(token)) = (token_path(name), token) else {
		return;
	};
	let Some(parent) = path.parent() else {
		return;
	};
	if fs::create_dir_all(parent).is_ok() {
		let _ = fs::write(path, token);
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// Every portal caller (libei input init and PipeWire capture) must borrow
	/// one persistent runtime; a regression to per-call runtimes would return
	/// distinct instances and re-open the orphaned-connection bug (#7886).
	#[test]
	fn portal_runtime_is_shared_across_calls() {
		let first = portal_runtime().expect("portal runtime builds");
		let second = portal_runtime().expect("portal runtime builds");
		assert!(
			std::ptr::eq(first, second),
			"portal_runtime must hand back one long-lived runtime, not a fresh per-call instance"
		);
	}
}
