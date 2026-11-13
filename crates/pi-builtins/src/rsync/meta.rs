//! Local attribute handling: destination permissions (`dest_mode`), mtime
//! comparison (`--modify-window`), applying owner/group/perms/times to a
//! transferred entry (`set_file_attrs`), the attribute part of itemizing, and
//! the `--fake-super` stat xattr.
//!
//! Every filesystem access goes through [`Tree`]. Failures are reported through
//! the [`Logger`] at [`LogCode::ErrorXfer`] with upstream's wording; the logger
//! records those so the run ends with `RERR_PARTIAL` (23).

use std::{
	ffi::OsStr,
	io,
	path::Path,
	time::{SystemTime, UNIX_EPOCH},
};

use pi_vfs::{FileTime, FileType, Metadata, Permissions};

use crate::rsync::{
	time::system_time,
	consts::{
		ACCESSPERMS, CHMOD_BITS, FLAG_DIR_CREATED, FLAG_SKIP_GROUP, FLAG_TIME_FAILED,
		ITEM_LOCAL_CHANGE, ITEM_MATCHED, S_IFMT, S_ISGID, S_ISUID,
		ITEM_REPORT_ACL, ITEM_REPORT_ATIME, ITEM_REPORT_CHANGE, ITEM_REPORT_CRTIME,
		ITEM_REPORT_GROUP, ITEM_REPORT_OWNER, ITEM_REPORT_PERMS, ITEM_REPORT_SIZE,
		ITEM_REPORT_TIME, ITEM_REPORT_TIMEFAIL, ITEM_TRANSFER, ITEM_XNAME_FOLLOWS, mode_is_device,
		mode_is_dir, mode_is_lnk, mode_is_reg, mode_is_special,
	},
	exit::{RERR_FILEIO, RsyncError},
	flist::FileEntry,
	log::{self, LogCode, Logger},
	tree::Tree,
};

/// `set_file_attrs` flag: print the `--info=name2` "uptodate" line.
pub(crate) const ATTRS_REPORT: u32 = 1 << 0;
/// `set_file_attrs` flag: leave the modification time alone.
pub(crate) const ATTRS_SKIP_MTIME: u32 = 1 << 1;
/// `set_file_attrs` flag: compare times exactly (ignore `--modify-window`).
pub(crate) const ATTRS_ACCURATE_TIME: u32 = 1 << 2;
/// `set_file_attrs` flag: leave the access time alone.
pub(crate) const ATTRS_SKIP_ATIME: u32 = 1 << 3;
/// `set_file_attrs` flag: leave the creation time alone.
pub(crate) const ATTRS_SKIP_CRTIME: u32 = 1 << 5;

/// Name of the `--fake-super` stat xattr (upstream `XSTAT_ATTR`): Linux keeps it in
/// the `user.` namespace, platforms without xattr namespaces use the bare name.
#[cfg(any(target_os = "linux", target_os = "android"))]
pub(crate) const XSTAT_ATTR: &str = "user.rsync.%stat";
/// Name of the `--fake-super` stat xattr (upstream `XSTAT_ATTR`).
#[cfg(not(any(target_os = "linux", target_os = "android")))]
pub(crate) const XSTAT_ATTR: &str = "rsync.%stat";

/// The stat xattr is read into a 256-byte buffer upstream; longer values fail with ERANGE.
const XSTAT_MAX: usize = 255;

/// Attribute-preservation options.
#[derive(Clone, Debug, Default)]
pub(crate) struct MetaOpts {
	/// `-p`.
	pub perms: bool,
	/// `-E`.
	pub executability: bool,
	/// `-o`.
	pub owner: bool,
	/// `-g`.
	pub group: bool,
	/// Running as root, or `--super`: ownership may be changed.
	pub am_root: bool,
	/// `--fake-super`: ownership, special bits, and device numbers live in [`XSTAT_ATTR`].
	pub fake_super: bool,
	/// `-t`.
	pub times: bool,
	/// `-O`.
	pub omit_dir_times: bool,
	/// `-J`, or symlink times are known to be unsettable.
	pub omit_link_times: bool,
	/// `-U`.
	pub atimes: bool,
	/// `-N`.
	pub crtimes: bool,
	/// `--modify-window` (negative: compare nanoseconds too).
	pub modify_window: i64,
	/// `-A`.
	pub acls: bool,
	/// `-X`.
	pub xattrs: bool,
	/// `-n`.
	pub dry_run: bool,
	/// `-L`: entries are statted through symlinks.
	pub copy_links: bool,
	/// `-K`: a symlink to a directory counts as the directory when re-statting.
	pub keep_dirlinks: bool,
}

impl MetaOpts {
	/// Whether ownership differences count (root, `--super`, or `--fake-super`).
	fn root_like(&self) -> bool {
		self.am_root || self.fake_super
	}
}

