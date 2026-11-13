//! `du` builtin: estimate file space usage.
//!
//! Traversal: fts-order path spelling, hard-link and directory-cycle handling,
//! `--exclude` matched against every trailing part of a path, and `--time` styles.

use std::{
	collections::HashSet,
	ffi::{OsStr, OsString},
	fmt::NumBuffer,
	io::{self, Read, Write},
	path::{Path, PathBuf},
};

use clap::{Arg, ArgAction, ArgMatches, Command, builder::PossibleValue};
use glob::Pattern;
use jiff::{
	Zoned,
	fmt::{
		StdIoWrite,
		strtime::{BrokenDownTime, Config as TimeFormatConfig},
	},
	tz::TimeZone,
};
use pi_vfs::{FileId, Metadata};
use uucore::{
	display::Quotable,
	i18n::UEncoding,
	parser::{
		parse_glob,
		parse_size::{ParseSizeError, Parser, allow_list_with_all_suffixes},
		shortcut_value_parser::ShortcutValueParser,
	},
	quoting_style::{QuotingStyle, escape_name},
};

use crate::{
	block_size::{BlockSize, Scale},
	host::{Host, StreamWriter, Utility, format_usage, matches_parser, os_bytes_lossy, strip_errno},
	locale::{NumericSymbols, ctype_is_utf8, numeric_symbols},
	quoting_style::quoting_style_by_name,
	time_zone::shell_time_zone,
};

mod options {
	pub const HELP: &str = "help";
	pub const NULL: &str = "0";
	pub const ALL: &str = "all";
	pub const APPARENT_SIZE: &str = "apparent-size";
	pub const BLOCK_SIZE: &str = "block-size";
	pub const BYTES: &str = "b";
	pub const TOTAL: &str = "c";
	pub const MAX_DEPTH: &str = "d";
	pub const HUMAN_READABLE: &str = "h";
	pub const BLOCK_SIZE_1K: &str = "k";
	pub const COUNT_LINKS: &str = "l";
	pub const BLOCK_SIZE_1M: &str = "m";
	pub const SEPARATE_DIRS: &str = "S";
	pub const SUMMARIZE: &str = "s";
	pub const THRESHOLD: &str = "threshold";
	pub const SI: &str = "si";
	pub const TIME: &str = "time";
	pub const TIME_STYLE: &str = "time-style";
	pub const ONE_FILE_SYSTEM: &str = "one-file-system";
	pub const DEREFERENCE: &str = "dereference";
	pub const DEREFERENCE_ARGS: &str = "dereference-args";
	pub const NO_DEREFERENCE: &str = "no-dereference";
	pub const INODES: &str = "inodes";
	pub const EXCLUDE: &str = "exclude";
	pub const EXCLUDE_FROM: &str = "exclude-from";
	pub const FILES0_FROM: &str = "files0-from";
	pub const FILE: &str = "FILE";
}

/// Parsed `du` invocation.
pub(crate) struct Du {
	matches: ArgMatches,
}

matches_parser!(Du, app);

impl Utility for Du {
	const NAME: &'static str = "du";

	fn run(self, host: &mut Host) -> i32 {
		run(host, &self.matches)
	}
}

