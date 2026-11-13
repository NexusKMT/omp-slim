//! `sponge` builtin: soak up all of standard input before writing it to a file
//! or standard output.
//!
//! Ported from pi-shell's in-process implementation of the moreutils tool. The
//! delayed open makes `command < file | sponge file` safe: the destination is
//! not opened or truncated until its former contents have reached EOF.

use std::{
	ffi::OsString,
	io::{self, Read, Write},
	path::Path,
};

use clap::{Arg, ArgAction, ArgMatches, Command};
use pi_vfs::{BlockingFs, OpenOptions};

use crate::{
	atomic_write,
	host::{Host, Utility, format_usage, matches_parser},
};

const OPT_APPEND: &str = "append";
const ARG_FILE: &str = "file";
const CHUNK_SIZE: usize = 64 * 1024;

/// Parsed `sponge` invocation.
pub(crate) struct Sponge {
	matches: ArgMatches,
}

matches_parser!(Sponge, command);

impl Utility for Sponge {
	const NAME: &'static str = "sponge";

	fn run(self, host: &mut Host) -> i32 {
		// Soak before resolving or opening the destination. In particular, do not
		// move this below the output-operand branch: stdin may be that same file.
		let buffer = match soak_stdin(host) {
			Ok(buffer) => buffer,
			Err(SoakError::Cancelled) => return 130,
			Err(SoakError::Io(err)) => {
				host.error(format_args!("stdin: {err}"), 1);
				return 1;
			},
		};

		let Some(file) = self.matches.get_one::<OsString>(ARG_FILE) else {
			if let Err(err) = host.stdout.write_all(&buffer).and_then(|()| host.stdout.flush()) {
				host.error(format_args!("stdout: {err}"), 1);
				return 1;
			}
			return 0;
		};

		let target = host.resolve(file);
		let fs = host.fs();
		let result = if self.matches.get_flag(OPT_APPEND) {
			append_to(fs, &target, &buffer)
		} else {
			atomic_write::replace(fs, &target, &buffer, Self::NAME)
		};
		match result {
			Ok(()) => 0,
			Err(err) => {
			host.error(format_args!("{}: {err}", file.display()), 1);
				1
			},
		}
	}
}

fn command() -> Command {
	Command::new("sponge")
		.version("sponge (pi-shell) 17.2.11")
		.about("Soak up all standard input, then write it to a file.")
		.override_usage(format_usage("sponge [-a] [FILE]"))
		.disable_help_flag(true)
		.disable_version_flag(true)
		.arg(
			Arg::new(OPT_APPEND)
				.short('a')
				.long(OPT_APPEND)
				.help("append the soaked input to the file instead of replacing it")
				.action(ArgAction::SetTrue),
		)
		.arg(Arg::new("help").long("help").action(ArgAction::Help))
		.arg(
			Arg::new("version")
				.long("version")
				.action(ArgAction::Version),
		)
		.arg(
			Arg::new(ARG_FILE)
				.value_name("FILE")
				.value_parser(clap::value_parser!(OsString)),
		)
}

enum SoakError {
	Cancelled,
	Io(io::Error),
}

/// Reads stdin to EOF into memory, polling for cancellation between chunks so
/// an aborted pipeline never touches the output file.
fn soak_stdin(host: &mut Host) -> Result<Vec<u8>, SoakError> {
	let mut buffer = Vec::new();
	let mut chunk = vec![0u8; CHUNK_SIZE].into_boxed_slice();
	loop {
		if host.is_cancelled() {
			return Err(SoakError::Cancelled);
		}
		match host.stdin.read(&mut chunk) {
			Ok(0) if host.is_cancelled() => return Err(SoakError::Cancelled),
			Ok(0) => return Ok(buffer),
			Ok(n) => buffer.extend_from_slice(&chunk[..n]),
			Err(err) if err.kind() == io::ErrorKind::Interrupted => {},
			Err(err) => return Err(SoakError::Io(err)),
		}
	}
}

fn append_to(fs: &BlockingFs, target: &Path, buffer: &[u8]) -> io::Result<()> {
	let mut file = fs.open_with(target, OpenOptions::new().append(true).create(true))?;
	file.write_all(buffer)?;
	file.close()
}


