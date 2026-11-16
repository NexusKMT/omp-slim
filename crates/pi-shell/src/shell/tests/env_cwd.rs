use super::*;

/// Shell initialization must recover when a long-running host's inherited
/// working directory is deleted. This runs in a child process because cwd is
/// process-global.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn shell_initializes_after_process_cwd_is_deleted() {
	const MARKER: &str = "PI_SHELL_TEST_DELETED_CWD";
	if std::env::var_os(MARKER).is_none() {
		run_isolated_kill_test(
			"shell::tests::env_cwd::shell_initializes_after_process_cwd_is_deleted",
			MARKER,
			false,
		)
		.await;
		return;
	}

	let dir = tempfile::tempdir().expect("temporary cwd");
	std::env::set_current_dir(dir.path()).expect("enter temporary cwd");
	std::fs::remove_dir(dir.path()).expect("delete process cwd");

	let mut session = default_session().await;
	let fallback = std::env::var_os("HOME").map_or_else(|| "/".into(), std::path::PathBuf::from);
	assert_eq!(session.working_dir(), fallback);
	// The shell works there.
	let ran = session
		.run_test("pwd", &TestStdio::null())
		.await
		.expect("run");
	assert_eq!(ran.status, 0);
}

/// Regression for issue #8925: a host env entry whose key or value is not
/// valid Unicode must be skipped, not fatal. `std::env::vars()` panics on
/// the first one (e.g. the corrupt `GHOSTTY_BIN_DIR` cmux/Ghostty stages,
/// bytes `9d d9 50`) before any command runs; `copy_env_into` reads via
/// `vars_os()` and drops corrupt entries while still copying the rest and
/// merging duplicate `PATH` values.
#[cfg(unix)]
#[test]
fn copy_env_skips_non_utf8_entries_and_merges_path() {
	use std::os::unix::ffi::OsStringExt;

	// GHOSTTY_BIN_DIR with the corrupt bytes, a normal var, a corrupt key,
	// and a duplicate PATH — in host-env iteration order.
	let entries = vec![
		(std::ffi::OsString::from("PATH"), std::ffi::OsString::from("/usr/bin:/bin")),
		(
			std::ffi::OsString::from("GHOSTTY_BIN_DIR"),
			std::ffi::OsString::from_vec(vec![0x9d, 0xd9, 0x50]),
		),
		(std::ffi::OsString::from("HOME"), std::ffi::OsString::from("/home/tester")),
		(std::ffi::OsString::from_vec(vec![0xff, b'B', b'A', b'D']), std::ffi::OsString::from("x")),
		(std::ffi::OsString::from("PATH"), std::ffi::OsString::from("/opt/bin")),
	];
	let mut vars = HashMap::new();
	copy_env_into(&mut vars, entries.into_iter());

	let value = |name: &str| vars.get(name).cloned();
	assert_eq!(value("PATH").as_deref(), Some("/opt/bin"), "PATH is merged/preserved");
	assert_eq!(value("HOME").as_deref(), Some("/home/tester"), "valid entry copied");
	assert!(value("GHOSTTY_BIN_DIR").is_none(), "non-UTF-8 value must be skipped");
	assert!(value("BAD").is_none(), "non-UTF-8 key must be skipped");
}

/// The strip must stay narrowly scoped: unrelated `GIT_*` names are part of
/// the shell contract (`GIT_EDITOR`, author identity) and must survive.
#[test]
fn git_repo_location_vars_exclude_unrelated_git_names() {
	assert!(!is_git_repo_location_var("GIT_EDITOR"));
	assert!(!is_git_repo_location_var("GIT_AUTHOR_NAME"));
}

/// Regression for issue #11082: the embedded shell copies the host
/// environment, and repo-location overrides in it (git hooks, `git
/// --git-dir` wrappers) must not reach child commands — `git` would ignore
/// the command's `cwd` and mutate the worktree the agent was launched from.
#[test]
fn copy_env_skips_git_repo_location_overrides() {
	let entries = vec![
		(std::ffi::OsString::from("GIT_DIR"), std::ffi::OsString::from("/primary/.git")),
		(std::ffi::OsString::from("GIT_WORK_TREE"), std::ffi::OsString::from("/primary")),
		(std::ffi::OsString::from("GIT_INDEX_FILE"), std::ffi::OsString::from("/primary/.git/index")),
		(std::ffi::OsString::from("GIT_EDITOR"), std::ffi::OsString::from("true")),
	];
	let mut vars = HashMap::new();
	copy_env_into(&mut vars, entries.into_iter());

	let value = |name: &str| vars.get(name).cloned();
	assert!(value("GIT_DIR").is_none(), "GIT_DIR must not reach child commands");
	assert!(value("GIT_WORK_TREE").is_none(), "GIT_WORK_TREE must not reach child commands");
	assert!(value("GIT_INDEX_FILE").is_none(), "GIT_INDEX_FILE must not reach child commands");
	assert_eq!(value("GIT_EDITOR").as_deref(), Some("true"), "unrelated git vars are kept");
}