/// The `du` argument model, as uutils' `uu_app` with GNU's option set.
fn app() -> Command {
	Command::new(Du::NAME)
		.version("9.8")
		.about("Summarize device usage of the set of FILEs, recursively for directories.")
		.override_usage(format_usage("du [OPTION]... [FILE]...\n  or:  du [OPTION]... --files0-from=F"))
		.after_help(
			"Display values are in units of the first available SIZE from --block-size,\nand the \
			 DU_BLOCK_SIZE, BLOCK_SIZE and BLOCKSIZE environment variables.\nOtherwise, units default to \
			 1024 bytes (or 512 if POSIXLY_CORRECT is set).\n\nThe SIZE argument is an integer and \
			 optional unit (example: 10K is 10*1024).\nUnits are K,M,G,T,P,E,Z,Y,R,Q (powers of 1024) or \
			 KB,MB,... (powers of 1000).\nBinary prefixes can be used, too: KiB=K, MiB=M, and so on.\n\nThe \
			 --time-style STYLE argument can be full-iso, long-iso, iso, or +FORMAT.\nFORMAT is \
			 interpreted like in date(1).\nAlso the TIME_STYLE environment variable sets the default style \
			 to use.",
		)
		.infer_long_args(true)
		.disable_help_flag(true)
		.args_override_self(true)
		.arg(
			Arg::new(options::HELP)
				.long(options::HELP)
				.help("display this help and exit")
				.action(ArgAction::Help),
		)
		.arg(flag(options::NULL, Some('0'), Some("null"), "end each output line with NUL, not newline"))
		.arg(flag(options::ALL, Some('a'), Some(options::ALL), "write counts for all files, not just directories"))
		.arg(flag(
			options::APPARENT_SIZE,
			Some('A'),
			Some(options::APPARENT_SIZE),
			"print apparent sizes rather than device usage; although the apparent size is usually smaller, \
			 it may be larger due to holes in ('sparse') files, internal fragmentation, indirect blocks, etc.",
		))
		.arg(
			Arg::new(options::BLOCK_SIZE)
				.short('B')
				.long(options::BLOCK_SIZE)
				.value_name("SIZE")
				.help(
					"scale sizes by SIZE before printing them; See SIZE format below; E.g., '-BM' prints sizes \
					 in units of 1,048,576 bytes",
				),
		)
		.arg(flag(options::BYTES, Some('b'), Some("bytes"), "equivalent to '--apparent-size --block-size=1'"))
		.arg(flag(options::TOTAL, Some('c'), Some("total"), "produce a grand total"))
		.arg(
			Arg::new(options::DEREFERENCE_ARGS)
				.short('D')
				.visible_short_alias('H')
				.long(options::DEREFERENCE_ARGS)
				.help("dereference only symlinks that are listed on the command line")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::MAX_DEPTH)
				.short('d')
				.long("max-depth")
				.value_name("N")
				.allow_hyphen_values(true)
				.help(
					"print the total for a directory (or file, with --all) only if it is N or fewer levels \
					 below the command line argument;  --max-depth=0 is the same as --summarize",
				),
		)
		.arg(
			Arg::new(options::FILES0_FROM)
				.long(options::FILES0_FROM)
				.value_name("F")
				.value_hint(clap::ValueHint::FilePath)
				.value_parser(clap::value_parser!(OsString))
				.help(
					"summarize device usage of the NUL-terminated file names specified in file F;  if F is -, \
					 read names from standard input",
				),
		)
		.arg(flag(
			options::HUMAN_READABLE,
			Some('h'),
			Some("human-readable"),
			"print sizes in human readable format (e.g., 1K 234M 2G)",
		))
		.arg(flag(options::INODES, None, Some(options::INODES), "list inode usage information instead of block usage"))
		.arg(flag(options::BLOCK_SIZE_1K, Some('k'), None, "like --block-size=1K"))
		.arg(flag(options::DEREFERENCE, Some('L'), Some(options::DEREFERENCE), "dereference all symbolic links"))
		.arg(flag(options::COUNT_LINKS, Some('l'), Some("count-links"), "count sizes many times if hard linked"))
		.arg(flag(options::BLOCK_SIZE_1M, Some('m'), None, "like --block-size=1M"))
		.arg(flag(
			options::NO_DEREFERENCE,
			Some('P'),
			Some(options::NO_DEREFERENCE),
			"don't follow any symbolic links (this is the default)",
		))
		.arg(flag(
			options::SEPARATE_DIRS,
			Some('S'),
			Some("separate-dirs"),
			"for directories do not include size of subdirectories",
		))
		.arg(flag(options::SI, None, Some(options::SI), "like -h, but use powers of 1000 not 1024"))
		.arg(flag(options::SUMMARIZE, Some('s'), Some("summarize"), "display only a total for each argument"))
		.arg(
			Arg::new(options::THRESHOLD)
				.short('t')
				.long(options::THRESHOLD)
				.value_name("SIZE")
				.num_args(1)
				.allow_hyphen_values(true)
				.help("exclude entries smaller than SIZE if positive, or entries greater than SIZE if negative"),
		)
		.arg(
			Arg::new(options::TIME)
				.long(options::TIME)
				.value_name("WORD")
				.require_equals(true)
				.num_args(0..=1)
				.value_parser(ShortcutValueParser::new([
					PossibleValue::new("atime").alias("access").alias("use"),
					PossibleValue::new("ctime").alias("status"),
				]))
				.help(
					"show time of the last modification of any file in the directory, or any of its \
					 subdirectories; with WORD, show time as WORD instead of modification time: atime, \
					 access, use, ctime or status",
				),
		)
		.arg(
			Arg::new(options::TIME_STYLE)
				.long(options::TIME_STYLE)
				.value_name("STYLE")
				.help("time/date format with --time; see TIME_STYLE below"),
		)
		.arg(
			Arg::new(options::EXCLUDE_FROM)
				.short('X')
				.long(options::EXCLUDE_FROM)
				.value_name("FILE")
				.value_hint(clap::ValueHint::FilePath)
				.value_parser(clap::value_parser!(OsString))
				.help("exclude files that match any pattern in FILE")
				.action(ArgAction::Append),
		)
		.arg(
			Arg::new(options::EXCLUDE)
				.long(options::EXCLUDE)
				.value_name("PATTERN")
				.help("exclude files that match PATTERN")
				.action(ArgAction::Append),
		)
		.arg(flag(
			options::ONE_FILE_SYSTEM,
			Some('x'),
			Some(options::ONE_FILE_SYSTEM),
			"skip directories on different file systems",
		))
		.arg(
			Arg::new(options::FILE)
				.hide(true)
				.value_hint(clap::ValueHint::AnyPath)
				.value_parser(clap::value_parser!(OsString))
				.action(ArgAction::Append),
		)
}

fn flag(id: &'static str, short: Option<char>, long: Option<&'static str>, help: &'static str) -> Arg {
	let mut arg = Arg::new(id).help(help).action(ArgAction::SetTrue);
	if let Some(short) = short {
		arg = arg.short(short);
	}
	if let Some(long) = long {
		arg = arg.long(long);
	}
	arg
}

