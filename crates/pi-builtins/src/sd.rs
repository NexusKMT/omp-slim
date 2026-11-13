//! `sd` builtin: intuitive find & replace.
//!
//! Port of [sd](https://github.com/chmln/sd) 1.0.0. Every match of FIND — a
//! regex, or with `-F` a literal string — is replaced in each input taken as a
//! whole, so patterns may span lines (`sd '\n' ','`). Without file operands
//! stdin is filtered to stdout; with them each file is rewritten in place,
//! atomically, unless `--preview` prints the results instead.
//!
//! From upstream's development line since 1.0.0 it takes the lenient escape
//! handling in REPLACE_WITH and the uncoloured preview. Where upstream
//! misbehaves, this port deliberately differs:
//! - `-f w` wraps the whole pattern (`\b(?:…)\b`) and keeps the other flags;
//!   upstream rebuilt the regex there, dropping earlier flags and multi-line
//!   mode.
//! - `\xNN` and `\uNNNN` no longer swallow the character that follows them.
//! - Files without a change are left untouched rather than rewritten.
//! - `-A`/`--across` is accepted: newer upstream processes line by line unless
//!   given it, and this port always processes inputs whole.
//! - Diagnostics carry the `sd: ` prefix of the other builtins instead of
//!   `error: `, and name the file they concern.

use std::{
	borrow::Cow,
	ffi::OsString,
	io::{self, Read, Write},
	path::PathBuf,
};

use clap::Parser;
use regex::bytes::{NoExpand, Regex, RegexBuilder};

use crate::{
	atomic_write,
	host::{Host, Utility, strip_errno},
};

/// Parsed `sd` invocation.
#[derive(Parser)]
#[command(
	name = "sd",
	version = "1.0.0",
	about = "An intuitive find & replace CLI",
	max_term_width = 100,
	help_template = "\
{before-help}{name} v{version}
{about-with-newline}
{usage-heading} {usage}

{all-args}{after-help}"
)]
pub(crate) struct Sd {
	/// Display changes in a human reviewable format (the specifics of the
	/// format are likely to change in the future).
	#[arg(short, long)]
	preview: bool,

	/// Treat FIND and REPLACE_WITH args as literal strings
	#[arg(short = 'F', long = "fixed-strings", short_alias = 's', alias = "string-mode")]
	literal: bool,

	/// Limit the number of replacements that can occur per file. 0 indicates
	/// unlimited replacements.
	#[arg(short = 'n', long = "max-replacements", value_name = "LIMIT", default_value_t)]
	max_replacements: usize,

	/// Regex flags. May be combined (like `-f mc`).
	///
	/// c - case-sensitive
	///
	/// e - disable multi-line matching
	///
	/// i - case-insensitive
	///
	/// m - multi-line matching
	///
	/// s - make `.` match newlines
	///
	/// w - match full words only
	#[arg(short, long, verbatim_doc_comment)]
	flags: Option<String>,

	/// Accepted for scripts written against sd releases that process input
	/// line by line unless given it; inputs are always processed whole here.
	#[arg(short = 'A', long = "across", hide = true)]
	_across: bool,

	/// The regexp or string (if using `-F`) to search for.
	find: String,

	/// What to replace each match with. Unless in string mode, you may use
	/// captured values like $1, $2, etc.
	replace_with: String,

	/// The path to file(s). This is optional - sd can also read from STDIN.
	///
	/// Note: sd modifies files in-place by default. See documentation for
	/// examples.
	files: Vec<OsString>,
}

impl Utility for Sd {
	const NAME: &'static str = "sd";
	/// clap's usage-error status, which the standalone `sd` exits with.
	const USAGE_ERROR: u8 = 2;

	fn run(self, host: &mut Host) -> i32 {
		let replacer = match Replacer::new(&self) {
			Ok(replacer) => replacer,
			Err(message) => {
				host.error(message, 1);
				return 1;
			},
		};
		if self.files.is_empty() {
			filter_stdin(&replacer, host)
		} else if self.preview {
			preview_files(&replacer, &self.files, host)
		} else {
			edit_files(&replacer, &self.files, host)
		}
	}
}

/// FIND compiled under its flags, and the REPLACE_WITH substituted for it.
struct Replacer {
	regex:       Regex,
	/// Expanded through `$N`/`${name}` unless `literal`.
	replacement: Vec<u8>,
	literal:     bool,
	/// Replacements per input; 0 is unlimited.
	limit:       usize,
}

