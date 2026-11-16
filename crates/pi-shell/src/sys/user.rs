//! The current user as the shell reports it (`UID`, `EUID`, `GID`,
//! `GROUPS`, `USER`/`HOME`).

use bstr::BString;

use crate::bash::UserInfo;

/// The current user: ids, groups, and `USER`/`HOME` of the process
/// environment.
pub fn read_user() -> UserInfo {
	let var = |k: &str| {
		std::env::var_os(k).map_or_else(BString::default, |v| BString::from(v.as_encoded_bytes()))
	};
	// SAFETY: getuid/geteuid/getgid have no preconditions.
	let (uid, euid, gid) = unsafe { (libc::getuid(), libc::geteuid(), libc::getgid()) };
	let (name, home) = { (var("USER"), var("HOME")) };
	UserInfo { uid, euid, gid, groups: groups(), name, home }
}

/// The effective uid and gid files read as owned by.
pub fn owner() -> (u32, u32) {
	// SAFETY: `geteuid` and `getegid` always succeed and touch no memory.
	unsafe { (libc::geteuid(), libc::getegid()) }
}

/// The process's supplementary group ids (`GROUPS`); empty where the
/// platform has none or `getgroups` fails.
fn groups() -> Vec<u32> {
	// SAFETY: a zero count with a null pointer only asks for the count.
	let n = unsafe { libc::getgroups(0, std::ptr::null_mut()) };
	let Ok(len) = usize::try_from(n) else {
		return Vec::new();
	};
	let mut ids: Vec<libc::gid_t> = vec![0; len];
	// SAFETY: `ids` has room for `n` entries; getgroups writes at most
	// that many and returns how many it wrote.
	let got = unsafe { libc::getgroups(n, ids.as_mut_ptr()) };
	ids.truncate(usize::try_from(got).unwrap_or(0));
	ids
}