/// The last of `ids` given on the command line.
fn last_given<'a>(matches: &ArgMatches, ids: &[&'a str]) -> Option<&'a str> {
	ids.iter()
		.filter(|id| matches.get_flag(id))
		.filter_map(|id| Some((matches.indices_of(id)?.next_back()?, *id)))
		.max_by_key(|(index, _)| *index)
		.map(|(_, id)| id)
}

fn bytes_to_os(bytes: &[u8]) -> OsString {
	match uucore::os_str_from_bytes(bytes) {
		Ok(value) => value.into_owned(),
		Err(_) => OsString::from(String::from_utf8_lossy(bytes).into_owned()),
	}
}

// ── Exclusion patterns ────────────────────────────────────────────────────────

/// `--exclude`/`-X` patterns. As in GNU, a pattern excludes a file when it
/// matches the whole path or any part of it after a `/`.
#[derive(Default)]
struct Exclude {
	patterns: Vec<Pattern>,
}

impl Exclude {
	/// Adds `pattern`; one that is not a valid glob (`[a`) matches literally,
	/// as `fnmatch` treats it.
	fn add(&mut self, pattern: &str) {
		let pattern = parse_glob::from_str(pattern)
			.unwrap_or_else(|_| Pattern::new(&Pattern::escape(pattern)).expect("escaped pattern is valid"));
		self.patterns.push(pattern);
	}

	fn matches(&self, name: &[u8]) -> bool {
		if self.patterns.is_empty() {
			return false;
		}
		let name = String::from_utf8_lossy(name);
		let suffixes = std::iter::once(name.as_ref()).chain(
			name.match_indices('/')
				.map(|(slash, _)| &name[slash + 1..])
				.filter(|rest| !rest.starts_with('/')),
		);
		let suffixes: Vec<&str> = suffixes.collect();
		self.patterns
			.iter()
			.any(|pattern| suffixes.iter().any(|suffix| pattern.matches(suffix)))
	}
}

// ── Traversal ─────────────────────────────────────────────────────────────────

/// fts symlink handling: `-P`, `-D`/`-H`, `-L`.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Deref {
	Physical,
	CommandLine,
	Logical,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TimeKind {
	Modification,
	Access,
	Change,
}

/// Output-side settings.
struct Config {
	all:           bool,
	apparent:      bool,
	count_all:     bool,
	hash_all:      bool,
	separate_dirs: bool,
	one_fs:        bool,
	deref:         Deref,
	max_depth:     u64,
	threshold:     Option<Threshold>,
	block_size:    BlockSize,
	symbols:       NumericSymbols,
	inodes:        bool,
	nul:           bool,
	time:          Option<(TimeKind, String, TimeZone)>,
	/// Quoting style for names when stdout is a terminal.
	quote_output:  Option<QuotingStyle>,
	/// Whether names are UTF-8 for output quoting.
	utf8:          bool,
	excludes:      Exclude,
}

/// `--threshold`: entries smaller than a positive size, or larger than a
/// negative one, are not printed.
#[derive(Clone, Copy)]
enum Threshold {
	Lower(u64),
	Upper(u64),
}

impl Threshold {
	fn parse(spec: &str) -> Result<Self, ParseSizeError> {
		let allow_list = allow_list_with_all_suffixes("kKmMGTPEZYRQ");
		let allow_list: Vec<&str> = allow_list.iter().map(String::as_str).collect();
		let digits = spec.strip_prefix(['-', '+']).unwrap_or(spec);
		let size = Parser::default().with_allow_list(&allow_list).parse_u64(digits)?;
		if spec.starts_with('-') {
			// `-0` would only show empty entries; GNU rejects it.
			if size == 0 {
				return Err(ParseSizeError::ParseFailure(spec.to_owned()));
			}
			Ok(Self::Upper(size))
		} else {
			Ok(Self::Lower(size))
		}
	}

	const fn excludes(self, size: u64) -> bool {
		match self {
			Self::Upper(threshold) => size > threshold,
			Self::Lower(threshold) => size < threshold,
		}
	}
}

/// GNU's `struct duinfo`.
#[derive(Clone, Copy, Default)]
struct DuInfo {
	size:   u64,
	inodes: u64,
	/// Latest `(seconds, nanoseconds)` seen; `None` before any.
	tmax:   Option<(i64, i64)>,
}

impl DuInfo {
	fn add(&mut self, other: &Self) {
		self.size = self.size.saturating_add(other.size);
		self.inodes = self.inodes.wrapping_add(other.inodes);
		if other.tmax > self.tmax {
			self.tmax = other.tmax;
		}
	}
}

/// A directory whose children are being visited, or an entry being finished.
struct DirFrame {
	/// Length of this entry's display name in the walk's name buffer.
	display_len: usize,
	level:       usize,
	own:         DuInfo,
	/// The children's own sizes.
	ent:         DuInfo,
	/// Everything below the child directories.
	subdir:      DuInfo,
	children:    std::vec::IntoIter<(OsString, PathBuf)>,
	/// The error that cut the directory listing short.
	read_error:  Option<io::Error>,
	/// Whether this directory is on [`Walker::ancestors`].
	is_ancestor: bool,
}

