use std::{collections::BTreeMap, fmt::Write};

const IMAGE_WIDTH: f64 = 1200.0;
const PADDING: f64 = 10.0;
const FRAME_HEIGHT: usize = 16;
const MIN_SHARE: f64 = 0.001;

#[derive(Default)]
struct Frame<'a> {
	samples:  u64,
	children: BTreeMap<&'a str, Self>,
}

/// Render folded microsecond counts as a static, bottom-up Work Profile
/// flamegraph.
pub(super) fn generate(folded: &str) -> Option<String> {
	let mut root = Frame::default();
	let mut max_depth = 0;
	for line in folded
		.lines()
		.map(str::trim)
		.filter(|line| !line.is_empty())
	{
		let (stack, count) = line.rsplit_once(char::is_whitespace)?;
		let stack = stack.trim_end();
		if stack.is_empty() {
			return None;
		}
		let count = count.parse::<u64>().ok()?;
		if count == 0 {
			continue;
		}
		root.samples = root.samples.checked_add(count)?;
		let mut frame = &mut root;
		let mut depth = 0;
		for name in stack.split(';') {
			frame = frame.children.entry(name).or_default();
			frame.samples = frame.samples.checked_add(count)?;
			depth += 1;
		}
		max_depth = max_depth.max(depth);
	}
	if root.samples == 0 {
		return None;
	}

	let height = 40 + (max_depth + 1) * FRAME_HEIGHT + 30;
	let mut svg = String::new();
	write!(
		svg,
		"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1200\" height=\"{height}\" viewBox=\"0 0 \
		 1200 {height}\">\n<title>Work Profile</title>\n<rect width=\"1200\" height=\"{height}\" \
		 fill=\"#fff\"/>\n<text x=\"600\" y=\"24\" text-anchor=\"middle\" font-family=\"Verdana, \
		 sans-serif\" font-size=\"17\">Work Profile</text>\n<g font-family=\"Verdana, sans-serif\" \
		 font-size=\"12\">\n"
	)
	.unwrap();
	render_frame(&mut svg, "all", &root, 0, 0, max_depth, root.samples);
	svg.push_str("</g>\n</svg>\n");
	Some(svg)
}

fn render_frame(
	svg: &mut String,
	name: &str,
	frame: &Frame<'_>,
	start: u64,
	depth: usize,
	max_depth: usize,
	total: u64,
) {
	let share = frame.samples as f64 / total as f64;
	if share < MIN_SHARE {
		return;
	}
	let scale = 2.0f64.mul_add(-PADDING, IMAGE_WIDTH) / total as f64;
	let x = (start as f64).mul_add(scale, PADDING);
	let width = frame.samples as f64 * scale;
	let y = 40 + (max_depth - depth) * FRAME_HEIGHT;
	let (red, green, blue) = color(name);
	svg.push_str("<g><title>");
	escape_xml(svg, name);
	write!(svg, " ({} μs, {:.2}%)</title>", frame.samples, share * 100.0).unwrap();
	writeln!(
		svg,
		"<rect x=\"{x:.3}\" y=\"{y}\" width=\"{width:.3}\" height=\"15\" \
		 fill=\"rgb({red},{green},{blue})\"/>"
	)
	.unwrap();

	let label_width = ((width - 6.0) / 7.0).max(0.0) as usize;
	if label_width >= 3 {
		write!(svg, "<text x=\"{:.3}\" y=\"{}\">", x + 3.0, y + 12).unwrap();
		let mut chars = name.char_indices();
		let truncate_at = chars.nth(label_width - 2).map(|(index, _)| index);
		if chars.nth(1).is_some() {
			escape_xml(svg, &name[..truncate_at.unwrap()]);
			svg.push_str("..");
		} else {
			escape_xml(svg, name);
		}
		svg.push_str("</text>\n");
	}
	svg.push_str("</g>\n");

	let mut child_start = start;
	for (name, child) in &frame.children {
		render_frame(svg, name, child, child_start, depth + 1, max_depth, total);
		child_start += child.samples;
	}
}

fn color(name: &str) -> (u8, u8, u8) {
	// A fixed hash keeps frame colors stable across runs and input ordering.
	let hash = name.bytes().fold(0xcbf29ce484222325_u64, |hash, byte| {
		(hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
	});
	(205 + (hash % 50) as u8, 70 + ((hash >> 8) % 135) as u8, 20 + ((hash >> 16) % 50) as u8)
}

fn escape_xml(output: &mut String, value: &str) {
	for ch in value.chars() {
		match ch {
			'&' => output.push_str("&amp;"),
			'<' => output.push_str("&lt;"),
			'>' => output.push_str("&gt;"),
			'"' => output.push_str("&quot;"),
			'\'' => output.push_str("&apos;"),
			// Replace characters that XML 1.0 cannot represent, even as entities.
			ch if (ch < ' ' && !matches!(ch, '\t' | '\n' | '\r'))
				|| matches!(ch, '\u{fffe}' | '\u{ffff}') =>
			{
				output.push('\u{fffd}');
			},
			ch => output.push(ch),
		}
	}
}


