//! Resource limits (`ulimit`): the mapping from the engine's [`Rlimit`] to
//! the platform's `RLIMIT_*`, reading the host's limits, and the form the
//! spawner applies in a child before exec.
//!
//! Resources a platform lacks (FreeBSD-only ones everywhere, most of Linux's
//! extras on macOS) have no mapping: [`get`] reports `Unsupported`, and the
//! spawner skips them (bash reports those at `ulimit` time).

use std::io;

use crate::bash::Rlimit;

/// Type of a resource id in `getrlimit`/`setrlimit` on this target.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
pub(crate) type Resource = libc::__rlimit_resource_t;
/// Type of a resource id in `getrlimit`/`setrlimit` on this target.
#[cfg(all(unix, not(all(target_os = "linux", target_env = "gnu"))))]
pub(crate) type Resource = libc::c_int;

/// The platform resource of `r`, `None` when the platform has none.
#[cfg(unix)]
pub(crate) const fn resource(r: Rlimit) -> Option<Resource> {
	Some(match r {
		Rlimit::Core => libc::RLIMIT_CORE,
		Rlimit::Data => libc::RLIMIT_DATA,
		Rlimit::Fsize => libc::RLIMIT_FSIZE,
		Rlimit::Memlock => libc::RLIMIT_MEMLOCK,
		Rlimit::Rss => libc::RLIMIT_RSS,
		Rlimit::Stack => libc::RLIMIT_STACK,
		Rlimit::Cpu => libc::RLIMIT_CPU,
		Rlimit::Nproc => libc::RLIMIT_NPROC,
		Rlimit::Nofile => libc::RLIMIT_NOFILE,
		Rlimit::Vmem => libc::RLIMIT_AS,
		#[cfg(target_os = "linux")]
		Rlimit::Locks => libc::RLIMIT_LOCKS,
		#[cfg(target_os = "linux")]
		Rlimit::Sigpending => libc::RLIMIT_SIGPENDING,
		#[cfg(target_os = "linux")]
		Rlimit::Msgqueue => libc::RLIMIT_MSGQUEUE,
		#[cfg(target_os = "linux")]
		Rlimit::Nice => libc::RLIMIT_NICE,
		#[cfg(target_os = "linux")]
		Rlimit::Rtprio => libc::RLIMIT_RTPRIO,
		#[cfg(target_os = "linux")]
		Rlimit::Rttime => libc::RLIMIT_RTTIME,
		_ => return None,
	})
}

/// `None` (unlimited) or a value, as the kernel's `rlim_t`.
#[cfg(unix)]
#[allow(clippy::unnecessary_cast, reason = "rlim_t is u64 on 64-bit targets only")]
pub(crate) const fn to_raw(v: Option<u64>) -> libc::rlim_t {
	match v {
		Some(v) if (v as libc::rlim_t) < libc::RLIM_INFINITY => v as libc::rlim_t,
		_ => libc::RLIM_INFINITY,
	}
}

/// The kernel's `rlim_t` as `None` (unlimited) or a value.
#[cfg(unix)]
#[allow(clippy::unnecessary_cast, reason = "rlim_t is u64 on 64-bit targets only")]
const fn from_raw(v: libc::rlim_t) -> Option<u64> {
	if v == libc::RLIM_INFINITY {
		None
	} else {
		Some(v as u64)
	}
}

/// The host process's soft and hard limit for `r` (`None`: unlimited), the
/// base of `ulimit` ([`Host::rlimit`](crate::bash::Host::rlimit)).
///
/// # Errors
///
/// `Unsupported` for a resource the platform lacks (and on Windows), else
/// the OS error of `getrlimit`.
pub fn get(r: Rlimit) -> io::Result<(Option<u64>, Option<u64>)> {
	#[cfg(unix)]
	{
		let res = resource(r).ok_or(io::ErrorKind::Unsupported)?;
		let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
		// SAFETY: `lim` is writable for the call.
		if unsafe { libc::getrlimit(res, &raw mut lim) } != 0 {
			return Err(io::Error::last_os_error());
		}
		Ok((from_raw(lim.rlim_cur), from_raw(lim.rlim_max)))
	}
	#[cfg(not(unix))]
	{
		let _ = r;
		Err(io::ErrorKind::Unsupported.into())
	}
}