impl DirFrame {
	fn add(&mut self, child: &Counted, separate_dirs: bool) {
		if !(separate_dirs && child.dir_type) {
			self.ent.add(&child.own);
		}
		if child.dir_type {
			self.subdir.add(&child.inner);
		}
	}
}

/// How [`Walker::enter`] left an entry.
enum Entered {
	/// Finished, with what it adds to its parent if anything.
	Leaf(Option<Counted>),
	/// A directory whose children are to be visited.
	Dir(DirFrame),
}

/// What a visited entry contributes to its parent directory.
struct Counted {
	own:      DuInfo,
	dir_type: bool,
	/// For directories, everything below: entries plus subdirectory totals.
	inner:    DuInfo,
}

struct Walker<'h> {
	host:      &'h mut Host,
	out:       StreamWriter,
	cfg:       &'h Config,
	seen:      HashSet<FileId>,
	/// Identities of the directories on the current path.
	ancestors: Vec<Option<FileId>>,
	mounts:    Option<HashSet<FileId>>,
	total:     DuInfo,
	root_dev:  Option<u64>,
	ok:        bool,
	stopped:   bool,
	write_err: Option<io::Error>,
}

impl Walker<'_> {
	fn error(&mut self, message: impl std::fmt::Display) {
		let _ = writeln!(self.host.stderr, "du: {message}");
		self.ok = false;
	}

	fn check_stop(&mut self) -> bool {
		if !self.stopped && (self.host.is_cancelled() || self.host.sigpipe_hit()) {
			self.stopped = true;
		}
		self.stopped
	}

	/// One operand: GNU's `du_files` on a single root.
	fn root(&mut self, operand: &[u8]) {
		let mut len = operand.len();
		if len > 2 && operand[len - 1] == b'/' {
			while len > 1 && operand[len - 2] == b'/' {
				len -= 1;
			}
		}
		let display = &operand[..len];
		let path = self.host.resolve(bytes_to_os(display));
		self.root_dev = None;
		self.visit(display, &path);
	}

	fn metadata(&self, path: &Path, follow: bool) -> io::Result<Metadata> {
		if follow { self.host.fs().metadata(path) } else { self.host.fs().symlink_metadata(path) }
	}

	/// GNU's `process_file` for one operand and, for a directory, its subtree.
	///
	/// Walks with an explicit stack of open directories: recursing once per
	/// level overflows the thread's stack on a deep enough tree, and that
	/// kills the whole process rather than failing the command.
	fn visit(&mut self, display: &[u8], path: &Path) {
		let separate_dirs = self.cfg.separate_dirs;
		let mut display = display.to_vec();
		let mut stack = match self.enter(&display, path, 0) {
			Entered::Leaf(_) => return,
			Entered::Dir(frame) => vec![frame],
		};
		while let Some(frame) = stack.last_mut() {
			display.truncate(frame.display_len);
			let Some((name, child_path)) = frame.children.next() else {
				let frame = stack.pop().expect("the loop holds a frame");
				let counted = self.leave(&display, frame);
				if let (Some(child), Some(parent)) = (counted, stack.last_mut()) {
					parent.add(&child, separate_dirs);
				}
				continue;
			};
			let level = frame.level + 1;
			if display.last() != Some(&b'/') {
				display.push(b'/');
			}
			display.extend_from_slice(&os_bytes_lossy(&name));
			match self.enter(&display, &child_path, level) {
				Entered::Leaf(None) => {},
				Entered::Leaf(Some(child)) => {
					stack.last_mut().expect("the loop holds a frame").add(&child, separate_dirs);
				},
				Entered::Dir(child) => stack.push(child),
			}
		}
	}

	/// Everything `process_file` does for an entry before visiting its
	/// children: a non-directory, or one that is skipped, is finished here.
	fn enter(&mut self, display: &[u8], path: &Path, level: usize) -> Entered {
		if self.check_stop() {
			return Entered::Leaf(None);
		}
		let cfg = self.cfg;
		let follow = cfg.deref == Deref::Logical || (cfg.deref == Deref::CommandLine && level == 0);
		let excluded = cfg.excludes.matches(display);
		let meta = match self.metadata(path, follow) {
			Ok(meta) => meta,
			Err(error) => {
				let dangling = follow
					&& error.kind() == io::ErrorKind::NotFound
					&& self.host.fs().symlink_metadata(path).is_ok();
				// Entries that vanish mid-walk are not reported.
				if !dangling && level > 0 && error.kind() == io::ErrorKind::NotFound {
					return Entered::Leaf(None);
				}
				if excluded {
					return Entered::Leaf(None);
				}
				if dangling {
					self.error(format_args!("cannot access {}", bytes_to_os(display).quote()));
				} else {
					self.error(format_args!("cannot access {}: {}", bytes_to_os(display).quote(), strip_errno(&error)));
				}
				return Entered::Leaf(None);
			},
		};
		if level == 0 {
			self.root_dev = meta.dev();
		}
		let is_dir = meta.is_dir();
		if excluded || (cfg.one_fs && level > 0 && meta.dev() != self.root_dev) {
			return Entered::Leaf(None);
		}
		let id = meta.file_id();
		if !cfg.count_all
			&& (cfg.hash_all || (!is_dir && meta.nlink().unwrap_or(1) > 1))
			&& let Some(id) = id
			&& !self.seen.insert(id)
		{
			return Entered::Leaf(None);
		}
		if is_dir
			&& let Some(id) = id
			&& let Some(cycle) = self.ancestors.iter().position(|ancestor| *ancestor == Some(id))
		{
			let warn = cfg.deref == Deref::Physical || (cfg.deref == Deref::CommandLine && level > 0);
			if warn && !self.mount_point_in_cycle(id, cycle) {
				self.error(format_args!(
					"WARNING: Circular directory structure.\nThis almost certainly means that you have a \
					 corrupted file system.\nNOTIFY YOUR SYSTEM MANAGER.\nThe following directory is part \
					 of the cycle:\n  {}\n",
					bytes_to_os(display).maybe_quote()
				));
			}
			return Entered::Leaf(None);
		}

		let size = if cfg.apparent {
			if meta.is_file() || meta.is_symlink() { meta.len() } else { 0 }
		} else {
			meta.blocks()
				.map(|blocks| blocks.saturating_mul(512))
				.or_else(|| self.host.fs().allocated_size(path).ok())
				.unwrap_or_else(|| meta.len())
		};
		let own = DuInfo { size, inodes: 1, tmax: entry_time(&meta, cfg) };
		let mut frame = DirFrame {
			display_len: display.len(),
			level,
			own,
			ent: DuInfo::default(),
			subdir: DuInfo::default(),
			children: Vec::new().into_iter(),
			read_error: None,
			is_ancestor: false,
		};
		if !is_dir {
			return Entered::Leaf(self.conclude(display, frame, false));
		}
		match self.host.fs().read_dir(path) {
			Err(error) => {
				if level > 0 && error.kind() == io::ErrorKind::NotFound {
					return Entered::Leaf(None);
				}
				self.error(format_args!(
					"cannot read directory {}: {}",
					bytes_to_os(display).quote(),
					strip_errno(&error)
				));
			},
			Ok(entries) => {
				let mut children = Vec::new();
				for entry in entries {
					if self.check_stop() {
						return Entered::Leaf(None);
					}
					match entry {
						Ok(entry) => children.push((entry.file_name(), entry.path())),
						Err(error) => {
							frame.read_error = Some(error);
							break;
						},
					}
				}
				frame.children = children.into_iter();
				self.ancestors.push(id);
				frame.is_ancestor = true;
			},
		}
		Entered::Dir(frame)
	}

	/// Finishes a directory once all its children are visited.
	fn leave(&mut self, display: &[u8], frame: DirFrame) -> Option<Counted> {
		if frame.is_ancestor {
			self.ancestors.pop();
		}
		if let Some(error) = &frame.read_error {
			self.error(format_args!("{}: {}", bytes_to_os(display).maybe_quote(), strip_errno(error)));
		}
		if self.stopped {
			return None;
		}
		self.conclude(display, frame, true)
	}

	/// Prints a finished entry's row when selected and returns what it adds
	/// to its parent.
	fn conclude(&mut self, display: &[u8], frame: DirFrame, is_dir: bool) -> Option<Counted> {
		let cfg = self.cfg;
		let DirFrame { own, ent, subdir, level, .. } = frame;
		let mut to_print = own;
		to_print.add(&ent);
		if !cfg.separate_dirs {
			to_print.add(&subdir);
		}
		self.total.add(&own);

		let depth = u64::try_from(level).unwrap_or(u64::MAX);
		if (is_dir && depth <= cfg.max_depth) || (cfg.all && depth <= cfg.max_depth) || level == 0 {
			let value = if cfg.inodes { to_print.inodes } else { to_print.size };
			if !cfg.threshold.is_some_and(|threshold| threshold.excludes(value)) {
				self.print(&to_print, display, true);
			}
		}

		let mut inner = ent;
		inner.add(&subdir);
		Some(Counted { own, dir_type: is_dir, inner })
	}

	/// Whether the cycle closing at `ancestors[cycle]` passes through a
	/// local mount point (a bind mount, which GNU does not warn about).
	fn mount_point_in_cycle(&mut self, id: FileId, cycle: usize) -> bool {
		if self.mounts.is_none() {
			#[cfg_attr(not(unix), allow(unused_mut))]
			let mut mounts = HashSet::new();
			#[cfg(unix)]
			if let Ok(list) = uucore::fsext::read_fs_list() {
				for mount in list.into_iter().filter(|mount| !mount.remote && !mount.dummy) {
					if let Ok(meta) = self.host.fs().metadata(&mount.mount_dir)
						&& let Some(mount_id) = meta.file_id()
					{
						mounts.insert(mount_id);
					}
				}
			}
			self.mounts = Some(mounts);
		}
		let mounts = self.mounts.as_ref().expect("mount table loaded above");
		mounts.contains(&id)
			|| self.ancestors[cycle + 1..]
				.iter()
				.flatten()
				.any(|ancestor| mounts.contains(ancestor))
	}

	/// GNU's `print_size`.
	fn print(&mut self, info: &DuInfo, name: &[u8], quote: bool) {
		if self.stopped {
			return;
		}
		let cfg = self.cfg;
		let value = if cfg.inodes { info.inodes } else { info.size };
		let mut line = if value == u64::MAX {
			b"Infinity".to_vec()
		} else {
			cfg.block_size.format(value, cfg.symbols).into_bytes()
		};
		if let Some((_, format, zone)) = &cfg.time {
			line.push(b'\t');
			show_date(&mut line, info.tmax, format, zone);
		}
		line.push(b'\t');
		match cfg.quote_output {
			Some(style) if quote => {
				let encoding = if cfg.utf8 { UEncoding::Utf8 } else { UEncoding::Ascii };
				line.extend_from_slice(&os_bytes_lossy(&escape_name(&bytes_to_os(name), style, encoding)));
			},
			_ => line.extend_from_slice(name),
		}
		line.push(if cfg.nul { b'\0' } else { b'\n' });
		if let Err(error) = self.out.write_all(&line).and_then(|()| self.out.flush()) {
			self.stopped = true;
			self.write_err = Some(error);
		}
	}
}