impl Replacer {
	/// # Errors
	///
	/// The diagnostic for an ambiguous capture reference in REPLACE_WITH (see
	/// [`check_captures`]) or a FIND that does not compile.
	fn new(cli: &Sd) -> Result<Self, String> {
		let (pattern, replacement) = if cli.literal {
			(Cow::Owned(regex::escape(&cli.find)), cli.replace_with.as_bytes().to_vec())
		} else {
			check_captures(&cli.replace_with)?;
			(Cow::Borrowed(cli.find.as_str()), unescape(&cli.replace_with).into_bytes())
		};
		let regex = build_regex(&pattern, cli.flags.as_deref().unwrap_or_default())
			.map_err(|err| err.to_string())?;
		Ok(Self { regex, replacement, literal: cli.literal, limit: cli.max_replacements })
	}

	/// `input` with up to `limit` matches replaced; borrowed when nothing
	/// matched.
	fn replace<'a>(&self, input: &'a [u8]) -> Cow<'a, [u8]> {
		if self.literal {
			self.regex.replacen(input, self.limit, NoExpand(&self.replacement))
		} else {
			self.regex.replacen(input, self.limit, self.replacement.as_slice())
		}
	}
}

/// Compiles `pattern` under sd's `-f` flags, applied in order so a later flag
/// overrides an earlier one: multi-line by default; `c`/`i` set case
/// sensitivity, `e` disables multi-line, `s` lets `.` match newlines (and
/// disables multi-line unless `m` is also given), `w` matches whole words.
/// Unknown flags are ignored, as upstream does.
fn build_regex(pattern: &str, flags: &str) -> Result<Regex, regex::Error> {
	let words;
	let pattern = if flags.contains('w') {
		words = format!(r"\b(?:{pattern})\b");
		&words
	} else {
		pattern
	};
	let mut builder = RegexBuilder::new(pattern);
	builder.multi_line(true);
	for flag in flags.chars() {
		match flag {
			'c' => {
				builder.case_insensitive(false);
			},
			'i' => {
				builder.case_insensitive(true);
			},
			'e' => {
				builder.multi_line(false);
			},
			's' => {
				if !flags.contains('m') {
					builder.multi_line(false);
				}
				builder.dot_matches_new_line(true);
			},
			_ => {},
		}
	}
	builder.build()
}

/// Rejects a numbered capture reference followed by name characters
/// (`$1bad`): the regex crate reads it as the named group `1bad`, which never
/// exists, so it would silently expand to nothing. `$$` and braced references
/// (`${1}bad`) are never ambiguous.
///
/// # Errors
///
/// The first ambiguous reference, rendered by [`ambiguous_capture`].
fn check_captures(replacement: &str) -> Result<(), String> {
	let bytes = replacement.as_bytes();
	let mut at = 0;
	while let Some(offset) = memchr::memchr(b'$', &bytes[at..]) {
		let start = at + offset + 1;
		at = start;
		match bytes.get(start) {
			Some(b'$') => at += 1,
			// Without a closing brace the `{` is literal text.
			Some(b'{') => {
				if let Some(close) = memchr::memchr(b'}', &bytes[start..]) {
					at += close + 1;
				}
			},
			_ => {
				let name = bytes[start..]
					.iter()
					.take_while(|&&b| b == b'_' || b.is_ascii_alphanumeric())
					.count();
				let digits = bytes[start..start + name].iter().take_while(|b| b.is_ascii_digit()).count();
				if digits > 0 && digits < name {
					return Err(ambiguous_capture(replacement, start, name, digits));
				}
				at += name;
			},
		}
	}
	Ok(())
}

/// Upstream's diagnostic for the reference `replacement[start..start + len]`,
/// whose first `digits` bytes are the group number: the replacement on one
/// line with carets under the reference, and the braced spelling as a hint.
fn ambiguous_capture(replacement: &str, start: usize, len: usize, digits: usize) -> String {
	let (number, rest) = replacement[start..start + len].split_at(digits);
	// Line breaks and tabs show as one-column Control Pictures, keeping the
	// replacement on one line and the carets under the reference.
	let shown: String = replacement
		.chars()
		.map(|c| match c {
			'\n' => '␊',
			'\r' => '␍',
			'\t' => '␉',
			c => c,
		})
		.collect();
	let column = replacement[..start].chars().count();
	format!(
		"The numbered capture group `${number}` in the replacement text is ambiguous.\nhint: Use \
		 curly braces to disambiguate it `${{{number}}}{rest}`.\n{shown}\n{:column$}{}",
		"",
		"^".repeat(len)
	)
}

