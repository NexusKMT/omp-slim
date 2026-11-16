//! `whoami` builtin: print the effective user's name.
//!
//! Ported from uutils coreutils 0.8.0.

use std::io::Write;

use clap::{ArgMatches, Command};

use crate::host::{Host, Utility, matches_parser, os_bytes};

mod platform {
	#[cfg(unix)]
	pub use self::unix::get_username;

	#[cfg(unix)]
	mod unix {
		use std::{ffi::OsString, io};

		use uucore::{entries::uid2usr, process::geteuid};

		pub fn get_username() -> io::Result<OsString> {
			// uid2usr should arguably return an OsString but currently doesn't
			uid2usr(geteuid()).map(Into::into)
		}
	}

}

/// Parsed `whoami` invocation.
pub(crate) struct Whoami {
	matches: ArgMatches,
}

matches_parser!(Whoami, app);

impl Utility for Whoami {
	const NAME: &'static str = "whoami";

	fn run(self, host: &mut Host) -> i32 {
		let _ = self.matches;
		let username = match platform::get_username() {
			Ok(username) => username,
			Err(err) => {
				host.error(format!("failed to get username: {err}"), 1);
				return 1;
			},
		};
		let Some(username) = os_bytes(&username) else {
			host.error("failed to print username: username cannot be represented as bytes", 1);
			return 1;
		};
		let result = host
			.stdout
			.write_all(username)
			.and_then(|()| host.stdout.write_all(b"\n"))
			.and_then(|()| host.stdout.flush());
		if let Err(err) = result {
			host.error(format!("failed to print username: {err}"), 1);
			return 1;
		}
		0
	}
}

/// The `whoami` argument model.
fn app() -> Command {
	Command::new(Whoami::NAME)
		.version("0.8.0")
		.about("Print the current username.")
		.override_usage("whoami")
		.infer_long_args(true)
}

#[cfg(test)]
mod tests {
	use super::Whoami;
	use crate::host::run_util;

	#[test]
	fn prints_process_user_with_trailing_newline() {
		let (code, capture) = run_util::<Whoami>(&[], "", "/");
		assert_eq!((code, capture.err()), (0, String::new()));
		let stdout = capture.out();
		assert!(stdout.ends_with('\n'));
		assert!(!stdout.trim_end().is_empty());
	}

	#[test]
	fn rejects_operands() {
		let (code, capture) = run_util::<Whoami>(&["extra"], "", "/");
		assert_eq!(code, 1);
		assert_eq!(capture.out(), "");
		assert!(!capture.err().is_empty(), "clap usage error must go to stderr");
	}

	#[test]
	fn help_renders_to_stdout() {
		let (code, capture) = run_util::<Whoami>(&["--help"], "", "/");
		assert_eq!((code, capture.err()), (0, String::new()));
		assert!(capture.out().contains("Print the current username."));
	}
}
