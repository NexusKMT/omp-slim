//! Clipboard utilities backed by arboard.
//!
//! Provides text copy, text read, and image read support on Linux and macOS.
//! Performs text copy synchronously so macOS writes run on the caller thread.
//! This avoids worker-thread `AppKit` pasteboard warnings in CLI contexts.

use std::io::Cursor;

use arboard::{Clipboard, Error as ClipboardError, ImageData};
use image::{DynamicImage, ImageFormat, RgbaImage};
use napi::{JsString, bindgen_prelude::*};
use napi_derive::napi;

use crate::{js, task};

/// Serializes every native clipboard operation in the process.
///
/// Paste reads text and image concurrently, and two threads touching one
/// clipboard at once can interleave the platform reads. Holding one lock per
/// operation keeps them serial.
static CLIPBOARD_ACCESS: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

/// Clipboard image payload encoded as PNG bytes.
#[napi(object)]
pub struct ClipboardImage {
	/// PNG-encoded image bytes.
	pub data:      Uint8Array,
	/// MIME type for the encoded image payload.
	pub mime_type: String,
}

fn encode_png(image: ImageData<'_>) -> Result<Vec<u8>> {
	let width = u32::try_from(image.width)
		.map_err(|_| Error::from_reason("Clipboard image width overflow"))?;
	let height = u32::try_from(image.height)
		.map_err(|_| Error::from_reason("Clipboard image height overflow"))?;
	let bytes = image.bytes.into_owned();
	let buffer = RgbaImage::from_raw(width, height, bytes)
		.ok_or_else(|| Error::from_reason("Clipboard image buffer size mismatch"))?;
	rgba_to_png(buffer)
}

fn rgba_to_png(buffer: RgbaImage) -> Result<Vec<u8>> {
	let capacity = (buffer
		.width()
		.saturating_mul(buffer.height())
		.saturating_mul(4)) as usize;
	let mut output = Vec::with_capacity(capacity);
	DynamicImage::ImageRgba8(buffer)
		.write_to(&mut Cursor::new(&mut output), ImageFormat::Png)
		.map_err(|err| Error::from_reason(format!("Failed to encode clipboard image: {err}")))?;
	Ok(output)
}

/// Copy plain text to the system clipboard.
///
/// # Parameters
/// - `text`: UTF-8 text to place on the clipboard.
///
/// # Errors
/// Returns an error if clipboard access fails.
#[napi]
pub fn copy_to_clipboard(text: JsString) -> Result<()> {
	let text = js::utf8(text)?;
	let _access = CLIPBOARD_ACCESS.lock();
	set_clipboard_text(&text)
}

/// Linux: keep a single `arboard::Clipboard` alive for the whole process.
///
/// X11 (and Wayland) clipboards are owner-based: the process that set the
/// selection must stay alive and answer `SelectionRequest` events, otherwise
/// the contents vanish the moment the owner goes away. arboard serves those
/// requests from a global background thread that only lives as long as a
/// `Clipboard` instance exists — so creating a throwaway `Clipboard` per copy
/// (which is then dropped) tears that thread down immediately and leaves the
/// X11 clipboard empty even while our process keeps running (issue #2075).
/// Holding one instance for the lifetime of the process keeps that owner thread
/// serving, without shelling out to `xclip`/`wl-copy`. Wayland is unaffected
/// (`wl-clipboard-rs` forks its own serving process) but sharing the instance
/// is harmless there.
#[cfg(target_os = "linux")]
fn set_clipboard_text(text: &str) -> Result<()> {
	use parking_lot::Mutex;

	static CLIPBOARD: Mutex<Option<Clipboard>> = Mutex::new(None);
	let mut guard = CLIPBOARD.lock();
	if guard.is_none() {
		*guard = Some(
			Clipboard::new()
				.map_err(|err| Error::from_reason(format!("Failed to access clipboard: {err}")))?,
		);
	}
	guard
		.as_mut()
		.expect("clipboard initialized above")
		.set_text(text)
		.map_err(|err| Error::from_reason(format!("Failed to copy to clipboard: {err}")))?;
	Ok(())
}

/// macOS: the OS retains clipboard contents after the writing process exits,
/// so a transient `Clipboard` is sufficient. Keeping the write on the
/// calling thread also avoids worker-thread `AppKit` pasteboard warnings on
/// macOS.
#[cfg(not(target_os = "linux"))]
fn set_clipboard_text(text: &str) -> Result<()> {
	let mut clipboard = Clipboard::new()
		.map_err(|err| Error::from_reason(format!("Failed to access clipboard: {err}")))?;
	clipboard
		.set_text(text)
		.map_err(|err| Error::from_reason(format!("Failed to copy to clipboard: {err}")))?;
	Ok(())
}

/// Read plain text from the system clipboard.
///
/// Returns `Ok(None)` when the clipboard holds no text, so callers can tell
/// "empty" from "unreadable" without spawning a shell bridge.
///
/// # Errors
/// Returns an error if clipboard access fails.
#[napi]
pub fn read_text_from_clipboard() -> task::Promise<Option<String>> {
	task::blocking("clipboard.read_text", (), move |_| -> Result<Option<String>> {
		let _access = CLIPBOARD_ACCESS.lock();
		let mut clipboard = Clipboard::new()
			.map_err(|err| Error::from_reason(format!("Failed to access clipboard: {err}")))?;
		match clipboard.get_text() {
			Ok(text) => Ok(Some(text)),
			Err(ClipboardError::ContentNotAvailable) => Ok(None),
			Err(err) => Err(Error::from_reason(format!("Failed to read clipboard text: {err}"))),
		}
	})
}

/// What the locked OS read of the image clipboard found. PNG encoding runs
/// after [`CLIPBOARD_ACCESS`] is released: it only touches owned buffers, and
/// holding the lock through it would stall a synchronous copy on the JS thread
/// for the length of a large encode.
enum ImageRead {
	Image(ImageData<'static>),
	Missing,
	/// arboard failed; keeps its error for the caller.
	Failed(ClipboardError),
}

fn png_image(bytes: Vec<u8>) -> ClipboardImage {
	ClipboardImage { data: Uint8Array::from(bytes), mime_type: "image/png".to_string() }
}

/// Read an image from the system clipboard.
///
/// Returns `Ok(None)` when no image data is available.
///
/// # Errors
/// Returns an error if clipboard access fails or image encoding fails.
#[napi]
pub fn read_image_from_clipboard() -> task::Promise<Option<ClipboardImage>> {
	task::blocking("clipboard.read_image", (), move |_| -> Result<Option<ClipboardImage>> {
		let read = {
			let _access = CLIPBOARD_ACCESS.lock();
			let mut clipboard = Clipboard::new()
				.map_err(|err| Error::from_reason(format!("Failed to access clipboard: {err}")))?;
			match clipboard.get_image() {
				Ok(image) => ImageRead::Image(image),
				Err(ClipboardError::ContentNotAvailable) => ImageRead::Missing,
				Err(err) => ImageRead::Failed(err),
			}
		};
		match read {
			ImageRead::Image(image) => Ok(Some(png_image(encode_png(image)?))),
			// A clipboard with no image stays `None`, keeping text-only pastes
			// in-process.
			ImageRead::Missing => Ok(None),
			ImageRead::Failed(err) => {
				Err(Error::from_reason(format!("Failed to read clipboard image: {err}")))
			},
		}
	})
}
