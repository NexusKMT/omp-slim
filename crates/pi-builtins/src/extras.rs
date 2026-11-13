//! pi's extra commands for an embedding shell.
//!
//! The extras are the in-process utilities (`cat`, `sort`, `grep`, `sed`, …)
//! and the process builtins (`ps`, `top`, `sleep`, `pgrep`, `pkill`,
//! `pidwait`). A host fills an [`Invocation`] and awaits [`run`]; one table,
//! [`extras`], names every extra this build compiled.
//!
//! [`run`] must be awaited on a tokio runtime: synchronous utilities run on its
//! blocking pool, and process builtins use its timers.

use std::sync::LazyLock;

use futures::future::BoxFuture;

#[allow(unused_imports, reason = "the table names whichever modules the enabled features compile")]
use super::*;
pub use crate::{
	host::{CommandRunner, CommandStatus, EnvChange, Invocation, ShellCommand},
	openfile::Fd,
};
#[allow(unused_imports, reason = "used by whichever table entries the enabled features compile")]
use crate::host::{AsyncUtility, Process, Utility, run_async_utility, run_process, run_utility};

/// Invokes `$callback!` with one line per extra:
/// `kind [cfg predicate] "name" type;`.
///
/// Kinds:
/// - `utility` / `async_utility`: a [`Utility`] / [`AsyncUtility`].
/// - `process`: a [`Process`] builtin.
///
/// The predicate is the cargo feature (and platform) gate the module itself
/// is compiled under.
macro_rules! for_each_extra {
	($callback:ident) => {
		$callback! {
			async_utility [feature = "util.ast-grep"] "ast-grep" ast_grep::AstGrep;
			async_utility [feature = "util.ast-grep"] "sg" ast_grep::AstGrep;
			utility [feature = "util.b2sum"] "b2sum" b2sum::B2sum;
			utility [feature = "util.base32"] "base32" base32::Base32;
			utility [feature = "util.base64"] "base64" base64::Base64;
			utility [feature = "util.basename"] "basename" basename::Basename;
			utility [feature = "util.cat"] "cat" cat::Cat;
			utility [all(feature = "util.chmod", unix)] "chmod" chmod::Chmod;
			utility [feature = "util.cksum"] "cksum" cksum::Cksum;
			utility [feature = "util.cmp"] "cmp" cmp::Cmp;
			utility [feature = "util.comm"] "comm" comm::Comm;
			utility [feature = "util.cp"] "cp" cp::Cp;
			utility [feature = "util.combine"] "combine" combine::Combine;
			utility [feature = "util.cut"] "cut" cut::Cut;
			utility [feature = "util.date"] "date" date::Date;
			utility [feature = "util.dd"] "dd" dd::Dd;
			utility [feature = "util.df"] "df" df::Df;
			utility [feature = "util.diff"] "diff" diff::Diff;
			utility [feature = "util.dirname"] "dirname" dirname::Dirname;
			utility [feature = "util.du"] "du" du::Du;
			utility [feature = "util.env"] "env" env::Env;
			utility [all(feature = "util.errno", unix)] "errno" errno::Errno;
			async_utility [feature = "util.fd"] "fd" fd::FdCli;
			async_utility [feature = "util.find"] "find" find::Find;
			utility [feature = "util.fold"] "fold" fold::Fold;
			async_utility [feature = "util.grep"] "grep" grep::Grep;
			async_utility [feature = "util.rg"] "rg" rg::Rg;
			utility [feature = "util.head"] "head" head::Head;
			utility [feature = "util.hostname"] "hostname" hostname::Hostname;
			utility [all(feature = "util.id", unix)] "id" id::Id;
			utility [feature = "util.ifne"] "ifne" ifne::Ifne;
			utility [feature = "util.isutf8"] "isutf8" isutf8::Isutf8;
			utility [feature = "util.jq"] "jq" jq::Jq;
			utility [feature = "util.ln"] "ln" ln::Ln;
			utility [feature = "util.ls"] "ls" ls::Ls;
			utility [feature = "util.md5sum"] "md5sum" md5sum::Md5sum;
			utility [feature = "util.mkdir"] "mkdir" mkdir::Mkdir;
			utility [feature = "util.mktemp"] "mktemp" mktemp::Mktemp;
			utility [feature = "util.mv"] "mv" mv::Mv;
			utility [feature = "util.nl"] "nl" nl::Nl;
			utility [feature = "util.nproc"] "nproc" nproc::Nproc;
			utility [feature = "util.od"] "od" od::Od;
			utility [feature = "util.paste"] "paste" paste::Paste;
			utility [feature = "util.printenv"] "printenv" printenv::Printenv;
			utility [feature = "util.readlink"] "readlink" readlink::Readlink;
			utility [feature = "util.realpath"] "realpath" realpath::Realpath;
			utility [feature = "util.rm"] "rm" rm::Rm;
			utility [feature = "util.rmdir"] "rmdir" rmdir::Rmdir;
			utility [all(feature = "util.rsync", any(unix, windows))] "rsync" rsync::Rsync;
			utility [feature = "util.sd"] "sd" sd::Sd;
			utility [feature = "util.sed"] "sed" sed::Sed;
			utility [feature = "util.seq"] "seq" seq::Seq;
			utility [feature = "util.sha1sum"] "sha1sum" sha1sum::Sha1sum;
			utility [feature = "util.sha224sum"] "sha224sum" sha224sum::Sha224sum;
			utility [feature = "util.sha256sum"] "sha256sum" sha256sum::Sha256sum;
			utility [feature = "util.sha384sum"] "sha384sum" sha384sum::Sha384sum;
			utility [feature = "util.sha512sum"] "sha512sum" sha512sum::Sha512sum;
			utility [feature = "util.sort"] "sort" sort::Sort;
			utility [feature = "util.sponge"] "sponge" sponge::Sponge;
			utility [feature = "util.stat"] "stat" stat::Stat;
			utility [feature = "util.tac"] "tac" tac::Tac;
			utility [feature = "util.tail"] "tail" tail::Tail;
			utility [feature = "util.tee"] "tee" tee::Tee;
			utility [feature = "util.touch"] "touch" touch::Touch;
			utility [feature = "util.tr"] "tr" tr::Tr;
			utility [feature = "util.truncate"] "truncate" truncate::Truncate;
			utility [feature = "util.ts"] "ts" ts::Ts;
			utility [feature = "util.uname"] "uname" uname::Uname;
			utility [feature = "util.uniq"] "uniq" uniq::Uniq;
			utility [feature = "util.uptime"] "uptime" uptime::Uptime;
			utility [feature = "util.wc"] "wc" wc::Wc;
			utility [feature = "util.which"] "which" which::WhichCli;
			utility [feature = "util.whoami"] "whoami" whoami::Whoami;
			utility [feature = "util.xargs"] "xargs" xargs::Xargs;
			utility [feature = "util.yes"] "yes" yes::Yes;
			process [feature = "util.pgrep"] "pgrep" pgrep::PgrepCommand;
			process [feature = "util.pidwait"] "pidwait" pidwait::PidwaitCommand;
			process [feature = "util.pkill"] "pkill" pkill::PkillCommand;
			process [feature = "util.ps"] "ps" ps::PsCommand;
			process [feature = "util.sleep"] "sleep" sleep::SleepCommand;
			process [feature = "util.top"] "top" top::TopCommand;
		}
	};
}

