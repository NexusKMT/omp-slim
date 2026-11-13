//! Windows command lines: an argument vector quoted so the child's C runtime
//! (`CommandLineToArgvW`, MSVCRT/UCRT `argv` parsing) recovers it exactly,
//! and the `cmd.exe /c` line that runs a batch file safely.
//!
//! Platform-neutral (UTF-16 output, tested everywhere); ported from std's
//! `sys::args::windows` (`append_arg`, `make_bat_command_line`) including
//! the batch-file hardening for CVE-2024-24576.

use bstr::{BStr, ByteSlice};

/// An argument vector Windows cannot represent.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum CmdlineError {
	/// Arguments are UTF-16 on Windows; the engine's bytes must be UTF-8.
	#[error("argument is not valid UTF-8: {arg}")]
	NotUtf8 {
		/// The argument, lossily decoded.
		arg: String,
	},
	/// NUL cannot appear in a command line.
	#[error("argument contains a NUL byte")]
	Nul,
	/// `argv[0]` is always quoted verbatim, so it cannot hold `"`.
	#[error("program name contains `\"`: {name}")]
	QuoteInProgram {
		/// The name.
		name: String,
	},
	/// A batch file name cannot contain `"` or end with `\`.
	#[error("batch file name contains `\"` or ends with `\\`: {name}")]
	BatchName {
		/// The name.
		name: String,
	},
	/// `cmd.exe` would end the command at a line break.
	#[error("batch file arguments cannot contain line breaks")]
	BatchNewline,
}

fn text(arg: &BStr) -> Result<&str, CmdlineError> {
	let s = arg
		.to_str()
		.map_err(|_| CmdlineError::NotUtf8 { arg: arg.to_str_lossy().into_owned() })?;
	if s.contains('\0') {
		return Err(CmdlineError::Nul);
	}
	Ok(s)
}

fn push_str(out: &mut Vec<u16>, s: &str) {
	out.extend(s.encode_utf16());
}

/// Append one argument with MSVCRT quoting: quoted when empty or holding a
/// blank (or always with `force_quotes`); backslashes doubled only before a
/// `"` (escaped as `\"`) and before the closing quote.
fn append_arg(out: &mut Vec<u16>, arg: &str, force_quotes: bool) {
	let quote = force_quotes || arg.is_empty() || arg.contains([' ', '\t']);
	if quote {
		out.push(u16::from(b'"'));
	}
	let mut backslashes = 0usize;
	for unit in arg.encode_utf16() {
		if unit == u16::from(b'\\') {
			backslashes += 1;
		} else {
			if unit == u16::from(b'"') {
				// 2n+1 backslashes in total before an embedded quote.
				out.extend(std::iter::repeat_n(u16::from(b'\\'), backslashes + 1));
			}
			backslashes = 0;
		}
		out.push(unit);
	}
	if quote {
		// 2n backslashes in total before the closing quote.
		out.extend(std::iter::repeat_n(u16::from(b'\\'), backslashes));
		out.push(u16::from(b'"'));
	}
}

/// The command line for `argv` (`argv[0]` first, always quoted), without a
/// trailing NUL.
pub fn command_line<A: AsRef<[u8]>>(argv: &[A]) -> Result<Vec<u16>, CmdlineError> {
	let mut out = Vec::new();
	let mut args = argv.iter();
	if let Some(prog) = args.next() {
		let prog = text(prog.as_ref().as_bstr())?;
		if prog.contains('"') {
			return Err(CmdlineError::QuoteInProgram { name: prog.to_owned() });
		}
		out.push(u16::from(b'"'));
		push_str(&mut out, prog);
		out.push(u16::from(b'"'));
	}
	for arg in args {
		out.push(u16::from(b' '));
		append_arg(&mut out, text(arg.as_ref().as_bstr())?, false);
	}
	Ok(out)
}

/// Append one batch-file argument: quoted when it holds anything `cmd.exe`
/// might interpret; `"` doubled; `%` and CR neutralized with the
/// `%%cd:~,%` no-op substring so `%VAR%` never expands.
fn append_bat_arg(out: &mut Vec<u16>, arg: &str) {
	// Unquoted ASCII known to be inert; everything else forces quotes. A
	// trailing `\` would escape the closing quote of `"%~1"` in the script.
	const UNQUOTED: &str = r"#$*+-./:?@\_";
	let quote = arg.is_empty()
		|| arg.ends_with('\\')
		|| arg.chars().any(|c| {
			(c.is_ascii() && !(c.is_ascii_alphanumeric() || UNQUOTED.contains(c))) || c.is_control()
		});
	if quote {
		out.push(u16::from(b'"'));
	}
	let mut backslashes = 0usize;
	for unit in arg.encode_utf16() {
		if unit == u16::from(b'\\') {
			backslashes += 1;
		} else {
			if unit == u16::from(b'"') {
				out.extend(std::iter::repeat_n(u16::from(b'\\'), backslashes));
				out.push(u16::from(b'"'));
			} else if unit == u16::from(b'%') || unit == u16::from(b'\r') {
				push_str(out, "%%cd:~,");
			}
			backslashes = 0;
		}
		out.push(unit);
	}
	if quote {
		out.extend(std::iter::repeat_n(u16::from(b'\\'), backslashes));
		out.push(u16::from(b'"'));
	}
}

/// The `cmd.exe` command line that runs batch file `script` with `args`:
/// `cmd.exe /e:ON /v:OFF /d /c ""script" args…"`. Run it with
/// `%SystemRoot%\System32\cmd.exe` as the application.
pub fn batch_command_line<A: AsRef<[u8]>>(
	script: &BStr,
	args: &[A],
) -> Result<Vec<u16>, CmdlineError> {
	let script = text(script)?;
	if script.contains('"') || script.ends_with('\\') {
		return Err(CmdlineError::BatchName { name: script.to_owned() });
	}
	let mut out = Vec::new();
	push_str(&mut out, "cmd.exe /e:ON /v:OFF /d /c \"\"");
	push_str(&mut out, script);
	out.push(u16::from(b'"'));
	for arg in args {
		let arg = text(arg.as_ref().as_bstr())?;
		if arg.contains(['\r', '\n']) {
			return Err(CmdlineError::BatchNewline);
		}
		out.push(u16::from(b' '));
		append_bat_arg(&mut out, arg);
	}
	out.push(u16::from(b'"'));
	Ok(out)
}

/// Whether `path` names a batch file (`.bat`/`.cmd`, any case), which
/// `CreateProcessW` runs through `cmd.exe`.
pub fn is_batch(path: &[u8]) -> bool {
	let ext = path.rfind_byte(b'.').map_or(&[][..], |i| &path[i + 1..]);
	ext.eq_ignore_ascii_case(b"bat") || ext.eq_ignore_ascii_case(b"cmd")
}


