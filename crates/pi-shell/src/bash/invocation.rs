//! bash's command line and the startup files a new shell sources.
//!
//! The grammar is `bash [GNU long option] [option] … [-c command [name
//! [arg …]] | script-file [arg …]]`, parsed as shell.c does
//! (`parse_long_options`, then `parse_shell_options`) with bash 5.3's exact
//! messages; the startup files follow `run_startup_files`.
//!
//! obash parses its own arguments with [`ShellArgs::parse`]; the engine
//! parses the arguments of a nested `bash`/`sh`
//! ([`crate::bash::Resolved::SelfShell`]) the same way, so both start their
//! shell from one description.

use std::borrow::Cow;

use bstr::{BStr, BString};

use crate::bash::{
	ids::{Dialect, ModeId},
	store::{OptId, OptKind},
	zshopt::ZshOpt,
};

/// bash 5.3's GNU long options in its `long_args` order (the usage message
/// lists them so). `--dump-po-strings` and `--dump-strings` are parsed and
/// refused ([`InvocationError::Unsupported`]).
pub const LONG_OPTIONS: [&str; 16] = [
	"debug",
	"debugger",
	"dump-po-strings",
	"dump-strings",
	"help",
	"init-file",
	"login",
	"noediting",
	"noprofile",
	"norc",
	"posix",
	"pretty-print",
	"rcfile",
	"restricted",
	"verbose",
	"version",
];

/// The file bash's `--debugger` sources (bashdb's `DEBUGGER_START_FILE`).
pub const DEBUGGER_START_FILE: &str = "/usr/local/share/bashdb/bashdb-main.inc";

/// The system profile a login shell sources first (`SYS_PROFILE`).
pub const SYS_PROFILE: &str = "/etc/profile";

/// bash's `PATH` when the environment has none (`DEFAULT_PATH_VALUE`).
pub const DEFAULT_PATH: &str = "/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:.";

/// [`DEFAULT_PATH`] joined with the shell's `$PATH` separator.
pub const fn default_path(platform: crate::bash::ids::Platform) -> &'static str {
	if matches!(platform, crate::bash::ids::Platform::Windows) {
		"/usr/local/bin;/usr/local/sbin;/usr/bin;/usr/sbin;/bin;/sbin;."
	} else {
		DEFAULT_PATH
	}
}

/// `bash -o` / `bash -O` as the last argument: bash lists the options (the
/// values at that point of the parse) and goes on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Listing {
	/// `-o` (`+o`: as `set` commands).
	Set {
		/// `+o`.
		reusable: bool,
	},
	/// `-O` (`+O`: as `shopt` commands).
	Shopt {
		/// `+O`.
		reusable: bool,
	},
}

/// Where the shell reads its commands.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Input {
	/// `-c command`.
	Command(BString),
	/// The script-file operand, as given.
	Script(BString),
	/// Standard input (no operand, or `-s`).
	Stdin,
}

/// A parsed bash command line: what [`ShellArgs::parse`] returns to obash
/// and to the engine's in-engine nested shell.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShellArgs {
	/// `argv[0]` as given: the prefix of invocation errors.
	pub shell_name:   BString,
	/// `$0`: `argv[0]`, the name after `-c command`, or the script.
	pub dollar0:      BString,
	/// `$0` came from the arguments (a script, or a name after `-c
	/// command`), not from `argv[0]`.
	pub named:        bool,
	/// Where the commands come from.
	pub input:        Input,
	/// The positional parameters.
	pub args:         Vec<BString>,
	/// `-i`.
	pub interactive:  bool,
	/// `-l` / `--login`: login startup files even when not interactive.
	pub login_flag:   bool,
	/// `argv[0]` starts with `-` (a login shell by name).
	pub login_name:   bool,
	/// Invoked as `sh` (`argv[0]`'s base name): posix mode after the
	/// startup files, `ENV` instead of `~/.bashrc`.
	pub sh:           bool,
	/// `--posix`.
	pub posix:        bool,
	/// `set` flags and `-o` names, in order.
	pub options:      Vec<(OptId, bool)>,
	/// `-O`/`+O` shopt names, in order (bash applies them after the
	/// `set` options).
	pub shopts:       Vec<(OptId, bool)>,
	/// `-o`/`-O` without a name.
	pub listing:      Option<Listing>,
	/// `--rcfile`/`--init-file`.
	pub rcfile:       Option<BString>,
	/// `--norc`.
	pub norc:         bool,
	/// `--noprofile`.
	pub noprofile:    bool,
	/// `--pretty-print`: print the script's commands instead of running.
	pub pretty_print: bool,
	/// `--debugger`.
	pub debugger:     bool,
	/// `--help`: print the long usage and exit.
	pub help:         bool,
	/// `--version`: print the version and exit.
	pub version:      bool,
	/// The mode the shell starts in: from `argv[0]`'s base name (`zsh`,
	/// `ksh`; `sh` is bash's posix mode) or a leading `--emulate MODE` /
	/// `--emulate=MODE`.
	pub mode:         ModeId,
	/// zsh dialect: the options the command line set (zsh `parseopts`), in
	/// order, after the emulation's defaults.
	pub zsh_options:  Vec<(ZshOpt, bool)>,
}

