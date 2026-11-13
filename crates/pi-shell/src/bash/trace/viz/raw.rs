//! Original script rows, split only at source, syntax and style boundaries.
use super::{
	analysis::Analysis,
	model::{Layers, NodeKey, Options, Row, Segment},
	printer::source_map,
	runtime::{Runtime, VizSource},
};

struct Located {
	key:   NodeKey,
	range: [u32; 2],
	style: Option<String>,
}
#[derive(Debug)]
pub struct Static {
	rows: Vec<Row>,
}
pub fn render(
	source: &impl VizSource,
	runtime: &Runtime<'_>,
	options: &Options,
	analysis: &Analysis,
) -> Vec<Row> {
	let prepared = super::printer::raw_static(source, analysis, options.layers.color);
	project(&prepared, runtime, options, analysis)
}
pub(super) fn prepare(source: &impl VizSource, analysis: &Analysis, color: bool) -> Static {
	let mut owners = Vec::new();
	let mut colors = Vec::new();
	for index in 0..source.unit_count() {
		let Some(unit) = source.unit(index) else {
			continue;
		};
		let map = source_map(source, &unit);
		for (key, span) in &analysis.spans {
			if key.unit != unit.index || key.source != 0 {
				continue;
			}
			if let Some(range) = map.range(*span) {
				let Some(owner) = analysis.owners.get(key).copied() else {
					continue;
				};
				if owner == *key {
					owners.push(Located { key: *key, range, style: None });
				}
			}
		}
		for (key, span) in &analysis.heredocs {
			if key.unit == unit.index
				&& key.source == 0
				&& let Some(range) = map.range(*span)
			{
				owners.push(Located { key: *key, range, style: None });
			}
		}
		for (key, span, style) in &analysis.colors {
			if key.unit != unit.index || key.source != 0 || style == "kw" {
				continue;
			}
			if let Some(range) = map.range(*span) {
				colors.push(Located { key: *key, range, style: Some(style.clone()) });
			}
		}
	}
	owners.sort_unstable_by_key(|owner| (owner.range, owner.key));
	let bytes: &[u8] = source.script().as_ref();
	let script = String::from_utf8_lossy(bytes);
	trivia(&script, &owners, &mut colors);
	let layers = Layers { color, ..Layers::default() };
	let mut prepared = rows(&script, layers, &owners, &colors);
	for row in &mut prepared {
		let [lo, hi] = row.range.unwrap_or_default();
		for owner in &owners {
			if lo <= owner.range[0]
				&& owner.range[0] <= hi
				&& let Some(effects) = analysis.effects.get(&owner.key)
			{
				row.effects.extend(effects.iter().cloned());
			}
		}
	}
	Static { rows: prepared }
}
pub(super) fn project(
	prepared: &Static,
	runtime: &Runtime<'_>,
	options: &Options,
	analysis: &Analysis,
) -> Vec<Row> {
	let mut rows = prepared.rows.clone();
	for row in &mut rows {
		let mut metadata = None;
		for segment in &mut row.segments {
			let Some(safe_false) = decorate(segment, runtime, analysis) else {
				continue;
			};
			let key = segment.node.expect("decorated canonical leaf");
			if let Some(observation) = runtime.observation(key) {
				let state = segment.state.expect("decorated runtime state");
				if observation.execution_seq > row.execution_seq {
					row.execution_seq = observation.execution_seq;
					row.executed_at_ns = observation.executed_at_ns;
					row.state = Some(state);
				}
				if let Some(value) = super::printer::metadata(observation, safe_false, true) {
					metadata = Some(value);
				}
			}
		}
		row.active = Some(
			row.segments
				.iter()
				.any(|segment| segment.active == Some(true)),
		);
		row.meta = metadata;
		if !options.layers.effects {
			row.effects.clear();
		}
	}
	rows
}
/// Original quoted source with actual canonical leaf observations, without
/// projecting or scanning the rest of the script for each word.
pub fn literal(
	source: &impl VizSource,
	runtime: &Runtime<'_>,
	options: &Options,
	analysis: &Analysis,
	range: [u32; 2],
) -> Option<Vec<Segment>> {
	let prepared = super::printer::raw_static(source, analysis, options.layers.color);
	let mut segments = slice(&prepared, range)?;
	for segment in &mut segments {
		decorate(segment, runtime, analysis);
	}
	Some(segments)
}
fn decorate(segment: &mut Segment, runtime: &Runtime<'_>, analysis: &Analysis) -> Option<bool> {
	let key = segment.node?;
	let leaf = analysis.leaves.contains(&key);
	segment.active = Some(leaf && runtime.active(key));
	if !leaf {
		return None;
	}
	let observation = runtime.observation(key)?;
	let safe_false = analysis.guards.contains(&key)
		&& observation.status == Some(1)
		&& matches!(observation.resolved, None | Some(crate::bash::event::ResolvedKind::Intrinsic));
	segment.state = Some(if safe_false {
		crate::bash::trace::State::Ok
	} else {
		observation.state
	});
	segment.execution_node = Some(key);
	segment.executed_at_ns = observation.executed_at_ns;
	segment.execution_seq = observation.execution_seq;
	if let Some(status) = observation
		.status
		.filter(|status| *status != 0 && !safe_false)
	{
		segment.tip = Some(format!("exit {status}"));
	}
	Some(safe_false)
}
fn byte_at(text: &str, target: u32) -> Option<usize> {
	let mut units = 0;
	for (byte, ch) in text.char_indices() {
		if units == target {
			return Some(byte);
		}
		units += ch.len_utf16() as u32;
		if units > target {
			return None;
		}
	}
	(units == target).then_some(text.len())
}
fn slice(prepared: &Static, [lo, hi]: [u32; 2]) -> Option<Vec<Segment>> {
	let end = prepared.rows.last()?.range?[1];
	if lo > hi || hi > end {
		return None;
	}
	let first = prepared
		.rows
		.partition_point(|row| row.range.is_some_and(|range| range[1] < lo));
	let mut cursor = lo;
	let mut result = Vec::new();
	for (index, row) in prepared.rows.iter().enumerate().skip(first) {
		let [row_lo, row_hi] = row.range?;
		if row_lo > hi {
			break;
		}
		for segment in &row.segments {
			let [segment_lo, segment_hi] = segment.range?;
			if lo == hi && segment_lo <= lo && lo <= segment_hi {
				byte_at(&segment.text, lo - segment_lo)?;
				return Some(result);
			}
			let start = lo.max(segment_lo);
			let stop = hi.min(segment_hi);
			if start >= stop {
				continue;
			}
			if start != cursor {
				return None;
			}
			let a = byte_at(&segment.text, start - segment_lo)?;
			let b = byte_at(&segment.text, stop - segment_lo)?;
			result.push(Segment {
				text: segment.text[a..b].to_owned(),
				style: segment.style.clone(),
				node: segment.node,
				range: Some([start, stop]),
				..Segment::default()
			});
			cursor = stop;
		}
		if lo <= row_hi && row_hi < hi && index + 1 < prepared.rows.len() {
			if cursor != row_hi {
				return None;
			}
			result.push(Segment {
				text: "\n".into(),
				range: Some([row_hi, row_hi + 1]),
				..Segment::default()
			});
			cursor = row_hi + 1;
		}
		if cursor == hi {
			return Some(result);
		}
	}
	(cursor == hi).then_some(result)
}
// Trivia has no AST node identity. Protect canonical words before examining the
// gaps; any presentation owner remains an actual containing command.
fn trivia(script: &str, owners: &[Located], colors: &mut Vec<Located>) {
	let Some(fallback) = owners.first().map(|owner| owner.key) else {
		return;
	};
	let protected: Vec<[u32; 2]> = colors.iter().map(|color| color.range).collect();
	let mut offset = 0u32;
	for line in script.split('\n') {
		let mut iter = line
			.char_indices()
			.scan(offset, |at, (byte, ch)| {
				let start = *at;
				*at += ch.len_utf16() as u32;
				Some((byte, ch, start))
			})
			.peekable();
		while let Some((byte, ch, start)) = iter.next() {
			if protected
				.iter()
				.any(|range| range[0] <= start && start < range[1])
			{
				continue;
			}
			let mut end = start + ch.len_utf16() as u32;
			let style = if ch == '#' {
				// A hash starts a comment only at a token boundary.
				if byte != 0
					&& !line[..byte].ends_with(|c: char| c.is_whitespace() || ";|&()".contains(c))
				{
					continue;
				}
				end = offset + line.encode_utf16().count() as u32;
				while iter.next().is_some() {}
				"comment"
			} else if "|;&".contains(ch) {
				if let Some(&(next_byte, next, _)) = iter.peek()
					&& next == ch
					&& next_byte == byte + ch.len_utf8()
				{
					iter.next();
					end += 1;
				}
				"op"
			} else if ch.is_ascii_alphabetic() {
				let mut byte_end = byte + 1;
				while let Some(&(next_byte, next, _)) = iter.peek() {
					if next.is_ascii_alphanumeric() || next == '_' {
						iter.next();
						byte_end = next_byte + next.len_utf8();
						end += next.len_utf16() as u32;
					} else {
						break;
					}
				}
				if !matches!(
					&line[byte..byte_end],
					"for"
						| "in"
						| "do"
						| "done"
						| "if"
						| "then"
						| "else"
						| "elif"
						| "fi"
						| "case"
						| "esac"
						| "while"
						| "until"
						| "function"
						| "select"
				) {
					continue;
				}
				"kw"
			} else {
				continue;
			};
			let key = owners
				.iter()
				.filter(|owner| owner.range[0] <= start && owner.range[1] >= end)
				.min_by_key(|owner| owner.range[1] - owner.range[0])
				.map_or(fallback, |owner| owner.key);
			colors.push(Located { key, range: [start, end], style: Some(style.into()) });
		}
		offset += line.encode_utf16().count() as u32 + 1;
	}
}
fn rows(script: &str, layers: Layers, owners: &[Located], colors: &[Located]) -> Vec<Row> {
	let mut offset = 0u32;
	script
		.split('\n')
		.enumerate()
		.map(|(line, text)| {
			let lo = offset;
			let hi = lo + text.encode_utf16().count() as u32;
			offset = hi + 1;
			let mut marks = vec![lo, hi];
			for span in owners.iter().chain(colors) {
				for boundary in span.range {
					if boundary > lo && boundary < hi {
						marks.push(boundary);
					}
				}
			}
			marks.sort_unstable();
			marks.dedup();
			let boundaries: Vec<(u32, usize)> = text
				.char_indices()
				.scan(lo, |at, (byte, ch)| {
					let pair = (*at, byte);
					*at += ch.len_utf16() as u32;
					Some(pair)
				})
				.chain(std::iter::once((hi, text.len())))
				.collect();
			let mut segments = Vec::new();
			for pair in marks.windows(2) {
				let start = pair[0];
				let end = pair[1];
				let Some(a) = boundaries
					.iter()
					.find(|(at, _)| *at == start)
					.map(|(_, byte)| *byte)
				else {
					continue;
				};
				let Some(b) = boundaries
					.iter()
					.find(|(at, _)| *at == end)
					.map(|(_, byte)| *byte)
				else {
					continue;
				};
				let owner = owners
					.iter()
					.filter(|o| o.range[0] <= start && o.range[1] >= end)
					.min_by_key(|o| (o.range[1] - o.range[0], o.key));
				let style = colors
					.iter()
					.filter(|s| s.range[0] <= start && s.range[1] >= end)
					.min_by_key(|s| s.range[1] - s.range[0])
					.and_then(|s| s.style.as_deref());
				let style = style.and_then(|style| {
					let filtered = style
						.split_whitespace()
						.filter(|token| {
							layers.color || matches!(*token, "uncompiled" | "failure" | "structural")
						})
						.collect::<Vec<_>>()
						.join(" ");
					(!filtered.is_empty()).then_some(filtered)
				});
				segments.push(Segment {
					text: text[a..b].to_owned(),
					node: owner.map(|o| o.key),
					range: Some([start, end]),
					style,
					..Segment::default()
				});
			}
			Row {
				id: format!("raw-{line}"),
				range: Some([lo, hi]),
				role: Some("raw"),
				segments,
				..Row::default()
			}
		})
		.collect()
}