/// Expands the escapes sd recognises in REPLACE_WITH (`\n`, `\r`, `\t`, `\'`,
/// `\"`, `\\`, `\xNN`, `\uNNNN`). Any other backslash, including one starting
/// a malformed `\x`/`\u`, stays as written.
fn unescape(input: &str) -> String {
	let mut out = String::with_capacity(input.len());
	let mut rest = input;
	while let Some(at) = rest.find('\\') {
		out.push_str(&rest[..at]);
		let escape = &rest[at + 1..];
		let (expanded, len) = match escape.as_bytes().first() {
			Some(b'n') => (Some('\n'), 1),
			Some(b'r') => (Some('\r'), 1),
			Some(b't') => (Some('\t'), 1),
			Some(&quoted @ (b'\'' | b'"' | b'\\')) => (Some(char::from(quoted)), 1),
			Some(b'x') => (hex_char(&escape[1..], 2), 3),
			Some(b'u') => (hex_char(&escape[1..], 4), 5),
			_ => (None, 0),
		};
		match expanded {
			Some(c) => {
				out.push(c);
				rest = &escape[len..];
			},
			None => {
				out.push('\\');
				rest = escape;
			},
		}
	}
	out.push_str(rest);
	out
}

/// The character whose code is the `digits` hex digits starting `s`.
fn hex_char(s: &str, digits: usize) -> Option<char> {
	let hex = s.get(..digits).filter(|hex| hex.bytes().all(|b| b.is_ascii_hexdigit()))?;
	char::from_u32(u32::from_str_radix(hex, 16).ok()?)
}

/// Replaces across all of stdin and writes the result to stdout.
fn filter_stdin(replacer: &Replacer, host: &mut Host) -> i32 {
	let mut input = Vec::new();
	if let Err(err) = host.stdin.read_to_end(&mut input) {
		host.error(format_args!("stdin: {}", strip_errno(&err)), 1);
		return 1;
	}
	let output = replacer.replace(&input);
	match host.stdout.write_all(&output).and_then(|()| host.stdout.flush()) {
		Ok(()) => 0,
		Err(err) => stdout_failed(host, &err),
	}
}

/// Prints each file's replaced contents, under a `----- FILE <path> -----`
/// header when there are several, leaving the files untouched. An unreadable
/// file is reported and skipped.
fn preview_files(replacer: &Replacer, files: &[OsString], host: &mut Host) -> i32 {
	let mut out = host.stdout_writer();
	for file in files {
		if host.is_cancelled() {
			return 130;
		}
		let input = match host.fs().read(host.resolve(file)) {
			Ok(input) => input,
			Err(err) => {
				host.error(format_args!("{}: {}", file.display(), strip_errno(&err)), 1);
				continue;
			},
		};
		let header = if files.len() > 1 {
			writeln!(out, "----- FILE {} -----", file.display())
		} else {
			Ok(())
		};
		if let Err(err) = header.and_then(|()| out.write_all(&replacer.replace(&input))) {
			return stdout_failed(host, &err);
		}
	}
	if let Err(err) = out.flush() {
		return stdout_failed(host, &err);
	}
	host.exit_code()
}

/// Rewrites each file whose contents change, in place. Every file is read
/// and replaced before any is written, so an unreadable operand leaves all of
/// them untouched. A symlink operand has its target edited and stays a link.
fn edit_files(replacer: &Replacer, files: &[OsString], host: &mut Host) -> i32 {
	let mut edits: Vec<(&OsString, PathBuf, Vec<u8>)> = Vec::new();
	for file in files {
		if host.is_cancelled() {
			return 130;
		}
		let path = host.resolve(file);
		match host.fs().read(&path) {
			Ok(input) => {
				if let Cow::Owned(output) = replacer.replace(&input)
					&& output != input
				{
					edits.push((file, path, output));
				}
			},
			Err(err) => host.error(format_args!("{}: {}", file.display(), strip_errno(&err)), 1),
		}
	}
	if host.exit_code() != 0 {
		return host.exit_code();
	}
	for (file, path, output) in edits {
		if host.is_cancelled() {
			return 130;
		}
		let fs = host.fs();
		let written = fs
			.canonicalize(&path)
			.and_then(|target| atomic_write::replace(fs, &target, &output, Sd::NAME));
		if let Err(err) = written {
			host.error(format_args!("{}: {}", file.display(), strip_errno(&err)), 1);
		}
	}
	host.exit_code()
}

/// Reports a failed stdout write, unless a closed reader already ended the
/// utility (the adapter then reports the SIGPIPE status).
fn stdout_failed(host: &mut Host, err: &io::Error) -> i32 {
	if !host.sigpipe_hit() {
		host.error(format_args!("stdout: {}", strip_errno(err)), 1);
	}
	1
}


