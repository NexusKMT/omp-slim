//! SIXEL terminal-image encoding and bounded decoding.
//!
//! Encodes PNG/JPEG/WebP/GIF images for terminal display and decodes captured
//! SIXEL control strings back to bounded PNG attachments.
//!
//! General-purpose image processing stays in `Bun.Image`; the native boundary
//! exists because SIXEL has no equivalent decoder there.

use std::io::Cursor;

#[path = "sixel_codec.rs"]
mod codec;
use image::{DynamicImage, ImageFormat, ImageReader, imageops::FilterType};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::task;

const MAX_DECODED_PIXELS: usize = 4 * 1024 * 1024;
const MAX_IMAGE_EDGE: usize = 8192;
const MAX_SIXEL_BYTES: usize = 20 * 1024 * 1024;
const MAX_PNG_BYTES: usize = 20 * 1024 * 1024;

/// Decode one complete SIXEL control string into a PNG on the calling thread.
///
/// Raster declarations, repeats, and row advances are bounded before allocating
/// the decoded RGBA buffer.
#[napi]
pub fn decode_sixel_to_png(bytes: Uint8Array) -> Result<Uint8Array> {
	if bytes.len() > MAX_SIXEL_BYTES {
		return Err(Error::from_reason("SIXEL payload exceeds the 20 MiB limit"));
	}
	decode_sixel(bytes.as_ref()).map(Uint8Array::from)
}

/// Same result as [`decode_sixel_to_png`], but the decode runs on the native
/// blocking pool instead of the JS thread.
#[napi]
pub fn decode_sixel_to_png_async(bytes: Uint8Array) -> task::Promise<Uint8Array> {
	// An oversized payload rejects without being copied off the JS heap.
	let bytes = (bytes.len() <= MAX_SIXEL_BYTES).then(|| bytes.to_vec());
	task::blocking("sixel.decode", (), move |_| {
		let bytes =
			bytes.ok_or_else(|| Error::from_reason("SIXEL payload exceeds the 20 MiB limit"))?;
		decode_sixel(&bytes).map(Uint8Array::from)
	})
}

fn decode_sixel(bytes: &[u8]) -> Result<Vec<u8>> {
	preflight_sixel_dimensions(bytes)?;

	let rgba = codec::decode(bytes)?;
	let mut png = Vec::with_capacity(rgba.len().min(MAX_PNG_BYTES));
	DynamicImage::ImageRgba8(rgba)
		.write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
		.map_err(|err| Error::from_reason(format!("Failed to encode decoded SIXEL as PNG: {err}")))?;
	if png.len() > MAX_PNG_BYTES {
		return Err(Error::from_reason("Decoded SIXEL PNG exceeds the 20 MiB limit"));
	}
	Ok(png)
}

fn guard_dimensions(width: usize, height: usize) -> Result<()> {
	if width == 0
		|| height == 0
		|| width > MAX_IMAGE_EDGE
		|| height > MAX_IMAGE_EDGE
		|| width.saturating_mul(height) > MAX_DECODED_PIXELS
	{
		return Err(Error::from_reason("SIXEL image dimensions exceed the decode limit"));
	}
	Ok(())
}

