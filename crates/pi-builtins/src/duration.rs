//! GNU duration operands (`sleep 1.5m`), shared with the embedding shell's
//! `timeout`.

use std::time::Duration;

/// Parses a GNU-style duration: a decimal number with an optional `s`/`m`/`h`/`d`
/// suffix, as accepted by `sleep` and `timeout`.
///
/// GNU also accepts `inf`/`infinity` (optionally signed `+`, any case);
/// infinite and overflowing values saturate to [`Duration::MAX`]. Callers
/// treat such durations as "sleep until cancelled". Sub-millisecond precision
/// is preserved: GNU `sleep 0.0001` really sleeps 100 microseconds.
#[must_use]
pub fn parse_duration(input: &str) -> Option<Duration> {
	let trimmed = input.trim();
	if trimmed.is_empty() {
		return None;
	}
	let unsigned = trimmed.strip_prefix('+').unwrap_or(trimmed);
	if unsigned.eq_ignore_ascii_case("inf") || unsigned.eq_ignore_ascii_case("infinity") {
		return Some(Duration::MAX);
	}
	let (number, multiplier) = match trimmed.chars().last()? {
		's' => (&trimmed[..trimmed.len() - 1], 1.0),
		'm' => (&trimmed[..trimmed.len() - 1], 60.0),
		'h' => (&trimmed[..trimmed.len() - 1], 3600.0),
		'd' => (&trimmed[..trimmed.len() - 1], 86400.0),
		ch if ch.is_ascii_alphabetic() => return None,
		_ => (trimmed, 1.0),
	};
	let value = number.parse::<f64>().ok()?;
	if value.is_nan() || value.is_sign_negative() {
		return None;
	}
	if value.is_infinite() {
		return Some(Duration::MAX);
	}
	// Only overflow remains once NaN and negatives are excluded; saturate.
	Duration::try_from_secs_f64(value * multiplier).map_or(Some(Duration::MAX), Some)
}


