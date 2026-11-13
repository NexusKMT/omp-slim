//! Clipboard utilities backed by arboard.
//!
//! Provides text copy, text read, and image read support across Linux, macOS,
//! and Windows. Performs text copy synchronously so macOS writes run on the
//! caller thread.
//! This avoids worker-thread `AppKit` pasteboard warnings in CLI contexts.

use std::io::Cursor;

use arboard::{Clipboard, Error as ClipboardError, ImageData};
use image::{DynamicImage, ImageFormat, RgbaImage};
use napi::{JsString, bindgen_prelude::*};
use napi_derive::napi;

use crate::{js, task};

/// Serializes every native clipboard operation in the process.
///
/// Paste reads text and image concurrently. On Windows two threads touching
/// the clipboard at once corrupt the text read: units at fixed offsets come
/// back overwritten (`https://` reads as `՞ttp缀難//`) and the damaged text
/// stays on the clipboard. Holding one lock per operation keeps them serial.
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

/// Decode a packed DIB clipboard payload (`CF_DIB`: a `BITMAPINFOHEADER`-family
/// header, optional bitfield masks and palette, then the pixel array) into PNG
/// bytes.
///
/// The payload is wrapped in a synthesized `BITMAPFILEHEADER` and decoded
/// through the BMP *file* path so the explicit `bfOffBits` pins the pixel
/// offset. This matters: the header-less decode path arboard uses mis-places
/// the pixel offset for V4/V5 headers with `BI_BITFIELDS` compression (it
/// skips 12 trailing mask bytes that those headers embed instead), which is
/// why Qt-based screenshot tools (`PixPin`, `Snipaste`, ...) fail through
/// arboard in the first place (#3426).
fn dib_to_png(dib: &[u8]) -> Result<Vec<u8>> {
	const FILE_HEADER_SIZE: u64 = 14;
	const INFO_HEADER_SIZE: u64 = 40;
	const BI_BITFIELDS: u32 = 3;

	if dib.len() < INFO_HEADER_SIZE as usize {
		return Err(Error::from_reason("Clipboard DIB shorter than BITMAPINFOHEADER"));
	}
	let u32_at =
		|at: usize| u32::from_le_bytes(dib[at..at + 4].try_into().expect("bounds checked above"));
	let header_size = u64::from(u32_at(0));
	if header_size < INFO_HEADER_SIZE || header_size > dib.len() as u64 {
		return Err(Error::from_reason("Clipboard DIB header size out of range"));
	}
	let bit_count = u16::from_le_bytes([dib[14], dib[15]]);
	let compression = u32_at(16);
	let colors_used = u64::from(u32_at(32));

	// A plain BITMAPINFOHEADER with BI_BITFIELDS is trailed by three DWORD
	// masks; larger (V2..V5) headers embed the masks in the header itself.
	let mask_bytes: u64 = if header_size == INFO_HEADER_SIZE && compression == BI_BITFIELDS {
		12
	} else {
		0
	};
	let palette_entries: u64 = if colors_used != 0 {
		colors_used
	} else if bit_count <= 8 {
		1u64 << bit_count
	} else {
		0
	};
	let pixel_offset =
		u32::try_from(FILE_HEADER_SIZE + header_size + mask_bytes + palette_entries * 4)
			.map_err(|_| Error::from_reason("Clipboard DIB layout overflow"))?;
	let file_size = u32::try_from(FILE_HEADER_SIZE + dib.len() as u64)
		.map_err(|_| Error::from_reason("Clipboard DIB too large"))?;

	let mut bmp = Vec::with_capacity(FILE_HEADER_SIZE as usize + dib.len());
	bmp.extend_from_slice(b"BM");
	bmp.extend_from_slice(&file_size.to_le_bytes());
	bmp.extend_from_slice(&0u32.to_le_bytes());
	bmp.extend_from_slice(&pixel_offset.to_le_bytes());
	bmp.extend_from_slice(dib);

	let decoded = image::load_from_memory_with_format(&bmp, ImageFormat::Bmp)
		.map_err(|err| Error::from_reason(format!("Failed to decode clipboard DIB: {err}")))?;
	rgba_to_png(decoded.into_rgba8())
}