fn preflight_sixel_dimensions(bytes: &[u8]) -> Result<()> {
	let payload_start = bytes
		.array_windows()
		.position(|window| window == b"\x1bP")
		.map(|index| index + 2)
		.or_else(|| {
			bytes
				.iter()
				.position(|byte| *byte == 0x90)
				.map(|index| index + 1)
		})
		.ok_or_else(|| Error::from_reason("SIXEL data is missing a DCS introducer"))?;
	let q = bytes[payload_start..]
		.iter()
		.position(|byte| *byte == b'q')
		.map(|index| payload_start + index + 1)
		.ok_or_else(|| Error::from_reason("SIXEL data is missing its q introducer"))?;

	let mut x = 0usize;
	let mut y = 0usize;
	let mut max_width = 0usize;
	let mut max_height = 0usize;
	let mut index = q;
	while index < bytes.len() {
		let byte = bytes[index];
		if byte == 0x9c || (byte == 0x1b && bytes.get(index + 1) == Some(&b'\\')) {
			break;
		}
		match byte {
			b'?'..=b'~' => {
				x = x.saturating_add(1);
				max_width = max_width.max(x);
				max_height = max_height.max(y.saturating_add(6));
			},
			b'!' => {
				let (count, next) = decimal(bytes, index + 1);
				if let Some(sixel) = bytes.get(next)
					&& (b'?'..=b'~').contains(sixel)
				{
					x = x.saturating_add(count);
					max_width = max_width.max(x);
					max_height = max_height.max(y.saturating_add(6));
					index = next;
				}
			},
			b'-' => {
				y = y.saturating_add(6);
				x = 0;
			},
			b'$' => x = 0,
			b'"' => {
				let mut values = [0usize; 4];
				let mut next = index + 1;
				for value in &mut values {
					let (parsed, end) = decimal(bytes, next);
					*value = parsed;
					next = end;
					if bytes.get(next) != Some(&b';') {
						break;
					}
					next += 1;
				}
				if values[2] > 0 || values[3] > 0 {
					guard_dimensions(values[2].max(1), values[3].max(1))?;
					max_width = max_width.max(values[2]);
					max_height = max_height.max(values[3]);
				}
				index = next.saturating_sub(1);
			},
			_ => {},
		}
		guard_dimensions(max_width.max(1), max_height.max(1))?;
		index += 1;
	}
	guard_dimensions(max_width.max(1), max_height.max(1))
}

fn decimal(bytes: &[u8], mut index: usize) -> (usize, usize) {
	let mut value = 0usize;
	while let Some(&digit @ b'0'..=b'9') = bytes.get(index) {
		value = value
			.saturating_mul(10)
			.saturating_add((digit - b'0') as usize);
		index += 1;
	}
	(value, index)
}

/// Encode image bytes into a SIXEL escape sequence for terminal rendering, on
/// the calling thread.
///
/// The input image is decoded and resized to the requested pixel dimensions
/// (not resampled when it already has them), then partial alpha is composited
/// against `background_rgb` (packed `0xRRGGBB`). Fully transparent pixels
/// remain transparent. Encoding uses whole 6-pixel bands: a partial last band
/// is dropped, see [`band_rows`]. Prefer
/// [`encode_sixel_async`] unless the caller cannot wait: the decode, resize
/// and dither block the JS thread.
///
/// # Errors
/// Returns an error if decoding, resizing, or SIXEL encoding fails.
#[napi]
pub fn encode_sixel(
	bytes: Uint8Array,
	target_width_px: u32,
	target_height_px: u32,
	background_rgb: u32,
) -> Result<String> {
	encode_image(bytes.as_ref(), target_width_px, target_height_px, background_rgb)
}

/// Same result as [`encode_sixel`], but the decode, resize and dither run on
/// the native blocking pool, so they never stall the JavaScript event loop.
///
/// # Errors
/// Rejects if decoding, resizing, or SIXEL encoding fails.
#[napi]
pub fn encode_sixel_async(
	bytes: Uint8Array,
	target_width_px: u32,
	target_height_px: u32,
	background_rgb: u32,
) -> task::Promise<String> {
	let bytes = bytes.to_vec();
	task::blocking("sixel.encode", (), move |_| {
		encode_image(&bytes, target_width_px, target_height_px, background_rgb)
	})
}