/// Upstream dest_mode: permissions for a destination given the sender's mode and
/// what exists.
///
/// With `-p` the sender's mode stands. Otherwise an existing entry keeps its
/// permissions (with `-E` adjusting execute bits of regular files), and a new one
/// gets the sender's mode limited to `dflt_perms` (the parent directory's default
/// ACL when `-A` is compiled in, else `0777 & ~umask`).
pub(crate) fn dest_mode_with(
	flist_mode: u32,
	existing_mode: Option<u32>,
	exists: bool,
	dflt_perms: u32,
	opts: &MetaOpts,
) -> u32 {
	if opts.perms {
		return flist_mode;
	}
	let Some(stat_mode) = existing_mode.filter(|_| exists) else {
		// New entry: default permissions, special bits dropped.
		return flist_mode & (!CHMOD_BITS | dflt_perms);
	};
	let mut mode = (flist_mode & !CHMOD_BITS) | (stat_mode & CHMOD_BITS);
	if opts.executability && mode_is_reg(flist_mode) {
		if flist_mode & 0o111 == 0 {
			mode &= !0o111;
		} else if stat_mode & 0o111 == 0 {
			// Executable for everyone who may read, only if not executable at all yet.
			mode |= (mode & 0o444) >> 2;
		}
	}
	mode
}

/// Time equality under `--modify-window`: `0` compares seconds, a negative
/// window compares seconds and nanoseconds, a positive one allows that many
/// seconds of difference (nanoseconds ignored).
pub(crate) fn same_time(a_sec: i64, a_nsec: u32, b_sec: i64, b_nsec: u32, window: i64) -> bool {
	match window {
		0 => a_sec == b_sec,
		..0 => a_sec == b_sec && a_nsec == b_nsec,
		w => a_sec.abs_diff(b_sec) <= w.unsigned_abs(),
	}
}

/// same_mtime with --modify-window and nsec rules.
pub(crate) fn same_mtime(entry: &FileEntry, local: &Metadata, opts: &MetaOpts) -> bool {
	mtime_matches(entry, local, opts, false)
}

/// [`same_mtime`], or with `accurate` an exact seconds+nanoseconds comparison
/// (used after a transfer or a checksum match, `ATTRS_ACCURATE_TIME`).
pub(crate) fn mtime_matches(
	entry: &FileEntry,
	local: &Metadata,
	opts: &MetaOpts,
	accurate: bool,
) -> bool {
	mtime_equal(entry, Snap::of(local).mtime, opts.modify_window, accurate)
}

fn mtime_equal(entry: &FileEntry, local: Option<(i64, u32)>, window: i64, accurate: bool) -> bool {
	let Some((sec, nsec)) = local else {
		return false;
	};
	if accurate {
		return sec == entry.mtime && nsec == entry.mtime_nsec;
	}
	same_time(entry.mtime, entry.mtime_nsec, sec, nsec, window)
}

/// Upstream's `symlink_timeset_failed_flags`: what itemize reports for a symlink
/// whose time could not be set (`FLAG_TIME_FAILED`).
pub(crate) const fn symlink_timeset_failed_flags(protocol: u32, am_server: bool) -> u32 {
	ITEM_REPORT_TIME | if protocol >= 30 || !am_server { ITEM_REPORT_TIMEFAIL } else { 0 }
}

/// Itemize context beyond the two stats (what [`attr_changes_with`] consults).
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct ItemCtx<'a> {
	/// iflags gathered so far (`ITEM_TRANSFER`, `ITEM_LOCAL_CHANGE`, `ITEM_MATCHED`,
	/// `ITEM_XNAME_FOLLOWS`).
	pub iflags: u32,
	/// The xname sent with `ITEM_XNAME_FOLLOWS`.
	pub xname: Option<&'a [u8]>,
	/// The local creation time when already known (else taken from the metadata).
	pub crtime: Option<i64>,
	/// [`symlink_timeset_failed_flags`] for this session.
	pub timeset_failed_flags: u32,
}