/// Read the raw `CF_DIB` bytes from the Windows clipboard.
///
/// Windows synthesizes `CF_DIB` from whatever bitmap formats are present, so
/// it is available whenever the clipboard holds any image at all.
#[cfg(windows)]
fn read_raw_cf_dib() -> Option<Vec<u8>> {
	let clip = clipboard_win::Clipboard::new_attempts(10).ok()?;
	let mut dib = Vec::new();
	clipboard_win::raw::get_vec(clipboard_win::formats::CF_DIB, &mut dib).ok()?;
	drop(clip);
	(!dib.is_empty()).then_some(dib)
}

/// Whether the Windows clipboard advertises any bitmap-family format.
///
/// `CF_DIB`/`CF_DIBV5`/`CF_BITMAP` synthesize from one another, so a clipboard
/// holding an image the native decoders cannot read still answers here — the
/// signal that a slower bridge (`Clipboard.GetImage()`) is worth starting.
#[cfg(windows)]
fn clipboard_has_bitmap() -> bool {
	use clipboard_win::{formats, is_format_avail};
	[formats::CF_DIB, formats::CF_DIBV5, formats::CF_BITMAP]
		.into_iter()
		.any(is_format_avail)
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

/// macOS / Windows: the OS retains clipboard contents after the writing process
/// exits, so a transient `Clipboard` is sufficient. Keeping the write on the
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

/// What the locked OS read of the image clipboard found. PNG encoding and DIB
/// decoding run after [`CLIPBOARD_ACCESS`] is released: they only touch owned
/// buffers, and holding the lock through them would stall a synchronous copy
/// on the JS thread for the length of a large encode.
enum ImageRead {
	Image(ImageData<'static>),
	/// arboard found no image, but a bitmap format is advertised; carries the
	/// raw `CF_DIB` when it could be read.
	#[cfg_attr(not(windows), allow(dead_code, reason = "only the Windows bitmap probe produces it"))]
	Bitmap(Option<Vec<u8>>),
	Missing,
	/// arboard failed; carries the raw `CF_DIB` fallback when it could be read.
	Failed(ClipboardError, Option<Vec<u8>>),
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
				// arboard only probes `PNG` and `CF_DIBV5`. When it finds neither
				// but a bitmap format is advertised, still try the raw `CF_DIB`.
				#[cfg(windows)]
				Err(ClipboardError::ContentNotAvailable) if clipboard_has_bitmap() => {
					ImageRead::Bitmap(read_raw_cf_dib())
				},
				Err(ClipboardError::ContentNotAvailable) => ImageRead::Missing,
				// arboard rejects the CF_DIBV5 payloads Qt-based screenshot tools
				// (PixPin, Snipaste, ...) produce; read the raw CF_DIB to decode
				// ourselves (#3426).
				Err(err) => {
					#[cfg(windows)]
					let dib = read_raw_cf_dib();
					#[cfg(not(windows))]
					let dib = None;
					ImageRead::Failed(err, dib)
				},
			}
		};
		match read {
			ImageRead::Image(image) => Ok(Some(png_image(encode_png(image)?))),
			// A bitmap nothing here decodes surfaces an error so the caller can
			// fall back to `Clipboard.GetImage()` (#2430). A clipboard with no
			// bitmap at all stays `None`, keeping text-only pastes in-process.
			ImageRead::Bitmap(dib) => match dib.and_then(|dib| dib_to_png(&dib).ok()) {
				Some(bytes) => Ok(Some(png_image(bytes))),
				None => Err(Error::from_reason(
					"Clipboard advertises a bitmap the native reader cannot decode",
				)),
			},
			ImageRead::Missing => Ok(None),
			// A fallback decode failure keeps the original arboard error.
			ImageRead::Failed(err, dib) => match dib.and_then(|dib| dib_to_png(&dib).ok()) {
				Some(bytes) => Ok(Some(png_image(bytes))),
				None => Err(Error::from_reason(format!("Failed to read clipboard image: {err}"))),
			},
		}
	})
}