fn encode_image(
	bytes: &[u8],
	target_width_px: u32,
	target_height_px: u32,
	background_rgb: u32,
) -> Result<String> {
	if target_width_px == 0 || target_height_px == 0 {
		return Err(Error::from_reason("Target SIXEL dimensions must be greater than zero"));
	}
	if background_rgb > 0xffffff {
		return Err(Error::from_reason("SIXEL background must be a packed 24-bit RGB color"));
	}

	let source = decode_image_from_bytes(bytes)?;
	let needs_resize = source.width() != target_width_px || source.height() != target_height_px;
	let premultiplied = needs_resize && source.color().has_alpha();
	let mut rgba = if premultiplied {
		// Alpha is coverage: 0 is invisible, 255 is opaque. Stored RGB can still
		// contain colors when alpha is zero. Before averaging neighboring pixels,
		// weight RGB by coverage ("premultiply"): half-visible red becomes
		// (128, 0, 0, 128), not (255, 0, 0, 128). This keeps hidden colors out of
		// visible edges. Reuse RGBA8 storage; leave the background out until
		// later.
		let mut rgba = source.into_rgba8();
		for pixel in rgba.pixels_mut() {
			let alpha = u32::from(pixel[3]);
			if alpha == 255 {
				continue;
			}
			for channel in &mut pixel.0[..3] {
				*channel = ((u32::from(*channel) * alpha + 127) / 255) as u8;
			}
		}
		// Resize coverage-weighted RGB and alpha with the same filter.
		image::imageops::resize(&rgba, target_width_px, target_height_px, FilterType::Lanczos3)
	} else if needs_resize {
		// Opaque formats need neither a full-size RGBA conversion nor
		// premultiplication.
		source
			.resize_exact(target_width_px, target_height_px, FilterType::Lanczos3)
			.into_rgba8()
	} else {
		source.into_rgba8()
	};
	let width = target_width_px as usize;
	let rows = band_rows(target_height_px) as usize;
	let background =
		[(background_rgb >> 16) & 0xff, (background_rgb >> 8) & 0xff, background_rgb & 0xff];
	for pixel in rgba.pixels_mut() {
		let alpha = u32::from(pixel[3]);
		// Keep holes transparent; opaque pixels need no background contribution.
		if alpha == 0 || alpha == 255 {
			continue;
		}
		// SIXEL supports only fully visible or fully transparent pixels. For
		// partial coverage, add the background's uncovered share:
		// RGB * alpha + background * (1 - alpha), with alpha normalized to 0..1.
		// Premultiplied RGB already includes alpha; multiplying it again would
		// darken edges. Only the unscaled, straight-RGB path still needs it.
		for channel in 0..3 {
			let foreground = u32::from(pixel[channel]);
			let covered = if premultiplied {
				// Lanczos can overshoot near sharp edges. A coverage-weighted
				// channel cannot exceed alpha (half-visible white is at most 128).
				foreground.min(alpha) * 255
			} else {
				foreground * alpha
			};
			// Alpha uses 0..255 here; +127 rounds the division to nearest.
			pixel[channel] = ((covered + background[channel] * (255 - alpha) + 127) / 255) as u8;
		}
		pixel[3] = 255;
	}
	Ok(codec::encode(&rgba.as_raw()[..width * rows * 4], width, rows))
}

/// Pixel rows of a `height_px` image that SIXEL can show without growing it.
///
/// SIXEL draws in 6-pixel bands and terminals size a partial last band as a
/// whole one, so an image whose height is not a multiple of 6 reaches up to
/// 5 pixels further down: past the bottom of its cell box, which then takes an
/// extra text row. Cropping that band instead of scaling the image keeps the
/// rest pixel-exact. An image shorter than one band keeps its rows.
const fn band_rows(height_px: u32) -> u32 {
	if height_px < 6 {
		height_px
	} else {
		height_px - height_px % 6
	}
}

fn decode_image_from_bytes(bytes: &[u8]) -> Result<DynamicImage> {
	let reader = ImageReader::new(Cursor::new(bytes))
		.with_guessed_format()
		.map_err(|e| Error::from_reason(format!("Failed to detect image format: {e}")))?;

	reader
		.decode()
		.map_err(|e| Error::from_reason(format!("Failed to decode image: {e}")))
}