/// Itemize helper: ITEM_REPORT_* bits for differences between `entry` and `local`
/// (upstream itemize's attribute part).
///
/// Covers size (regular files), time, atime, crtime, perms, owner, and group;
/// ACL and xattr bits come from `acl.rs` / `xattr.rs`. With fake-super, pass the
/// overlaid metadata from [`x_lstat`]. `ctx` decides `T` for entries whose time is
/// not preserved and for symlinks whose time could not be set.
pub(crate) fn attr_changes_with(
	entry: &FileEntry,
	local: &Metadata,
	opts: &MetaOpts,
	ctx: &ItemCtx<'_>,
) -> u32 {
	let cur = Snap::of(local);
	let mut bits = 0;
	let keep_time = opts.times
		&& if mode_is_dir(entry.mode) {
			!opts.omit_dir_times
		} else if mode_is_lnk(entry.mode) {
			!opts.omit_link_times
		} else {
			true
		};

	if mode_is_reg(entry.mode) && entry.size != cur.size {
		bits |= ITEM_REPORT_SIZE;
	}
	if entry.flags & FLAG_TIME_FAILED != 0 {
		if ctx.iflags & ITEM_LOCAL_CHANGE != 0 {
			bits |= ctx.timeset_failed_flags;
		}
	} else if keep_time {
		if !mtime_equal(entry, cur.mtime, opts.modify_window, false) {
			bits |= ITEM_REPORT_TIME;
		}
	} else if ctx.iflags & (ITEM_TRANSFER | ITEM_LOCAL_CHANGE) != 0
		&& ctx.iflags & ITEM_MATCHED == 0
		&& (ctx.iflags & ITEM_XNAME_FOLLOWS == 0 || ctx.xname.is_some_and(|x| !x.is_empty()))
	{
		bits |= ITEM_REPORT_TIME;
	}
	if opts.atimes
		&& !mode_is_dir(entry.mode)
		&& !mode_is_lnk(entry.mode)
		&& cur.atime.is_none_or(|atime| !same_time(entry.atime, 0, atime, 0, opts.modify_window))
	{
		bits |= ITEM_REPORT_ATIME;
	}
	if opts.crtimes {
		let crtime = ctx.crtime.or(cur.crtime).unwrap_or(0);
		if !same_time(crtime, 0, entry.crtime, 0, opts.modify_window) {
			bits |= ITEM_REPORT_CRTIME;
		}
	}
	if perms_differ(entry, cur.mode, opts) {
		bits |= ITEM_REPORT_PERMS;
	}
	if uid_differs(entry, &cur, opts) {
		bits |= ITEM_REPORT_OWNER;
	}
	if gid_differs(entry, &cur, opts) {
		bits |= ITEM_REPORT_GROUP;
	}
	bits
}

/// The non-ACL/xattr part of upstream `unchanged_attrs`: true when times (if
/// preserved), permissions, and ownership already match.
pub(crate) fn attrs_unchanged(
	entry: &FileEntry,
	local: &Metadata,
	opts: &MetaOpts,
	local_crtime: Option<i64>,
) -> bool {
	let cur = Snap::of(local);
	let check_time = opts.times && (!mode_is_lnk(entry.mode) || !opts.omit_link_times);
	if check_time {
		let mut differs = !mtime_equal(entry, cur.mtime, opts.modify_window, false);
		if !differs && opts.crtimes {
			let crtime = local_crtime.or(cur.crtime).unwrap_or(0);
			differs = !same_time(crtime, 0, entry.crtime, 0, opts.modify_window);
		}
		if differs {
			return false;
		}
	}
	!perms_differ(entry, cur.mode, opts) && !uid_differs(entry, &cur, opts) && !gid_differs(entry, &cur, opts)
}

fn perms_differ(entry: &FileEntry, local_mode: u32, opts: &MetaOpts) -> bool {
	if opts.perms {
		return stored_perms_differ(local_mode, entry.mode);
	}
	// Windows stores no execute bits, so `-E` has nothing to compare there.
	cfg!(unix) && opts.executability && ((local_mode & 0o111 != 0) != (entry.mode & 0o111 != 0))
}

/// Whether two modes differ in the permission bits the platform stores: all of
/// them on unix, only the read-only attribute (no write bit) on Windows.
fn stored_perms_differ(a: u32, b: u32) -> bool {
	if cfg!(unix) {
		(a ^ b) & CHMOD_BITS != 0
	} else {
		(a & 0o222 == 0) != (b & 0o222 == 0)
	}
}

fn uid_differs(entry: &FileEntry, cur: &Snap, opts: &MetaOpts) -> bool {
	opts.owner && opts.root_like() && cur.uid.is_some_and(|uid| uid != entry.uid)
}

fn gid_differs(entry: &FileEntry, cur: &Snap, opts: &MetaOpts) -> bool {
	opts.group && entry.flags & FLAG_SKIP_GROUP == 0 && cur.gid.is_some_and(|gid| gid != entry.gid)
}

/// The xattr and ACL steps of [`set_file_attrs_with`], supplied by callers that
/// preserve them; upstream runs them between ownership and permissions.
pub(crate) trait AttrHooks {
	/// Applies the entry's xattrs (after ownership, before times; never in a dry
	/// run). Reports its own failures.
	fn apply_xattrs(&mut self, _tree: &Tree, _rel: &Path, _entry: &FileEntry) {}

	/// Applies the entry's ACLs before the final chmod (also called in a dry run,
	/// where it must only detect a difference). Returns whether the ACLs changed;
	/// sets `cur_mode` to the permission bits an access-ACL write left behind.
	fn apply_acls(
		&mut self,
		_tree: &Tree,
		_rel: &Path,
		_entry: &FileEntry,
		_new_mode: u32,
		_cur_mode: &mut u32,
	) -> bool {
		false
	}
}