fn entry_time(meta: &Metadata, cfg: &Config) -> Option<(i64, i64)> {
	let (kind, ..) = cfg.time.as_ref()?;
	match kind {
		TimeKind::Modification => Some((meta.mtime()?, meta.mtime_nsec()?)),
		TimeKind::Access => Some((meta.atime()?, meta.atime_nsec()?)),
		// Windows has no POSIX status-change time; like `stat`, fall back to
		// the last write time, as Cygwin does.
		TimeKind::Change => match (meta.ctime(), meta.ctime_nsec()) {
			(Some(secs), Some(nsec)) => Some((secs, nsec)),
			_ if cfg!(windows) => Some((meta.mtime()?, meta.mtime_nsec()?)),
			_ => None,
		},
	}
}

/// GNU `show_date`, falling back to the raw seconds when the time cannot be
/// broken down.
fn show_date(out: &mut Vec<u8>, time: Option<(i64, i64)>, format: &str, zone: &TimeZone) {
	let Some((seconds, nanos)) = time else {
		out.extend_from_slice(b"???");
		return;
	};
	let Ok(timestamp) = jiff::Timestamp::new(seconds, i32::try_from(nanos).unwrap_or(0)) else {
		out.extend_from_slice(seconds.format_into(&mut NumBuffer::new()).as_bytes());
		return;
	};
	let zoned = Zoned::new(timestamp, zone.clone());
	let mut rendered = Vec::new();
	let formatted = BrokenDownTime::from(&zoned).format_with_config(
		&TimeFormatConfig::new().lenient(true),
		format,
		&mut StdIoWrite(&mut rendered),
	);
	if formatted.is_ok() {
		out.extend_from_slice(&rendered);
	} else {
		out.extend_from_slice(seconds.format_into(&mut NumBuffer::new()).as_bytes());
	}
}

