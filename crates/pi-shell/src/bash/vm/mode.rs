//! Modes: a vproc's current mode and the grammar a mode parses with.

use super::proc::Vproc;
use crate::bash::{
	ids::ModeId,
	store::{MiscKey, StateStore},
};

/// Make `mode` `vp`'s current mode; the root's is written through as
/// [`MiscKey::Mode`].
pub fn set_mode(
	root: &mut super::state::Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	mode: ModeId,
) {
	if vp.mode == mode {
		return;
	}
	vp.mode = mode;
	if vp.overlay.is_none() {
		root.set_misc(store, MiscKey::Mode, <&'static str>::from(mode));
	}
}