/// The per-session env overlay is built from the same host environment, so
/// it must not reintroduce the repo-location overrides.
#[tokio::test(flavor = "multi_thread")]
async fn session_env_does_not_export_git_repo_location_overrides() {
	let dir = tempfile::tempdir().expect("probe directory");
	let out = dir.path().join("probe");
	let mut env = HashMap::new();
	env.insert("GIT_DIR".to_string(), "/primary/.git".to_string());
	env.insert("OMP_GIT_ENV_PROBE".to_string(), "kept".to_string());
	let config = ShellConfig {
		session_env:   Some(env),
		snapshot_path: None,
		minimizer:     None,
		filesystem:    Fs::native(),
		seed:          None,
	};
	let mut session = create_session(&config).await.expect("create_session");

	let command = format!(
		"printf '%s|%s' \"${{GIT_DIR-unset}}\" \"$OMP_GIT_ENV_PROBE\" > {}",
		quote_arg(out.to_str().expect("utf8 probe path"))
	);
	session
		.run_test(command, &TestStdio::null())
		.await
		.expect("run probe");

	assert_eq!(fs::read_to_string(&out).expect("probe output"), "unset|kept");
}

/// The per-run env is the command's only: exported to what it runs, then
/// every name is back to what it was, and shell-owned names are not
/// overridden.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn per_run_env_is_scoped_to_the_run() {
	let _guard = shell_test_lock().lock().await;
	let shell = Shell::new(None);
	let run = async |command: &str, env: Option<HashMap<String, String>>| {
		let (tx, rx) = flume::unbounded();
		let result = shell
			.run(
				ShellRunOptions { command: command.into(), env, ..Default::default() },
				Some(tx),
				CancelToken::default(),
			)
			.await
			.expect("run");
		assert_eq!(result.exit_code, Some(0), "{command}");
		rx.drain().collect::<String>()
	};
	run("PI_SCOPED=before", None).await;
	let env = HashMap::from([
		("PI_SCOPED".to_owned(), "during".to_owned()),
		("PI_ONLY".to_owned(), "one".to_owned()),
		("SHLVL".to_owned(), "99".to_owned()),
	]);
	let during =
		run("printf '%s %s ' \"$PI_SCOPED\" \"$SHLVL\"; sh -c 'printf %s \"$PI_ONLY\"'", Some(env))
			.await;
	assert!(during.starts_with("during "), "{during}");
	assert!(!during.contains("99"), "a shell-owned name was overridden: {during}");
	assert!(during.ends_with("one"), "not exported to children: {during}");
	assert_eq!(
		run("printf '%s/%s' \"$PI_SCOPED\" \"${PI_ONLY-unset}\"", None).await,
		"before/unset"
	);
}

/// `cd -P`, `pwd -P` and `set -P` resolve symlinks (`..` is the real
/// parent); `cd -L`/`pwd` keep the name as typed.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn physical_cd_and_pwd_resolve_symlinks() {
	let dir = tempfile::tempdir().expect("scratch");
	let root = dir.path().canonicalize().expect("canonical scratch");
	std::fs::create_dir_all(root.join("real/sub")).expect("real dir");
	std::os::unix::fs::symlink(root.join("real/sub"), root.join("link")).expect("symlink");
	let (result, output) = run_command_capture(
		"cd link && pwd && pwd -P && cd -P .. && pwd; cd -P ../link && echo \"$PWD\"; cd ..; set \
		 -P; cd ../link && pwd",
		Some(&root),
		None,
		CancelToken::default(),
	)
	.await;
	assert_eq!(result.exit_code, Some(0), "{output}");
	let (link, real) = (root.join("link"), root.join("real/sub"));
	let expected = [link.as_path(), &real, &root.join("real"), &real, &real]
		.map(|p| format!("{}\n", p.display()))
		.concat();
	assert_eq!(output, expected);
}

/// A run's `cwd` moves the shell and is reported; a missing directory fails
/// the run (as a failed `cd` would), and the next run starts over with a
/// fresh session.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn run_cwd_moves_the_shell_and_rejects_missing_directories() {
	let _guard = shell_test_lock().lock().await;
	let dir = tempfile::tempdir().expect("cwd");
	let dir_path = dir.path().canonicalize().expect("canonical cwd");
	let shell = Shell::new(None);
	let result = shell
		.run(
			ShellRunOptions {
				command: "cd ..; cd - >/dev/null".into(),
				cwd: Some(dir_path.to_string_lossy().into_owned()),
				..Default::default()
			},
			None,
			CancelToken::default(),
		)
		.await
		.expect("run in cwd");
	assert_eq!(result.working_dir.as_deref(), Some(dir_path.to_string_lossy().as_ref()));
	let missing = dir_path.join("missing");
	let err = shell
		.run(
			ShellRunOptions {
				command: ":".into(),
				cwd: Some(missing.to_string_lossy().into_owned()),
				..Default::default()
			},
			None,
			CancelToken::default(),
		)
		.await
		.expect_err("a missing cwd fails the run");
	assert!(err.to_string().contains("Failed to set cwd"), "{err}");
}
