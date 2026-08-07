//! Stub backend for platforms without a native audio implementation.

use super::{CaptureSink, DeviceConfig, PlaybackFill};
use crate::VoiceResult;

const UNSUPPORTED: &str = "Native audio is not supported on this platform";

pub(crate) struct PlaybackDevice;

impl PlaybackDevice {
	pub fn start(_config: DeviceConfig, _fill: PlaybackFill) -> VoiceResult<Self> {
		Err(UNSUPPORTED.to_owned())
	}

	pub fn stop(&mut self) -> VoiceResult<()> {
		Ok(())
	}
}

pub(crate) struct CaptureDevice;

impl CaptureDevice {
	pub fn start(_config: DeviceConfig, _sink: CaptureSink) -> VoiceResult<Self> {
		Err(UNSUPPORTED.to_owned())
	}

	pub fn stop(&mut self) -> VoiceResult<()> {
		Ok(())
	}
}