// ── Main ──────────────────────────────────────────────────────────────────────

/// Reads all of `name` (`-` is standard input) for `-X` and `--files0-from`.
fn read_input(host: &mut Host, name: &OsStr) -> io::Result<Vec<u8>> {
	let mut data = Vec::new();
	if name == "-" {
		host.stdin.read_to_end(&mut data)?;
	} else {
		host.fs().open(host.resolve(name))?.read_to_end(&mut data)?;
	}
	Ok(data)
}

/// `size_error`'s wording for a rejected `--block-size` or `--threshold`.
fn size_error(error: &ParseSizeError, option: &str, value: &str) -> String {
	let value = value.quote();
	match error {
		ParseSizeError::InvalidSuffix(_) => format!("invalid suffix in --{option} argument {value}"),
		ParseSizeError::SizeTooBig(_) => format!("--{option} argument {value} too large"),
		ParseSizeError::ParseFailure(_) | ParseSizeError::PhysicalMem(_) => {
			format!("invalid --{option} argument {value}")
		},
	}
}

/// The `strftime` format for `--time`: `--time-style`, else `TIME_STYLE`
/// (its `posix-` prefixes, `locale`, and lines after the first of a
/// `+FORMAT` ignored), else `long-iso`. Styles may be abbreviated.
fn time_format(host: &Host, style: Option<&str>) -> Result<String, String> {
	let style = match style {
		Some(style) => style.to_owned(),
		None => match host.var("TIME_STYLE") {
			None | Some("locale") => "long-iso".to_owned(),
			Some(style) if style.starts_with('+') => style.split('\n').next().unwrap_or_default().to_owned(),
			Some(mut style) => {
				while let Some(rest) = style.strip_prefix("posix-") {
					style = rest;
				}
				style.to_owned()
			},
		},
	};
	if let Some(format) = style.strip_prefix('+') {
		return Ok(format.to_owned());
	}
	const STYLES: [(&str, &str); 3] = [
		("full-iso", "%Y-%m-%d %H:%M:%S.%N %z"),
		("long-iso", "%Y-%m-%d %H:%M"),
		("iso", "%Y-%m-%d"),
	];
	let prefixed: Vec<&str> =
		STYLES.iter().filter(|(name, _)| name.starts_with(style.as_str())).map(|(_, format)| *format).collect();
	let exact = STYLES.iter().find(|(name, _)| *name == style).map(|(_, format)| *format);
	match (exact, prefixed.as_slice()) {
		(Some(format), _) | (None, &[format]) => Ok(format.to_owned()),
		(None, found) => Err(format!(
			"{} argument {} for 'time style'\nValid arguments are:\n  - full-iso\n  - long-iso\n  - iso\n  - \
			 +FORMAT (e.g., +%H:%M) for a 'date'-style format",
			if found.is_empty() { "invalid" } else { "ambiguous" },
			style.quote()
		)),
	}
}