/// An invocation bash rejects (it exits with status 2).
#[derive(Debug, thiserror::Error)]
pub enum InvocationError {
	/// An unknown `--long` option (the usage follows).
	#[error("{arg}: invalid option")]
	InvalidLong {
		/// The argument as given.
		arg: BString,
	},
	/// An unknown option letter (the usage follows).
	#[error("{}{}: invalid option", char::from(*.sign), char::from(*.letter))]
	InvalidFlag {
		/// `-` or `+`.
		sign:   u8,
		/// The letter.
		letter: u8,
	},
	/// `-c`, `--rcfile` or `--init-file` without its argument.
	#[error("{name}: option requires an argument")]
	MissingArgument {
		/// `-c`, `rcfile`, `init-file`.
		name: Cow<'static, str>,
	},
	/// `-o name` for an unknown `set -o` name (bash's builtin error, with
	/// line 0 and the shell as the command).
	#[error("line 0: {shell}: {name}: invalid option name")]
	InvalidSetName {
		/// `argv[0]`.
		shell: BString,
		/// The name given.
		name:  BString,
	},
	/// `-O name` for an unknown shopt name.
	#[error("line 0: {name}: invalid shell option name")]
	InvalidShoptName {
		/// The name given.
		name: BString,
	},
	/// Valid bash this engine does not implement (restricted mode,
	/// translatable-string dumps).
	#[error("{what}: not supported by this engine yet")]
	Unsupported {
		/// What.
		what: Cow<'static, str>,
	},
	/// A zsh command line zsh rejects (`no such option: X`, `bad option:
	/// -X`, `string expected after -o`, …); zsh exits with status 1.
	#[error("{msg}")]
	Zsh {
		/// zsh's message.
		msg: String,
	},
}

impl InvocationError {
	/// bash's exit status for an invocation error (`EX_BADUSAGE`).
	pub const STATUS: i32 = 2;

	/// The exit status for this error: bash's 2, zsh's 1.
	pub const fn status(&self) -> i32 {
		if matches!(self, Self::Zsh { .. }) {
			1
		} else {
			Self::STATUS
		}
	}

	/// The complete stderr text: `NAME: message`, plus the usage after an
	/// invalid option.
	pub fn render(&self, shell_name: &[u8]) -> Vec<u8> {
		let mut out = Vec::with_capacity(64);
		out.extend_from_slice(shell_name);
		out.extend_from_slice(b": ");
		out.extend_from_slice(self.to_string().as_bytes());
		out.push(b'\n');
		if matches!(self, Self::InvalidLong { .. } | Self::InvalidFlag { .. }) {
			out.extend_from_slice(&usage(shell_name));
		}
		out
	}
}

/// The mode `--emulate NAME` starts: zsh's `emulate` picks by first letter
/// (`r`-prefixed names skip it; `c`sh, `k`sh, `s`h and `b`ash (its sh
/// emulation), anything else zsh). obash adds `bash` itself when the shell
/// is not started as zsh (`zsh` is false).
const fn emulated_mode(name: &[u8], zsh: bool) -> ModeId {
	if !zsh {
		match name {
			b"bash" => return ModeId::Bash,
			b"sh" => return ModeId::Sh,
			_ => {},
		}
	}
	let c = match name {
		[b'r', c, ..] => *c,
		[c, ..] => *c,
		[] => 0,
	};
	match c {
		b'c' => ModeId::ZshCsh,
		b'k' => ModeId::Ksh,
		b's' | b'b' => ModeId::ZshSh,
		_ => ModeId::Zsh,
	}
}

/// The base name of `path` (after the last `/`).
fn base_name(path: &[u8]) -> &[u8] {
	path
		.iter()
		.rposition(|&c| c == b'/')
		.map_or(path, |i| &path[i + 1..])
}

/// The `set` option of flag letter `c` (bash's `shell_flags` table, without
/// `i` and `r`, which describe the invocation).
fn flag_option(c: u8) -> Option<OptId> {
	use strum::IntoEnumIterator;
	OptId::iter().find(|o| o.kind() == OptKind::Set && o.flag() == Some(c))
}

