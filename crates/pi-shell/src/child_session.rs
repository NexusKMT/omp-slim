//! Which session and terminal a spawned child may hold.
//!
//! The embedded shell's spawner detaches every external into its own session
//! and process group (`crate::host::PiHost`): pi never runs a child that can
//! reach its controlling terminal. [`child_session_action`] states the policy
//! for a shell that does own a terminal (interactive job control), which
//! pi-natives' terminal code follows.

/// What to do with the child's controlling-tty/session ownership immediately
/// before spawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChildSessionAction {
	/// Call `setsid()` so the child cannot stop the parent through
	/// SIGTTIN/SIGTTOU on the inherited tty.
	DetachSession,
	/// Move the child to the foreground of its tty so it participates in
	/// interactive job control.
	TakeForeground,
	/// Leave session/foreground state alone.
	None,
}

/// Decide whether to detach the child's session, foreground it, or do
/// nothing.
///
/// A child whose stdin is **not** a terminal always detaches, even when it is
/// a stage of a multi-command pipeline: an interactive program in a pipeline
/// (`zsh -i ... | awk`) would otherwise open `/dev/tty`, `tcsetpgrp` itself
/// to the foreground, and leave the host stopped on its next tty read.
/// `setsid()` puts each stage in its own session with no controlling tty, so
/// it cannot reach `/dev/tty` at all.
///
/// `_in_pipeline_group` is not consulted: a pipeline stage that legitimately
/// needs the shared tty group has terminal stdin and is handled by the
/// `child_stdin_is_terminal` arm before pipeline membership would matter.
/// Foregrounding is gated on `new_pg && child_stdin_is_terminal`.
#[must_use]
pub const fn child_session_action(
	new_pg: bool,
	child_stdin_is_terminal: bool,
	_in_pipeline_group: bool,
) -> ChildSessionAction {
	if new_pg && child_stdin_is_terminal {
		return ChildSessionAction::TakeForeground;
	}
	if child_stdin_is_terminal {
		return ChildSessionAction::None;
	}
	ChildSessionAction::DetachSession
}