/// Upstream set_file_attrs: applies owner, group, xattrs (via `hooks`), times, ACLs
/// (via `hooks`), and perms (and the fake-super stat) to `rel`; returns the
/// ITEM_REPORT_* bits that changed.
///
/// `local` is the entry's current (fake-super overlaid, see [`x_lstat`]) metadata;
/// `None` stats it here (and, in a dry run, returns [`ITEM_REPORT_CHANGE`] without
/// looking). Bits: `TIME`, `ATIME`, `CRTIME`, `PERMS`, `OWNER`, `GROUP`, `ACL`; a
/// symlink whose times could not be set adds `ITEM_REPORT_TIMEFAIL` (the caller sets
/// `FLAG_TIME_FAILED`). Failures are logged (exit 23) and end the update early;
/// `Err` is returned only for a corrupt stat xattr (see [`corrupt_fake_stat`]).
#[allow(clippy::too_many_arguments, reason = "upstream set_file_attrs inputs plus the hooks")]
pub(crate) fn set_file_attrs_with(
	tree: &Tree,
	rel: &Path,
	entry: &FileEntry,
	local: Option<&Metadata>,
	opts: &MetaOpts,
	mut flags: u32,
	logger: &Logger,
	hooks: &mut dyn AttrHooks,
) -> io::Result<u32> {
	let fname_bytes = crate::host::os_bytes_lossy(rel.as_os_str());
	let fname: &[u8] = &fname_bytes;
	let statted;
	let (meta, inherit) = match local {
		Some(meta) => (meta, !opts.perms && entry.flags & FLAG_DIR_CREATED != 0),
		None => {
			if opts.dry_run {
				return Ok(ITEM_REPORT_CHANGE);
			}
			match x_lstat(tree, rel, opts, logger) {
				Ok(meta) => statted = meta,
				Err(err) if is_corrupt_fake_stat(&err) => return Err(err),
				Err(err) => {
					let text = [&b"stat "[..], &full_fname(tree, rel), b" failed"].concat();
					logger.rsyserr(LogCode::ErrorXfer, &err, &text);
					return Ok(0);
				},
			}
			(&statted, !opts.perms)
		},
	};
	let mut cur = Snap::of(meta);
	let mut updated = 0u32;

	let mut new_mode = entry.mode;
	if inherit && mode_is_dir(new_mode) && cur.mode & S_ISGID != 0 {
		// A directory we just created keeps the setgid bit it inherited.
		new_mode |= S_ISGID;
	}

	let change_uid = uid_differs(entry, &cur, opts);
	let change_gid = gid_differs(entry, &cur, opts);
	if change_uid || change_gid {
		if logger.levels().debug(log::Debug::Own) >= 1 {
			if let (true, Some(from)) = (change_uid, cur.uid) {
				let tail = format!(" from {from} to {}\n", entry.uid);
				let text = [&b"set uid of "[..], fname, tail.as_bytes()].concat();
				logger.rprintf(LogCode::Info, &text);
			}
			if let (true, Some(from)) = (change_gid, cur.gid) {
				let tail = format!(" from {from} to {}\n", entry.gid);
				let text = [&b"set gid of "[..], fname, tail.as_bytes()].concat();
				logger.rprintf(LogCode::Info, &text);
			}
		}
		if !opts.fake_super {
			let uid = if change_uid { Some(entry.uid) } else { cur.uid };
			let gid = if change_gid { Some(entry.gid) } else { cur.gid };
			if !opts.dry_run {
				if let Err(err) = tree.chown(rel, uid, gid, false) {
					let verb: &[u8] = if change_uid { b"chown " } else { b"chgrp " };
					let text = [verb, &full_fname(tree, rel), b" failed"].concat();
					logger.rsyserr(LogCode::ErrorXfer, &err, &text);
					return Ok(updated);
				}
			}
			for (what, new, old) in [("uid", uid, cur.uid), ("gid", gid, cur.gid)] {
				if new == Some(u32::MAX) && old != Some(u32::MAX) {
					let head = format!("{what} 4294967295 (-1) is impossible to set on ");
					let text = [head.as_bytes(), &full_fname(tree, rel), b"\n"].concat();
					logger.rprintf(LogCode::ErrorXfer, &text);
				}
			}
			if !opts.dry_run && cur.mode & (S_ISUID | S_ISGID) != 0 {
				// chown clears setuid/setgid: see what is left before deciding on chmod.
				let restat = if opts.keep_dirlinks && mode_is_dir(cur.mode) {
					tree.stat(rel)
				} else {
					tree.lstat(rel)
				};
				if let Ok(meta) = restat {
					cur = Snap::of(&meta);
				}
			}
		}
		if change_uid {
			updated |= ITEM_REPORT_OWNER;
		}
		if change_gid {
			updated |= ITEM_REPORT_GROUP;
		}
	}

	if opts.fake_super && !opts.dry_run {
		sync_fake_stat(tree, rel, entry, new_mode, logger)?;
	}
	if opts.xattrs && !opts.dry_run {
		hooks.apply_xattrs(tree, rel, entry);
	}

	let is_dir = mode_is_dir(cur.mode);
	let is_lnk = mode_is_lnk(cur.mode);
	if (opts.omit_dir_times && is_dir) || (opts.omit_link_times && is_lnk) {
		flags |= ATTRS_SKIP_MTIME | ATTRS_SKIP_ATIME | ATTRS_SKIP_CRTIME;
	} else {
		if !opts.times {
			flags |= ATTRS_SKIP_MTIME;
		}
		if !opts.atimes || is_dir {
			flags |= ATTRS_SKIP_ATIME;
		}
		if is_dir && cur.ino == Some(2) {
			// Never the creation date of an HFS+ volume root.
			flags |= ATTRS_SKIP_CRTIME;
		}
	}
	let accurate = flags & ATTRS_ACCURATE_TIME != 0;
	let mut new_mtime = None;
	let mut new_atime = None;
	if flags & ATTRS_SKIP_MTIME == 0 && !mtime_equal(entry, cur.mtime, opts.modify_window, accurate)
	{
		new_mtime = Some((entry.mtime, entry.mtime_nsec));
		updated |= ITEM_REPORT_TIME;
	}
	if flags & ATTRS_SKIP_ATIME == 0
		&& (accurate
			|| cur.atime.is_none_or(|atime| !same_time(atime, 0, entry.atime, 0, opts.modify_window)))
	{
		new_atime = Some((entry.atime, 0));
		updated |= ITEM_REPORT_ATIME;
	}
	if opts.crtimes && flags & ATTRS_SKIP_CRTIME == 0 {
		let crtime = cur.crtime.or_else(|| tree.crtime(rel, false).ok().flatten()).unwrap_or(0);
		if !same_time(crtime, 0, entry.crtime, 0, opts.modify_window)
			&& (opts.dry_run || tree.set_crtime(rel, entry.crtime, false).is_ok())
		{
			updated |= ITEM_REPORT_CRTIME;
		}
	}
	let mut time_failed = false;
	if (new_mtime.is_some() || new_atime.is_some()) && !opts.dry_run {
		let result = match (to_file_time(new_atime), to_file_time(new_mtime)) {
			(Ok(atime), Ok(mtime)) => tree.set_times(rel, atime, mtime, false),
			(Err(err), _) | (_, Err(err)) => Err(err),
		};
		if let Err(err) = result {
			if is_lnk && is_unsupported(&err) {
				updated &= !(ITEM_REPORT_TIME | ITEM_REPORT_ATIME);
				time_failed = true;
			} else {
				let text = [&b"failed to set times on "[..], &full_fname(tree, rel)].concat();
				logger.rsyserr(LogCode::ErrorXfer, &err, &text);
				return Ok(updated);
			}
		}
	}

	if opts.acls
		&& !mode_is_lnk(new_mode)
		&& hooks.apply_acls(tree, rel, entry, new_mode, &mut cur.mode)
	{
		updated |= ITEM_REPORT_ACL;
	}

	if stored_perms_differ(cur.mode, new_mode) {
		let changed = if opts.fake_super || opts.dry_run {
			true
		} else {
			match tree.chmod(rel, new_mode & CHMOD_BITS) {
				Ok(()) => true,
				// Symlink modes are best effort unless permissions are preserved.
				Err(_) if mode_is_lnk(new_mode) && !opts.perms && !opts.executability => true,
				Err(err) if mode_is_lnk(new_mode) && is_unsupported(&err) => false,
				Err(err) => {
					let text = [&b"failed to set permissions on "[..], &full_fname(tree, rel)].concat();
					logger.rsyserr(LogCode::ErrorXfer, &err, &text);
					return Ok(updated);
				},
			}
		};
		if changed {
			updated |= ITEM_REPORT_PERMS;
		}
	}

	if flags & ATTRS_REPORT != 0 && logger.levels().info(log::Info::Name) >= 2 {
		let tail: &[u8] = if updated != 0 { b"\n" } else { b" is uptodate\n" };
		logger.rprintf(LogCode::Client, &[fname, tail].concat());
	}
	if time_failed {
		updated |= ITEM_REPORT_TIMEFAIL;
	}
	Ok(updated)
}