/// The `set -o` option called `name`.
fn set_option(name: &[u8]) -> Option<OptId> {
	OptId::from_name(name).filter(|o| o.kind() == OptKind::Set)
}

impl ShellArgs {
	/// Parse `argv` (`argv[0]` first) as bash 5.3 does. `--help` and
	/// `--version` end the parse (bash acts on them before the
	/// single-letter options).
	///
	/// # Errors
	///
	/// [`InvocationError`] for what bash rejects, in bash's order: long
	/// options, then letters and `-o` names, then a missing `-c` command,
	/// then `-O` names.
	pub fn parse(argv: &[BString]) -> Result<Self, InvocationError> {
		Self::parse_exe(argv, b"")
	}

	/// [`Self::parse`] for the executable at `exe`: when its base name is
	/// `zsh`, the shell is zsh whatever `argv[0]` says (`exec -a NAME zsh`),
	/// emulating by the first letter of `NAME` (zsh `emulate(zsh_name)`).
	///
	/// # Errors
	///
	/// As [`Self::parse`].
	pub fn parse_exe(argv: &[BString], exe: &[u8]) -> Result<Self, InvocationError> {
		let argv0 = argv
			.first()
			.cloned()
			.unwrap_or_else(|| BString::from("bash"));
		let base = base_name(&argv0);
		let base = base.strip_prefix(b"-").unwrap_or(base);
		// zsh's `--emulate MODE` must come first (zsh `parseopts`);
		// `--emulate=MODE` is obash's spelling of it.
		let emulate = match argv.get(1).map(|a| a.as_slice()) {
			Some(b"--emulate") => Some((
				argv
					.get(2)
					.ok_or_else(|| InvocationError::Zsh { msg: "--emulate: argument required".into() })?
					.as_slice(),
				3,
			)),
			Some(a) => a.strip_prefix(b"--emulate=").map(|m| (m, 2)),
			None => None,
		};
		let name_mode = match base {
			b"zsh" => Some(ModeId::Zsh),
			b"ksh" => Some(ModeId::Ksh),
			_ if base_name(exe) == b"zsh" => Some(emulated_mode(base, true)),
			_ => None,
		};
		let (mode, first) = match emulate {
			Some((name, first)) => (emulated_mode(name, name_mode.is_some()), first),
			None => (name_mode.unwrap_or(ModeId::Bash), 1),
		};
		if mode.dialect() == Dialect::Zsh {
			return Self::parse_zsh(argv, argv0, mode, first);
		}
		if first > 1 {
			let mut rest = vec![argv0];
			rest.extend_from_slice(&argv[first..]);
			let mut a = Self::parse(&rest)?;
			if mode == ModeId::Sh {
				a.sh = true;
				a.mode = ModeId::Sh;
			}
			return Ok(a);
		}
		let mut a = Self {
			shell_name:   argv0.clone(),
			dollar0:      argv0.clone(),
			named:        false,
			input:        Input::Stdin,
			args:         Vec::new(),
			interactive:  false,
			login_flag:   false,
			login_name:   argv0.first() == Some(&b'-'),
			sh:           base == b"sh",
			posix:        false,
			options:      Vec::new(),
			shopts:       Vec::new(),
			listing:      None,
			rcfile:       None,
			norc:         false,
			noprofile:    false,
			pretty_print: false,
			debugger:     false,
			help:         false,
			version:      false,
			mode:         if base == b"sh" {
				ModeId::Sh
			} else {
				ModeId::Bash
			},
			zsh_options:  Vec::new(),
		};
		if base == b"rbash" {
			return Err(InvocationError::Unsupported { what: Cow::Borrowed("restricted mode") });
		}
		let mut i = 1;
		// `parse_long_options`: `--name` and `-name` (a long name after one
		// dash counts too); an unknown `--name` is an error, an unknown
		// `-x` starts the letters.
		while let Some(arg) = argv.get(i) {
			if arg.first() != Some(&b'-') {
				break;
			}
			let long = arg.len() > 2 && arg[1] == b'-';
			let name = if long { &arg[2..] } else { &arg[1..] };
			let Some(&opt) = LONG_OPTIONS.iter().find(|l| l.as_bytes() == name) else {
				if long {
					return Err(InvocationError::InvalidLong { arg: arg.clone() });
				}
				break;
			};
			match opt {
				"init-file" | "rcfile" => {
					i += 1;
					let value = argv
						.get(i)
						.ok_or(InvocationError::MissingArgument { name: Cow::Borrowed(opt) })?;
					a.rcfile = Some(value.clone());
				},
				"dump-po-strings" | "dump-strings" => {
					return Err(InvocationError::Unsupported { what: Cow::Owned(format!("--{opt}")) });
				},
				"restricted" => {
					return Err(InvocationError::Unsupported { what: Cow::Borrowed("restricted mode") });
				},
				"debugger" => a.debugger = true,
				"help" => a.help = true,
				"login" => a.login_flag = true,
				"noprofile" => a.noprofile = true,
				"norc" => a.norc = true,
				"posix" => a.posix = true,
				"pretty-print" => a.pretty_print = true,
				"verbose" => a.options.push((OptId::Verbose, true)),
				"version" => a.version = true,
				// `--debug` sets an unused variable; `--noediting` matters to
				// line editing only.
				_ => {},
			}
			i += 1;
		}
		if a.help || a.version {
			return Ok(a);
		}
		// `parse_shell_options`: letter groups; `-o`/`-O` take the next
		// argument; `-` and `--` end the options.
		let mut command = false;
		let mut read_stdin = false;
		let mut shopt_names: Vec<(BString, bool)> = Vec::new();
		while let Some(arg) = argv.get(i) {
			let Some(&sign @ (b'-' | b'+')) = arg.first() else {
				break;
			};
			let mut next = i + 1;
			if sign == b'-' && matches!(&arg[1..], b"" | b"-") {
				i = next;
				break;
			}
			let on = sign == b'-';
			for &c in &arg[1..] {
				match c {
					b'c' => command = true,
					b'l' => a.login_flag = true,
					b's' => read_stdin = true,
					b'i' => a.interactive = on,
					b'r' => {
						if on {
							return Err(InvocationError::Unsupported {
								what: Cow::Borrowed("restricted mode"),
							});
						}
					},
					b'D' => {
						return Err(InvocationError::Unsupported { what: Cow::Borrowed("-D") });
					},
					b'o' => match argv.get(next) {
						None => a.listing = Some(Listing::Set { reusable: !on }),
						Some(name) => {
							let opt = set_option(name).ok_or_else(|| InvocationError::InvalidSetName {
								shell: argv0.clone(),
								name:  name.clone(),
							})?;
							a.options.push((opt, on));
							next += 1;
						},
					},
					b'O' => match argv.get(next) {
						None => a.listing = Some(Listing::Shopt { reusable: !on }),
						Some(name) => {
							shopt_names.push((name.clone(), on));
							next += 1;
						},
					},
					_ => {
						let opt =
							flag_option(c).ok_or(InvocationError::InvalidFlag { sign, letter: c })?;
						a.options.push((opt, on));
					},
				}
			}
			i = next;
		}
		let rest = &argv[i.min(argv.len())..];
		if command {
			let (cmd, rest) = rest
				.split_first()
				.ok_or(InvocationError::MissingArgument { name: Cow::Borrowed("-c") })?;
			a.input = Input::Command(cmd.clone());
			if let Some((name, args)) = rest.split_first() {
				a.dollar0 = name.clone();
				a.named = true;
				a.args = args.to_vec();
			}
		} else if !read_stdin && let Some((script, args)) = rest.split_first() {
			a.input = Input::Script(script.clone());
			a.dollar0 = script.clone();
			a.named = true;
			a.args = args.to_vec();
		} else {
			a.args = rest.to_vec();
		}
		for (name, on) in shopt_names {
			let opt = OptId::from_name(&name)
				.filter(|o| o.kind() == OptKind::Shopt)
				.ok_or(InvocationError::InvalidShoptName { name })?;
			a.shopts.push((opt, on));
		}
		Ok(a)
	}