/// How a host runs an extra, and what it must supply.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExtraKind {
	/// An in-process utility (`cat`, `sort`, `grep`, …), run by [`run`].
	Utility {
		/// The utility runs command lines (`env`, `ifne`, `xargs`, `find
		/// -exec`): give its [`Invocation::commands`] a [`CommandRunner`], or
		/// it reports that it cannot run commands.
		runs_commands: bool,
	},
	/// A process builtin (`ps`, `top`, `sleep`, `pgrep`, `pkill`,
	/// `pidwait`), run by [`run`].
	Process,
}

type RunFn = fn(Invocation) -> BoxFuture<'static, i32>;

/// One row of the table.
struct Extra {
	name: &'static str,
	kind: ExtraKind,
	run:  RunFn,
}

fn utility<U: Utility>(invocation: Invocation) -> BoxFuture<'static, i32> {
	Box::pin(run_utility::<U>(invocation))
}

fn async_utility<U: AsyncUtility>(invocation: Invocation) -> BoxFuture<'static, i32> {
	Box::pin(run_async_utility::<U>(invocation))
}

fn process<P: Process>(invocation: Invocation) -> BoxFuture<'static, i32> {
	Box::pin(run_process::<P>(invocation))
}

macro_rules! extra_row {
	(utility, $name:literal, $ty:path) => {
		Extra {
			name: $name,
			kind: ExtraKind::Utility { runs_commands: <$ty as Utility>::RUNS_COMMANDS },
			run:  utility::<$ty>,
		}
	};
	(async_utility, $name:literal, $ty:path) => {
		Extra {
			name: $name,
			kind: ExtraKind::Utility { runs_commands: <$ty as AsyncUtility>::RUNS_COMMANDS },
			run:  async_utility::<$ty>,
		}
	};
	(process, $name:literal, $ty:path) => {
		Extra { name: $name, kind: ExtraKind::Process, run: process::<$ty> }
	};
}

macro_rules! extra_table {
	($($kind:ident [$cfg:meta] $name:literal $ty:path;)*) => {{
		#[allow(unused_mut, reason = "empty when no extra features are enabled")]
		let mut table = Vec::new();
		$(
			#[cfg($cfg)]
			table.push(extra_row!($kind, $name, $ty));
		)*
		table
	}};
}

/// Every extra compiled into this build.
static EXTRAS: LazyLock<Vec<Extra>> = LazyLock::new(|| for_each_extra!(extra_table));

fn find(name: &str) -> Option<&'static Extra> {
	EXTRAS.iter().find(|extra| extra.name == name)
}

/// Every extra a host must expose for pi's command set, by name, under the
/// cargo features this build enabled.
pub fn extras() -> impl Iterator<Item = (&'static str, ExtraKind)> {
	EXTRAS.iter().map(|extra| (extra.name, extra.kind))
}

/// The kind of the extra named `name`, or `None` when no extra has that name.
#[must_use]
pub fn kind(name: &str) -> Option<ExtraKind> {
	find(name).map(|extra| extra.kind)
}

/// Runs the extra named [`Invocation::name`] to completion, returning its
/// exit status: 130 once [`Invocation::cancel`] fires (unless the utility
/// reports its own end, as `rsync` does).
///
/// An unknown name reports `<name>: not a pi extra` on stderr with status
/// 127.
pub async fn run(invocation: Invocation) -> i32 {
	if let Some(extra) = find(&invocation.name) {
		return (extra.run)(invocation).await;
	}
	let Invocation { name, stdio: [_, _, stderr], .. } = invocation;
	crate::host::report_async(
		crate::openfile::OpenFile::from_fd(stderr),
		format!("{name}: not a pi extra\n"),
	)
	.await;
	127
}