/// Upstream `full_fname`: the quoted path as diagnostics show it, relative names
/// prefixed with the tree root.
pub(crate) fn full_fname(tree: &Tree, rel: &Path) -> Vec<u8> {
	crate::rsync::paths::full_fname(tree.root(), &crate::rsync::paths::path_bytes(rel))
}

/// The `--fake-super` stat record: what the entry would be if we were root.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct FakeStat {
	/// Full mode, type bits included (protocol encoding of symlinks).
	pub mode: u32,
	/// Device major number (0 unless a device).
	pub rdev_major: u32,
	/// Device minor number (0 unless a device).
	pub rdev_minor: u32,
	/// Owner as root would have set it.
	pub uid: u32,
	/// Group as root would have set it.
	pub gid: u32,
}

impl FakeStat {
	/// The xattr value: `"<mode octal> <major>,<minor> <uid>:<gid>"`.
	pub(crate) fn encode(&self) -> Vec<u8> {
		format!(
			"{:o} {},{} {}:{}",
			self.mode, self.rdev_major, self.rdev_minor, self.uid, self.gid
		)
		.into_bytes()
	}

	/// Parses an xattr value the way upstream's `sscanf("%o %d,%d %d:%d")` does:
	/// whitespace before each number is skipped, numbers may carry a sign, the
	/// value ends at a NUL, and anything after the fifth number is ignored.
	pub(crate) fn decode(value: &[u8]) -> Option<Self> {
		let end = memchr::memchr(0, value).unwrap_or(value.len());
		let mut scan = Scan { buf: &value[..end], pos: 0 };
		let mode = scan.number(8)?;
		let rdev_major = scan.number(10)?;
		scan.literal(b',')?;
		let rdev_minor = scan.number(10)?;
		let uid = scan.number(10)?;
		scan.literal(b':')?;
		let gid = scan.number(10)?;
		Some(Self { mode, rdev_major, rdev_minor, uid, gid })
	}