/// The quoting style for names written to a terminal: `QUOTING_STYLE`, else
/// shell-escape; `None` for `literal`.
fn output_quoting(host: &mut Host) -> Option<QuotingStyle> {
	let style = match host.var("QUOTING_STYLE").map(str::to_owned) {
		None => QuotingStyle::SHELL_ESCAPE,
		Some(name) => match quoting_style_by_name(&name) {
			Some(QuotingStyle::Literal { .. }) => return None,
			Some(style) => style,
			None => {
				let _ = writeln!(
					host.stderr,
					"du: ignoring invalid value of environment variable QUOTING_STYLE: {}",
					name.quote()
				);
				QuotingStyle::SHELL_ESCAPE
			},
		},
	};
	Some(style)
}

#[allow(clippy::too_many_lines, reason = "mirrors GNU du's main()")]
fn run(host: &mut Host, matches: &ArgMatches) -> i32 {
	let summarize = matches.get_flag(options::SUMMARIZE);
	let all = matches.get_flag(options::ALL);
	let inodes = matches.get_flag(options::INODES);
	let apparent = matches.get_flag(options::APPARENT_SIZE) || matches.get_flag(options::BYTES);

	let max_depth = match matches.get_one::<String>(options::MAX_DEPTH) {
		None => None,
		// Like GNU's base-0 `xstrtoimax`: decimal, `0x` hex, or `0` octal.
		Some(depth) => match Parser::default().with_allow_list(&[]).parse_u64(depth.trim_start()) {
			Ok(depth) => Some(depth),
			Err(_) => return host.usage_error(format_args!("invalid maximum depth {}", depth.quote()), 1),
		},
	};

	let scales = [
		(options::BLOCK_SIZE, Scale::Spec),
		(options::BYTES, Scale::Bytes),
		(options::HUMAN_READABLE, Scale::Human),
		(options::SI, Scale::Si),
		(options::BLOCK_SIZE_1K, Scale::Kilo),
		(options::BLOCK_SIZE_1M, Scale::Mega),
	];
	let mut block_size = match BlockSize::from_matches(matches, &scales, host, "DU_BLOCK_SIZE") {
		Ok(block_size) => block_size,
		Err((error, spec)) => {
			host.error(error.message("--block-size", &spec), 1);
			return 1;
		},
	};

	let threshold = match matches.get_one::<String>(options::THRESHOLD) {
		None => None,
		Some(spec) => match Threshold::parse(spec) {
			Ok(threshold) => Some(threshold),
			Err(error) => {
				host.error(size_error(&error, options::THRESHOLD, spec), 1);
				return 1;
			},
		},
	};

	let mut excludes = Exclude::default();
	for pattern in matches.get_many::<String>(options::EXCLUDE).into_iter().flatten() {
		excludes.add(pattern);
	}
	let mut ok = true;
	for name in matches.get_many::<OsString>(options::EXCLUDE_FROM).into_iter().flatten() {
		match read_input(host, name) {
			Ok(data) => {
				for line in data.split(|&b| b == b'\n') {
					let line = line.trim_ascii_end();
					if !line.is_empty() {
						excludes.add(&String::from_utf8_lossy(line));
					}
				}
			},
			Err(error) => {
				let _ = writeln!(host.stderr, "du: {}: {}", name.maybe_quote(), strip_errno(&error));
				ok = false;
			},
		}
	}
	if !ok {
		return host.try_help(1);
	}

	let nul = matches.get_flag(options::NULL);
	let quote_output = if !nul && host.stdout.is_terminal() { output_quoting(host) } else { None };

	if all && summarize {
		return host.usage_error("cannot both summarize and show all entries", 1);
	}
	match max_depth {
		Some(0) if summarize => {
			let _ = writeln!(host.stderr, "du: warning: summarizing is the same as using --max-depth=0");
		},
		Some(depth) if summarize => {
			return host.usage_error(format_args!("warning: summarizing conflicts with --max-depth={depth}"), 1);
		},
		_ => {},
	}
	let max_depth = if summarize { 0 } else { max_depth.unwrap_or(u64::MAX) };
	if inodes {
		if apparent {
			let _ = writeln!(host.stderr, "du: warning: options --apparent-size and -b are ineffective with --inodes");
		}
		block_size = block_size.with_bytes(1);
	}

	let time = if matches.contains_id(options::TIME)
		&& matches.value_source(options::TIME) == Some(clap::parser::ValueSource::CommandLine)
	{
		let kind = match matches.get_one::<String>(options::TIME).map(String::as_str) {
			None => TimeKind::Modification,
			Some("atime") => TimeKind::Access,
			Some(_) => TimeKind::Change,
		};
		let style = matches.get_one::<String>(options::TIME_STYLE).map(String::as_str);
		match time_format(host, style) {
			Ok(format) => Some((kind, format, shell_time_zone(host))),
			Err(message) => return host.usage_error(message, 1),
		}
	} else {
		None
	};

	let deref = match last_given(matches, &[options::DEREFERENCE, options::DEREFERENCE_ARGS, options::NO_DEREFERENCE]) {
		Some(options::DEREFERENCE) => Deref::Logical,
		Some(options::DEREFERENCE_ARGS) => Deref::CommandLine,
		_ => Deref::Physical,
	};

	let operands: Vec<&OsString> = matches.get_many::<OsString>(options::FILE).into_iter().flatten().collect();
	let files_from = matches.get_one::<OsString>(options::FILES0_FROM);
	let (names, hash_all, from_stdin, read_error) = if let Some(files_from) = files_from {
		if let Some(extra) = operands.first() {
			return host.usage_error(
				format_args!("extra operand {}\nfile operands cannot be combined with --files0-from", extra.quote()),
				1,
			);
		}
		let from_stdin = files_from == "-";
		let mut data = Vec::new();
		let mut read_failure = None;
		if from_stdin {
			if let Err(error) = host.stdin.read_to_end(&mut data) {
				read_failure = Some(error);
			}
		} else {
			match host.fs().open(host.resolve(files_from)) {
				Ok(mut file) => {
					if let Err(error) = file.read_to_end(&mut data) {
						read_failure = Some(error);
					}
				},
				Err(error) if error.kind() == io::ErrorKind::IsADirectory => read_failure = Some(error),
				Err(error) => {
					host.error(
						format_args!("cannot open {} for reading: {}", files_from.quote(), strip_errno(&error)),
						1,
					);
					return 1;
				},
			}
		}
		let mut names: Vec<Vec<u8>> = data.split(|&b| b == 0).map(<[u8]>::to_vec).collect();
		// A final name needs no terminator, and a terminator needs no name after
		// it; a read error loses the name it interrupted.
		if read_failure.is_some() || names.last().is_some_and(Vec::is_empty) {
			names.pop();
		}
		// Reported once the names read before the failure are processed.
		let read_error = read_failure
			.map(|error| format!("{}: read error: {}", files_from.maybe_quote(), strip_errno(&error)));
		(names, true, from_stdin, read_error)
	} else {
		let hash_all = operands.len() > 1 || deref == Deref::Logical;
		let names = if operands.is_empty() {
			vec![b".".to_vec()]
		} else {
			operands.iter().map(|operand| os_bytes_lossy(operand).into_owned()).collect()
		};
		(names, hash_all, false, None)
	};

	let cfg = Config {
		all,
		apparent,
		count_all: matches.get_flag(options::COUNT_LINKS),
		hash_all,
		separate_dirs: matches.get_flag(options::SEPARATE_DIRS),
		one_fs: matches.get_flag(options::ONE_FILE_SYSTEM),
		deref,
		max_depth,
		threshold,
		block_size,
		symbols: numeric_symbols(host),
		inodes,
		nul,
		time,
		quote_output,
		utf8: ctype_is_utf8(host),
		excludes,
	};
	let out = host.stdout_writer();
	let mut walker = Walker {
		host,
		out,
		cfg: &cfg,
		seen: HashSet::new(),
		ancestors: Vec::new(),
		mounts: None,
		total: DuInfo::default(),
		root_dev: None,
		ok: true,
		stopped: false,
		write_err: None,
	};
	for (index, name) in names.iter().enumerate() {
		if walker.check_stop() {
			break;
		}
		if from_stdin && name.as_slice() == b"-" {
			walker.error("when reading file names from standard input, no file name of '-' allowed");
			continue;
		}
		if name.is_empty() {
			match files_from {
				None => walker.error("invalid zero-length file name"),
				Some(files_from) => {
					walker.error(format_args!("{}:{}: invalid zero-length file name", files_from.maybe_quote(), index + 1));
				},
			}
			continue;
		}
		walker.root(name);
	}
	if let Some(message) = read_error {
		walker.error(message);
	}
	if matches.get_flag(options::TOTAL) {
		let grand = walker.total;
		walker.print(&grand, b"total", false);
	}
	let _ = walker.out.flush();
	if let Some(error) = walker.write_err.take() {
		if walker.host.sigpipe_hit() {
			return 1;
		}
		walker.error(format_args!("write error: {}", strip_errno(&error)));
		return 1;
	}
	if walker.ok { 0 } else { 1 }
}