	/// zsh 5.9 `parseargs`/`parseopts` for a shell starting in zsh-dialect
	/// `mode`; `argv[first..]` are the arguments after `--emulate`.
	fn parse_zsh(
		argv: &[BString],
		argv0: BString,
		mode: ModeId,
		first: usize,
	) -> Result<Self, InvocationError> {
		let zerr = |msg: String| InvocationError::Zsh { msg };
		let mut a = Self {
			shell_name: argv0.clone(),
			dollar0: argv0.clone(),
			named: false,
			input: Input::Stdin,
			args: Vec::new(),
			interactive: false,
			login_flag: false,
			login_name: argv0.first() == Some(&b'-'),
			sh: false,
			posix: false,
			options: Vec::new(),
			shopts: Vec::new(),
			listing: None,
			rcfile: None,
			norc: false,
			noprofile: false,
			pretty_print: false,
			debugger: false,
			help: false,
			version: false,
			mode,
			zsh_options: Vec::new(),
		};
		let mut i = first;
		let mut command = false;
		let mut stdin = false;
		'args: while let Some(arg) = argv.get(i) {
			let Some(&sign @ (b'-' | b'+')) = arg.first() else {
				break;
			};
			let on = sign == b'-';
			if arg.len() == 1 || arg.as_slice() == b"--" {
				i += 1;
				break;
			}
			if let Some(long) = arg.strip_prefix(b"--") {
				match long {
					b"version" => {
						a.version = true;
						return Ok(a);
					},
					b"help" => {
						a.help = true;
						return Ok(a);
					},
					b"emulate" => {
						return Err(zerr("--emulate: must precede other options".into()));
					},
					_ => {
						let name: Vec<u8> = long
							.iter()
							.map(|&ch| if ch == b'-' { b'_' } else { ch })
							.collect();
						let (opt, inv) = ZshOpt::lookup(&name).ok_or_else(|| {
							zerr(format!("no such option: {}", String::from_utf8_lossy(&name)))
						})?;
						a.zsh_options.push((opt, on != inv));
						i += 1;
						continue;
					},
				}
			}
			let mut next = i + 1;
			let mut at = 1;
			while at < arg.len() {
				let ch = arg[at];
				match ch {
					b'b' => {
						i = next;
						break 'args;
					},
					b'c' => command = true,
					// The rest of the argument, or the next one, names the
					// option; nothing after it in this argument is read.
					b'o' => {
						let name = if at + 1 < arg.len() {
							arg[at + 1..].to_vec()
						} else {
							let next_arg = argv
								.get(next)
								.ok_or_else(|| zerr("string expected after -o".into()))?
								.to_vec();
							next += 1;
							next_arg
						};
						let (opt, inv) = ZshOpt::lookup(&name).ok_or_else(|| {
							zerr(format!("no such option: {}", String::from_utf8_lossy(&name)))
						})?;
						a.zsh_options.push((opt, on != inv));
						break;
					},
					ch if ch.is_ascii_whitespace() => {
						if !arg[at..].iter().all(u8::is_ascii_whitespace) {
							return Err(zerr(format!(
								"bad option string: '{}'",
								String::from_utf8_lossy(arg)
							)));
						}
						break;
					},
					_ => {
						let (opt, inv) = ZshOpt::letter(ch, mode)
							.ok_or_else(|| zerr(format!("bad option: -{}", char::from(ch))))?;
						let value = on != inv;
						match opt {
							ZshOpt::Interactive => a.interactive = value,
							ZshOpt::Login => a.login_flag = value,
							ZshOpt::Shinstdin => stdin = value,
							_ => {},
						}
						a.zsh_options.push((opt, value));
					},
				}
				at += 1;
			}
			i = next;
		}
		let rest = &argv[i.min(argv.len())..];
		if command {
			let (cmd, rest) = rest
				.split_first()
				.ok_or_else(|| zerr("string expected after -c".into()))?;
			a.input = Input::Command(cmd.clone());
			if let Some((name, args)) = rest.split_first() {
				a.dollar0 = name.clone();
				a.named = true;
				a.args = args.to_vec();
			}
		} else if !stdin && let Some((script, args)) = rest.split_first() {
			a.input = Input::Script(script.clone());
			a.dollar0 = script.clone();
			a.named = true;
			a.args = args.to_vec();
		} else {
			a.args = rest.to_vec();
		}
		Ok(a)
	}

	/// Whether the shell is interactive: `-i`, or no `-c`, no script and
	/// both stdin and stderr on a terminal (`ttys`).
	pub const fn is_interactive(&self, ttys: bool) -> bool {
		self.interactive || (matches!(self.input, Input::Stdin) && ttys)
	}

	/// Posix mode at startup: `--posix`, `-o posix`, or `POSIXLY_CORRECT` /
	/// `POSIX_PEDANTIC` in `env` (`sh` turns it on after the startup files).
	pub fn posix_at_start(&self, env: &[(BString, BString)]) -> bool {
		let from_env = env
			.iter()
			.any(|(n, _)| matches!(n.as_slice(), b"POSIXLY_CORRECT" | b"POSIX_PEDANTIC"));
		self
			.options
			.iter()
			.rev()
			.find(|(o, _)| *o == OptId::Posix)
			.map_or(self.posix || from_env, |(_, on)| *on)
	}

	/// `$0` with the environment applied: an imported `BASH_ARGV0` names a
	/// shell that reads `-c` without a name, or standard input (bash binds
	/// it before the arguments, which win).
	pub fn dollar0_in(&self, env: &[(BString, BString)]) -> BString {
		if !self.named
			&& let Some((_, v)) = env.iter().find(|(n, _)| n.as_slice() == b"BASH_ARGV0")
		{
			return v.clone();
		}
		self.dollar0.clone()
	}

	/// Every option the new shell starts with, in the order bash applies
	/// them: the flags and `-o` names, `-O` names, then the options named by
	/// an imported `SHELLOPTS` and `BASHOPTS` (which only turn options on),
	/// `login_shell`, and posix mode with `expand_aliases` for `sh` (bash
	/// turns posix mode on for `sh` after the startup files; the engine
	/// starts it so).
	pub fn startup_options(
		&self,
		env: &[(BString, BString)],
		interactive: bool,
	) -> Vec<(OptId, bool)> {
		let mut opts: Vec<(OptId, bool)> = Vec::new();
		// A zsh-dialect shell's options are [`Self::zsh_options`].
		if self.mode.dialect() == Dialect::Zsh {
			return opts;
		}
		if self.posix_at_start(env) || self.sh {
			opts.push((OptId::Posix, true));
		}
		opts.extend(self.options.iter().copied());
		opts.extend(self.shopts.iter().copied());
		for (var, kind) in [(&b"SHELLOPTS"[..], OptKind::Set), (b"BASHOPTS", OptKind::Shopt)] {
			let Some((_, value)) = env.iter().find(|(n, _)| n.as_slice() == var) else {
				continue;
			};
			for name in value.split(|&c| c == b':') {
				if let Some(opt) = OptId::from_name(name).filter(|o| o.kind() == kind) {
					opts.push((opt, true));
				}
			}
		}
		if self.login_flag || self.login_name {
			opts.push((OptId::LoginShell, true));
		}
		if interactive {
			for opt in [OptId::Histexpand, OptId::History, OptId::ExpandAliases] {
				if !opts.iter().any(|(o, _)| *o == opt) {
					opts.push((opt, true));
				}
			}
		}
		opts
	}

	/// The startup files bash would source, in order (`run_startup_files`
	/// with `home` for `~`, `env` for `BASH_ENV`/`ENV`): each entry lists
	/// candidates of which the first that exists is sourced (a login shell's
	/// `~/.bash_profile`, `~/.bash_login`, `~/.profile`).
	///
	/// # Errors
	///
	/// [`InvocationError::Unsupported`] when `BASH_ENV`/`ENV` needs an
	/// expansion other than `$NAME`/`${NAME}` (bash expands the value as a
	/// double-quoted word).
	pub fn startup_files(
		&self,
		env: &[(BString, BString)],
		home: &[u8],
		interactive: bool,
	) -> Result<Vec<Vec<BString>>, InvocationError> {
		self.startup_files_with(env, home, interactive, true)
	}

	/// [`Self::startup_files`], leaving out an interactive shell's rc files
	/// (`~/.bashrc` or `--rcfile`, `$ENV`; `/etc/zshrc`, `.zshrc`) unless
	/// `rc`: a [`crate::bash::Profile::Tool`] shell's nested `bash -i` or
	/// `zsh -i` does not set up the user's completion and history.
	///
	/// # Errors
	///
	/// As [`Self::startup_files`].
	pub fn startup_files_with(
		&self,
		env: &[(BString, BString)],
		home: &[u8],
		interactive: bool,
		rc: bool,
	) -> Result<Vec<Vec<BString>>, InvocationError> {
		if self.mode.dialect() == Dialect::Zsh {
			return Ok(self.zsh_startup_files(env, home, interactive, rc));
		}
		let posix = self.posix_at_start(env);
		let privileged = self
			.options
			.iter()
			.rev()
			.find(|(o, _)| *o == OptId::Privileged)
			.is_some_and(|(_, on)| *on);
		let tilde = |rest: &str| {
			let mut p = BString::from(home);
			p.extend_from_slice(rest.as_bytes());
			p
		};
		let profile = |files: &mut Vec<Vec<BString>>| {
			if self.noprofile {
				return;
			}
			files.push(vec![BString::from(SYS_PROFILE)]);
			if self.sh {
				files.push(vec![tilde("/.profile")]);
			} else {
				files.push(vec![tilde("/.bash_profile"), tilde("/.bash_login"), tilde("/.profile")]);
			}
		};
		let env_file = |name: &[u8], files: &mut Vec<Vec<BString>>| -> Result<(), InvocationError> {
			if let Some((_, value)) = env.iter().find(|(n, _)| n.as_slice() == name)
				&& !value.is_empty()
			{
				let path = expand_env_file(value, env)?;
				if !path.is_empty() {
					files.push(vec![path]);
				}
			}
			Ok(())
		};
		let mut files = Vec::new();
		let sourced_login = if self.login_flag && !posix {
			profile(&mut files);
			true
		} else {
			false
		};
		if !interactive {
			if !posix && !self.sh && !privileged {
				env_file(b"BASH_ENV", &mut files)?;
			}
			return Ok(files);
		}
		let login = self.login_flag || self.login_name;
		if !posix {
			let mut norc = self.norc || sourced_login;
			if login && !sourced_login {
				norc = true;
				profile(&mut files);
			}
			if rc && !self.sh && !norc {
				files.push(vec![self.rcfile.clone().unwrap_or_else(|| tilde("/.bashrc"))]);
			} else if rc && self.sh && !privileged {
				env_file(b"ENV", &mut files)?;
			}
		} else if rc && !privileged {
			env_file(b"ENV", &mut files)?;
		}
		Ok(files)
	}

	/// zsh 5.9 `run_init_scripts` (non-`sh`/`ksh` emulation): `/etc/zshenv`,
	/// then under `rcs` `$ZDOTDIR/.zshenv`, the login and interactive files,
	/// the global ones only under `globalrcs`. `-f` turns `rcs` off.
	fn zsh_startup_files(
		&self,
		env: &[(BString, BString)],
		home: &[u8],
		interactive: bool,
		rc: bool,
	) -> Vec<Vec<BString>> {
		let set = |opt: ZshOpt, default: bool| {
			self
				.zsh_options
				.iter()
				.rev()
				.find(|(o, _)| *o == opt)
				.map_or(default, |(_, on)| *on)
		};
		let mut files = Vec::new();
		if self.mode != ModeId::Zsh {
			// zsh sources `/etc/profile` and `$ENV`-style files only in its sh
			// and ksh emulations with `-l`; the engine leaves them out.
			return files;
		}
		let rcs = set(ZshOpt::Rcs, true);
		let global = set(ZshOpt::Globalrcs, true);
		let login = self.login_flag || self.login_name;
		let dot = env
			.iter()
			.find(|(n, _)| n.as_slice() == b"ZDOTDIR")
			.map_or_else(|| BString::from(home), |(_, v)| v.clone());
		let user = |name: &str| {
			let mut p = dot.clone();
			p.push(b'/');
			p.extend_from_slice(name.as_bytes());
			vec![p]
		};
		files.push(vec![BString::from("/etc/zshenv")]);
		if !rcs {
			return files;
		}
		files.push(user(".zshenv"));
		for (when, sys, own) in [
			(login, "/etc/zprofile", ".zprofile"),
			(interactive && rc, "/etc/zshrc", ".zshrc"),
			(login, "/etc/zlogin", ".zlogin"),
		] {
			if when {
				if global {
					files.push(vec![BString::from(sys)]);
				}
				files.push(user(own));
			}
		}
		files
	}

	/// The text of `bash -o` / `bash -O` as the last argument: the options
	/// at that point of the parse (bash lists `emacs` as on: line editing is
	/// the default until the shell finds it is not interactive).
	pub fn listing_text(&self) -> Option<Vec<u8>> {
		use std::io::Write;

		use strum::IntoEnumIterator;
		let listing = self.listing?;
		let (kind, reusable) = match listing {
			Listing::Set { reusable } => (OptKind::Set, reusable),
			Listing::Shopt { reusable } => (OptKind::Shopt, reusable),
		};
		let mut names: Vec<OptId> = OptId::iter().filter(|o| o.kind() == kind).collect();
		names.sort_by_key(|o| <&'static str>::from(*o));
		let mut out = Vec::new();
		for opt in names {
			let name: &'static str = opt.into();
			let on = match kind {
				OptKind::Set => self
					.options
					.iter()
					.rev()
					.find(|(o, _)| *o == opt)
					.map_or_else(|| opt.default_on() || opt == OptId::Emacs, |(_, on)| *on),
				OptKind::Shopt => opt.default_on(),
			};
			let _ = match (kind, reusable) {
				(OptKind::Set, false) => {
					writeln!(out, "{name:<15}\t{}", if on { "on" } else { "off" })
				},
				(OptKind::Set, true) => writeln!(out, "set {}o {name}", if on { '-' } else { '+' }),
				(OptKind::Shopt, false) => {
					writeln!(out, "{name:<20}\t{}", if on { "on" } else { "off" })
				},
				(OptKind::Shopt, true) => {
					writeln!(out, "shopt {} {name}", if on { "-s" } else { "-u" })
				},
			};
		}
		Some(out)
	}
}