	/// The device number as the local `st_rdev` encodes it.
	pub(crate) fn rdev(&self) -> u64 {
		dev_join(self.rdev_major, self.rdev_minor)
	}

	/// `real` with this record's mode, owner, and device number in place of the
	/// on-disk ones (what upstream's `x_lstat` returns).
	pub(crate) fn overlay(&self, real: &Metadata) -> Metadata {
		let mut meta = Metadata::new(
			FileType::from_mode(self.mode),
			real.len(),
			Permissions::from_mode(self.mode),
		);
		if let Ok(time) = real.modified() {
			meta = meta.with_modified(time);
		}
		if let Ok(time) = real.accessed() {
			meta = meta.with_accessed(time);
		}
		if let Ok(time) = real.created() {
			meta = meta.with_created(time);
		}
		if let Ok(time) = real.changed() {
			meta = meta.with_changed(time);
		}
		if let Some(id) = real.file_id() {
			meta = if id.is_native() {
				meta.with_native_id(id.dev(), id.ino())
			} else {
				meta.with_id(id.dev(), id.ino())
			};
		}
		if let Some(nlink) = real.nlink() {
			meta = meta.with_nlink(nlink);
		}
		if let (Some(blocks), Some(blksize)) = (real.blocks(), real.blksize()) {
			meta = meta.with_blocks(blocks, blksize);
		}
		meta.with_owner(self.uid, self.gid).with_rdev(self.rdev())
	}
}

/// sscanf-like cursor for [`FakeStat::decode`].
struct Scan<'a> {
	buf: &'a [u8],
	pos: usize,
}

impl Scan<'_> {
	fn number(&mut self, radix: u32) -> Option<u32> {
		while self.buf.get(self.pos).is_some_and(u8::is_ascii_whitespace) {
			self.pos += 1;
		}
		let negative = match self.buf.get(self.pos) {
			Some(b'-') => {
				self.pos += 1;
				true
			},
			Some(b'+') => {
				self.pos += 1;
				false
			},
			_ => false,
		};
		let start = self.pos;
		let mut value = 0u32;
		while let Some(digit) = self.buf.get(self.pos).and_then(|&b| char::from(b).to_digit(radix)) {
			value = value.wrapping_mul(radix).wrapping_add(digit);
			self.pos += 1;
		}
		if self.pos == start {
			return None;
		}
		Some(if negative { value.wrapping_neg() } else { value })
	}

	fn literal(&mut self, byte: u8) -> Option<()> {
		(self.buf.get(self.pos) == Some(&byte)).then(|| self.pos += 1)
	}
}

/// A stat xattr that does not parse ends the run (`RERR_FILEIO`); the io::Error
/// carries that `RsyncError` inside, so `RsyncError::from_io` returns it verbatim.
fn is_corrupt_fake_stat(err: &io::Error) -> bool {
	err.get_ref().is_some_and(|inner| inner.is::<RsyncError>())
}

/// The fatal error for a corrupt stat xattr (`Corrupt rsync.%stat xattr attached
/// to "…": "…"`, exit 11), if `err` is one; other errors are not fatal.
pub(crate) fn corrupt_fake_stat(err: &io::Error) -> Option<RsyncError> {
	err.get_ref()?.downcast_ref::<RsyncError>().cloned()
}

/// Stores `stat` as the entry's stat xattr.
fn write_fake_stat(tree: &Tree, rel: &Path, stat: &FakeStat) -> io::Result<()> {
	tree.set_xattr(rel, OsStr::new(XSTAT_ATTR), &stat.encode(), false)
}

/// Upstream `x_lstat` (`x_stat` with `-L`): the entry's metadata with the
/// fake-super record folded in when `--fake-super` is on. Read failures of the
/// xattr are logged and the real metadata is returned.
pub(crate) fn x_lstat(
	tree: &Tree,
	rel: &Path,
	opts: &MetaOpts,
	logger: &Logger,
) -> io::Result<Metadata> {
	let real = if opts.copy_links { tree.stat(rel)? } else { tree.lstat(rel)? };
	if !opts.fake_super {
		return Ok(real);
	}
	match fake_stat_for(tree, rel, &real) {
		Ok(Some(stat)) => Ok(stat.overlay(&real)),
		Ok(None) => Ok(real),
		Err(err) if is_corrupt_fake_stat(&err) => Err(err),
		Err(err) => {
			log_xattr_failure(tree, rel, logger, &err, b"read");
			Ok(real)
		},
	}
}

