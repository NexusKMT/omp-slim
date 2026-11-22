//! [`Profile::Tool`]: a shell a program drives (an agent's `bash` tool)
//! touches none of its user's interactive state. Each case runs the same
//! input as a user's shell and as a tool's: the user's shell shows the
//! state is there to touch.

use crate::{
	bash::{ModeId, Origin, Profile, Script, ShellInit},
	testkit::{
		FakeHost, Fault, MemFs,
		fault::{Rig, skeleton_init},
	},
};

/// What a run left: stdout, stderr, status.
struct Ran {
	out:    String,
	err:    String,
	status: i32,
}

/// Run `src` in a shell of `mode` and `profile` over `fs` (`HOME=/h`):
/// read from standard input by an interactive shell when `interactive`,
/// else as `-c`.
fn run(mode: ModeId, profile: Profile, fs: &MemFs, interactive: bool, src: &str) -> Ran {
	let init = ShellInit {
		mode,
		argv0: "bash".into(),
		interactive,
		profile,
		env: vec![
			("PATH".into(), "/usr/bin:/bin".into()),
			("HOME".into(), "/h".into()),
			("PS1".into(), "".into()),
		],
		options: Vec::new(),
		..skeleton_init(&[])
	};
	let mut host = FakeHost::new().with_fs(fs.clone());
	if interactive {
		host = host.with_stdin(src.as_bytes());
	}
	let mut rig = Rig::new(host, init);
	let script = if interactive {
		Script { origin: Origin::Stdin, ..Script::command(Vec::new()) }
	} else {
		Script::command(src.as_bytes().to_vec())
	};
	let status = rig.run(script, Fault::None);
	Ran {
		out: String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned(),
		err: String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned(),
		status,
	}
}

/// A history file and a home directory.
fn home() -> MemFs {
	let fs = MemFs::new();
	fs.add_file("/h/hist", b": 1600000000:5;echo old\n", 0o600);
	fs
}

/// An interactive bash: the tool's records nothing, `history -r/-w` fail,
/// and it has no programmable completion (`compgen`, `complete`) or
/// readline bindings (`bind`), as a bash built without readline.
#[test]
fn bash_history_and_completion() {
	let src = "set -o history\necho a\nhistory -w /h/b; echo st=$?\nhistory -r /h/hist; echo \
	           st=$?\nhistory\ncompgen -W xy x; complete -F f g; bind -l >/dev/null; echo st=$?\n";
	let user = home();
	let ran = run(ModeId::Bash, Profile::User, &user, true, src);
	assert!(ran.out.contains("st=0\nst=0\n"), "{}", ran.out);
	assert!(ran.out.contains("echo a") && ran.out.contains("\nxy\nst=0\n"), "{}", ran.out);
	assert!(user.read("/h/b").is_some());

	let tool = home();
	let ran = run(ModeId::Bash, Profile::Tool, &tool, true, src);
	assert_eq!(ran.out, "a\nst=1\nst=1\nst=127\n");
	assert!(tool.read("/h/b").is_none());
	for cmd in ["compgen", "complete", "bind"] {
		assert!(ran.err.contains(&format!("{cmd}: command not found")), "{}", ran.err);
	}
}

/// A nested interactive `bash -i` started by a tool shell reads the
/// non-interactive startup files only: no `.bashrc`, where completion and
/// history are set up.
#[test]
fn nested_interactive_shells_skip_rc_files() {
	let fs = MemFs::new();
	fs.add_file("/h/.bashrc", b"echo bashrc\n", 0o644);
	let src = "bash -i -c 'echo bcmd'";
	let ran = run(ModeId::Bash, Profile::User, &fs, false, src);
	for line in ["bashrc", "bcmd"] {
		assert!(ran.out.lines().any(|l| l == line), "user shell missed {line}: {}", ran.out);
	}
	let ran = run(ModeId::Bash, Profile::Tool, &fs, false, src);
	assert!(ran.out.lines().any(|l| l == "bcmd"), "tool shell missed bcmd: {}", ran.out);
	assert!(!ran.out.contains("bashrc"), "{}", ran.out);
	assert_eq!(ran.status, 0);
}