/// `BASH_ENV`/`ENV` expanded as bash's `expand_string_unsplit_to_string`
/// does for the plain forms: `$NAME`, `${NAME}` and backslash escapes of
/// `$`, `` ` ``, `"` and `\` (an unset name is empty).
///
/// # Errors
///
/// [`InvocationError::Unsupported`] for a command substitution,
/// arithmetic, special parameter or `${…}` operator.
pub fn expand_env_file(
	value: &[u8],
	env: &[(BString, BString)],
) -> Result<BString, InvocationError> {
	let lookup = |name: &[u8]| {
		env.iter()
			.find(|(n, _)| n.as_slice() == name)
			.map_or(&b""[..], |(_, v)| v.as_slice())
	};
	let unsupported =
		|| InvocationError::Unsupported { what: Cow::Borrowed("this expansion in BASH_ENV/ENV") };
	let is_name = |c: u8| c == b'_' || c.is_ascii_alphanumeric();
	let mut out = BString::default();
	let mut i = 0;
	while let Some(&c) = value.get(i) {
		match c {
			b'\\' if matches!(value.get(i + 1), Some(b'$' | b'`' | b'"' | b'\\')) => {
				out.push(value[i + 1]);
				i += 2;
			},
			b'`' => return Err(unsupported()),
			b'$' => {
				let rest = &value[i + 1..];
				if rest.first() == Some(&b'{') {
					let end = rest
						.iter()
						.position(|&c| c == b'}')
						.ok_or_else(unsupported)?;
					let name = &rest[1..end];
					if name.is_empty() || name[0].is_ascii_digit() || !name.iter().all(|&c| is_name(c)) {
						return Err(unsupported());
					}
					out.extend_from_slice(lookup(name));
					i += end + 2;
				} else {
					let len = rest.iter().take_while(|&&c| is_name(c)).count();
					match rest.first() {
						Some(c) if c.is_ascii_digit() => return Err(unsupported()),
						Some(_) if len > 0 => {
							out.extend_from_slice(lookup(&rest[..len]));
							i += len + 1;
						},
						// A `$` before nothing expandable stays.
						None | Some(b' ' | b'\t' | b'/' | b'.' | b'"') => {
							out.push(b'$');
							i += 1;
						},
						Some(_) => return Err(unsupported()),
					}
				}
			},
			_ => {
				out.push(c);
				i += 1;
			},
		}
	}
	Ok(out)
}