/// The entry's fake-super record given its real metadata `real`.
///
/// `None` when there is no record, the filesystem has no xattrs, or the entry
/// is a device/special (which fake-super never stores as such). A symlink whose
/// xattrs we may not read reads as owned by 0:0. An unparsable value fails with
/// an error [`corrupt_fake_stat`] recognizes.
fn fake_stat_for(tree: &Tree, rel: &Path, real: &Metadata) -> io::Result<Option<FakeStat>> {
	let mode = real.mode();
	if mode_is_device(mode) || mode_is_special(mode) {
		return Ok(None);
	}
	match tree.get_xattr(rel, OsStr::new(XSTAT_ATTR), false) {
		Ok(None) => Ok(None),
		Ok(Some(value)) if value.len() > XSTAT_MAX => Err(errno_error(Errno::Range)),
		Ok(Some(value)) => match FakeStat::decode(&value) {
			Some(stat) => Ok(Some(stat)),
			None => {
				let end = memchr::memchr(0, &value).unwrap_or(value.len());
				let head = format!("Corrupt {XSTAT_ATTR} xattr attached to ");
				let text =
					[head.as_bytes(), &full_fname(tree, rel), b": \"", &value[..end], b"\""].concat();
				let text = String::from_utf8_lossy_owned(text);
				let fatal = RsyncError::new(RERR_FILEIO, text).at("xattrs.c", 1257);
				Err(io::Error::new(io::ErrorKind::InvalidData, fatal))
			},
		},
		Err(err) if is_no_xattr(&err) => Ok(None),
		Err(err) if is_eperm(&err) && mode_is_lnk(mode) => {
			let (rdev_major, rdev_minor) = real.rdev().map_or((0, 0), dev_split);
			Ok(Some(FakeStat { mode, rdev_major, rdev_minor, uid: 0, gid: 0 }))
		},
		Err(err) => Err(err),
	}
}

/// Upstream `set_stat_xattr`: makes the on-disk entry owner-accessible with the
/// sender's plain permissions and records whatever else (special bits, type,
/// device, owner) differs in the stat xattr, removing a record that became moot.
fn sync_fake_stat(
	tree: &Tree,
	rel: &Path,
	entry: &FileEntry,
	new_mode: u32,
	logger: &Logger,
) -> io::Result<()> {
	let real = match tree.lstat(rel) {
		Ok(meta) => meta,
		Err(err) => {
			let text = [&b"failed to re-stat "[..], &full_fname(tree, rel)].concat();
			logger.rsyserr(LogCode::ErrorXfer, &err, &text);
			return Ok(());
		},
	};
	let existing = match fake_stat_for(tree, rel, &real) {
		Ok(stat) => stat,
		Err(err) if is_corrupt_fake_stat(&err) => return Err(err),
		Err(err) => {
			log_xattr_failure(tree, rel, logger, &err, b"read");
			None
		},
	};

	let disk_mode = real.mode() & (S_IFMT | CHMOD_BITS);
	let want_mode = new_mode & (S_IFMT | CHMOD_BITS);
	let want_rdev = if mode_is_device(want_mode) { entry.rdev.unwrap_or((0, 0)) } else { (0, 0) };
	let owner_bits = if mode_is_dir(disk_mode) { 0o700 } else { 0o600 };
	let plain_mode = (disk_mode & S_IFMT) | (want_mode & ACCESSPERMS) | owner_bits;
	if disk_mode != plain_mode {
		// Best effort, like upstream: a failure shows up in the record instead.
		let _ = tree.chmod(rel, plain_mode & CHMOD_BITS);
	}
	let disk_rdev = match real.rdev() {
		Some(rdev) if mode_is_device(disk_mode) => dev_split(rdev),
		_ => (0, 0),
	};

	if plain_mode == want_mode
		&& disk_rdev == want_rdev
		&& real.uid() == Some(entry.uid)
		&& real.gid() == Some(entry.gid)
	{
		// The real entry says it all: drop a stale record.
		if existing.is_some_and(|stat| stat.mode != 0) {
			if let Err(err) = tree.remove_xattr(rel, OsStr::new(XSTAT_ATTR), false) {
				let text = [&b"delete of stat xattr failed for "[..], &full_fname(tree, rel)].concat();
				logger.rsyserr(LogCode::ErrorXfer, &err, &text);
			}
		}
		return Ok(());
	}

	let want = FakeStat {
		mode: want_mode,
		rdev_major: want_rdev.0,
		rdev_minor: want_rdev.1,
		uid: entry.uid,
		gid: entry.gid,
	};
	if existing != Some(want) {
		if let Err(err) = write_fake_stat(tree, rel, &want) {
			if !(is_eperm(&err) && mode_is_lnk(disk_mode)) {
				log_xattr_failure(tree, rel, logger, &err, b"write");
			}
		}
	}
	Ok(())
}

/// "failed to read|write xattr rsync.%stat for \"…\"".
fn log_xattr_failure(tree: &Tree, rel: &Path, logger: &Logger, err: &io::Error, verb: &[u8]) {
	let mid = format!(" xattr {XSTAT_ATTR} for ");
	let text = [&b"failed to "[..], verb, mid.as_bytes(), &full_fname(tree, rel)].concat();
	logger.rsyserr(LogCode::ErrorXfer, err, &text);
}

