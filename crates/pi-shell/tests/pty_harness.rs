//! Self-test of the pty harness (`tests/pty_support`): its screen model and
//! the real zsh driven interactively.

#![cfg(unix)]

mod pty_support;

use std::io;

use pty_support::{Screen, Spawn, TIMEOUT, have_real_zsh};

#[test]
fn the_screen_model_prints_wraps_and_erases() {
	let mut s = Screen::new(3, 5);
	s.feed(b"abcdefg\r\nxy\x1b[1;2H\x1b[K");
	assert_eq!(s.contents(), "a\nfg\nxy");
	s.feed(b"\x1b[2J\x1b[Hhi\x1b[6n");
	assert_eq!(s.contents(), "hi");
	assert_eq!(s.take_replies(), b"\x1b[1;3R");
}

#[test]
fn the_screen_model_scrolls_and_switches_screens() {
	let mut s = Screen::new(2, 4);
	s.feed(b"1\r\n2\r\n3");
	assert_eq!(s.contents(), "2\n3");
	s.feed(b"\x1b[?1049hX\x1b[?1049l");
	assert_eq!(s.contents(), "2\n3");
	s.feed("\x1b]0;title\x07é漢".as_bytes());
	assert_eq!(s.row(1), "3é漢");
	s.resize(3, 6);
	assert_eq!(s.contents(), "2\n3é漢");
}

/// The harness drives a real interactive zsh: prompt, a command, a resize
/// it notices (`SIGWINCH`), `exit`.
#[test]
fn drives_the_real_zsh_interactively() -> io::Result<()> {
	if !have_real_zsh() {
		return Ok(());
	}
	let mut zsh = Spawn::real_zsh()
		.args(["-f", "-i"])
		.env("PS1", "P> ")
		.spawn()?;
	// Screen rows are compared without trailing blanks.
	zsh.wait_screen_contains("P>", TIMEOUT)?;
	zsh.write("print -r -- $((6*7))\r")?;
	zsh.wait_screen_contains("42", TIMEOUT)?;
	zsh.resize(30, 100)?;
	zsh.write("print -r -- size=$LINES:$COLUMNS\r")?;
	zsh.wait_screen_contains("size=30:100", TIMEOUT)?;
	zsh.write("exit 3\r")?;
	assert_eq!(zsh.wait(TIMEOUT)?.code(), Some(3));
	Ok(())
}