/// bash's long usage (`show_shell_usage(fp, 0)`), after an invalid option.
pub fn usage(shell_name: &[u8]) -> Vec<u8> {
	let name = BStr::new(shell_name);
	let mut out = format!(
		"Usage:\t{name} [GNU long option] [option] ...\n\t{name} [GNU long option] [option] \
		 script-file ...\nGNU long options:\n"
	)
	.into_bytes();
	for opt in LONG_OPTIONS {
		out.extend_from_slice(format!("\t--{opt}\n").as_bytes());
	}
	out.extend_from_slice(
		b"Shell options:\n\t-ilrsD or -c command or -O shopt_option\t\t(invocation only)\n\t\
		  -abefhkmnptuvxBCEHPT or -o option\n",
	);
	out
}

/// `MACHTYPE` of this build, as bash's configure spells it
/// (`aarch64-apple-darwin`, `x86_64-pc-linux-gnu`).
pub const fn machtype() -> &'static str {
	if cfg!(target_os = "macos") {
		if cfg!(target_arch = "aarch64") {
			"aarch64-apple-darwin"
		} else {
			"x86_64-apple-darwin"
		}
	} else if cfg!(windows) {
		if cfg!(target_arch = "aarch64") {
			"aarch64-pc-msys"
		} else {
			"x86_64-pc-msys"
		}
	} else if cfg!(target_arch = "aarch64") {
		"aarch64-unknown-linux-gnu"
	} else {
		"x86_64-pc-linux-gnu"
	}
}