/// The attribute name is absent or the filesystem has no xattrs.
fn is_no_xattr(err: &io::Error) -> bool {
	if err.kind() == io::ErrorKind::Unsupported {
		return true;
	}
	#[cfg(unix)]
	{
		#[cfg(any(target_os = "linux", target_os = "android"))]
		let missing = libc::ENODATA;
		#[cfg(not(any(target_os = "linux", target_os = "android")))]
		let missing = libc::ENOATTR;
		err.raw_os_error().is_some_and(|code| {
			code == missing || code == libc::ENOTSUP || code == libc::EOPNOTSUPP
		})
	}
	#[cfg(not(unix))]
	{
		false
	}
}

/// The operation cannot be done on this kind of entry (lchmod/lutimes missing).
fn is_unsupported(err: &io::Error) -> bool {
	if err.kind() == io::ErrorKind::Unsupported {
		return true;
	}
	#[cfg(unix)]
	{
		err.raw_os_error().is_some_and(|code| {
			code == libc::ENOTSUP || code == libc::EOPNOTSUPP || code == libc::ENOSYS
		})
	}
	#[cfg(not(unix))]
	{
		false
	}
}

/// `EPERM` (Windows reports access problems as `PermissionDenied` only).
fn is_eperm(err: &io::Error) -> bool {
	#[cfg(unix)]
	{
		err.raw_os_error() == Some(libc::EPERM)
	}
	#[cfg(not(unix))]
	{
		let _ = err;
		false
	}
}

/// Errors upstream reports with an errno of its own making.
#[derive(Clone, Copy)]
enum Errno {
	Range,
	Inval,
}

fn errno_error(errno: Errno) -> io::Error {
	#[cfg(unix)]
	{
		io::Error::from_raw_os_error(match errno {
			Errno::Range => libc::ERANGE,
			Errno::Inval => libc::EINVAL,
		})
	}
	#[cfg(not(unix))]
	{
		match errno {
			Errno::Range => io::Error::new(io::ErrorKind::InvalidData, "Result too large"),
			Errno::Inval => io::Error::from(io::ErrorKind::InvalidInput),
		}
	}
}

/// `st_rdev` → (major, minor) in the local encoding.
#[cfg(unix)]
fn dev_split(rdev: u64) -> (u32, u32) {
	let dev = rdev as libc::dev_t;
	(libc::major(dev) as u32, libc::minor(dev) as u32)
}

/// (major, minor) → `st_rdev` in the local encoding (MAKEDEV).
#[cfg(unix)]
#[allow(clippy::unnecessary_cast, clippy::useless_conversion, reason = "dev_t differs per OS")]
pub(crate) fn dev_join(major: u32, minor: u32) -> u64 {
	libc::makedev(major as _, minor as _) as u64
}

/// Windows has no device nodes; keep the pair recoverable.
#[cfg(not(unix))]
fn dev_split(rdev: u64) -> (u32, u32) {
	((rdev >> 32) as u32, rdev as u32)
}

/// (major, minor) → a recoverable `st_rdev` (Windows has no device nodes).
#[cfg(not(unix))]
pub(crate) fn dev_join(major: u32, minor: u32) -> u64 {
	(u64::from(major) << 32) | u64::from(minor)
}

/// `(secs, nsec)` → a `FileTime` to set (`None` leaves the time alone).
fn to_file_time(time: Option<(i64, u32)>) -> io::Result<Option<FileTime>> {
	let Some((secs, nsec)) = time else {
		return Ok(None);
	};
	system_time(secs, i64::from(nsec))
		.map(|t| Some(FileTime::At(t)))
		.ok_or_else(|| errno_error(Errno::Inval))
}

/// Whole seconds since the epoch, rounded toward negative infinity.
fn unix_secs(time: SystemTime) -> i64 {
	match time.duration_since(UNIX_EPOCH) {
		Ok(after) => i64::try_from(after.as_secs()).unwrap_or(i64::MAX),
		Err(before) => {
			let d = before.duration();
			let secs = i64::try_from(d.as_secs()).unwrap_or(i64::MAX);
			-secs - i64::from(d.subsec_nanos() > 0)
		},
	}
}

/// The fields of a stat this module consults.
#[derive(Clone, Copy, Debug)]
struct Snap {
	mode: u32,
	size: u64,
	uid: Option<u32>,
	gid: Option<u32>,
	ino: Option<u64>,
	mtime: Option<(i64, u32)>,
	atime: Option<i64>,
	crtime: Option<i64>,
}

impl Snap {
	fn of(meta: &Metadata) -> Self {
		let mtime = meta
			.mtime()
			.map(|secs| (secs, meta.mtime_nsec().and_then(|n| u32::try_from(n).ok()).unwrap_or(0)));
		Self {
			mode: meta.mode(),
			size: meta.len(),
			uid: meta.uid(),
			gid: meta.gid(),
			ino: meta.ino(),
			mtime,
			atime: meta.atime(),
			crtime: meta.created().ok().map(unix_secs),
		}
	}
}