/// `bash --help`: the version line, the usage and bash's pointers.
pub fn help_text(shell_name: &[u8]) -> Vec<u8> {
	let name = BStr::new(shell_name);
	let mut out = format!("GNU bash, version {}-({})\n", crate::bash::vm::BASH_VERSION, machtype())
		.into_bytes();
	out.extend_from_slice(&usage(shell_name));
	out.extend_from_slice(
		format!(
			"Type `{name} -c \"help set\"' for more information about shell options.\nType `{name} \
			 -c help' for more information about shell builtin commands.\nUse the `bashbug' \
			 command to report bugs.\n\nbash home page: <http://www.gnu.org/software/bash>\nGeneral \
			 help using GNU software: <http://www.gnu.org/gethelp/>\n"
		)
		.as_bytes(),
	);
	out
}

/// `bash --version` (`show_shell_version(1)`).
pub fn version_text() -> Vec<u8> {
	format!(
		"GNU bash, version {} ({})\nCopyright (C) 2025 Free Software Foundation, Inc.\nLicense \
		 GPLv3+: GNU GPL version 3 or later <http://gnu.org/licenses/gpl.html>\n\nThis is free \
		 software; you are free to change and redistribute it.\nThere is NO WARRANTY, to the \
		 extent permitted by law.\n",
		crate::bash::vm::BASH_VERSION,
		machtype()
	)
	.into_bytes()
}


