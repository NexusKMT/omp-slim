//! `--stats` and the end-of-run summary text.

use std::time::Duration;

use super::format::{big_dnum, big_num};
use super::levels::{Info, OutLevels};

/// Transfer statistics (both peers' counters after the stats exchange).
///
/// `total_written` / `total_read` are the byte counts the summary prints (for a client
/// receiver: the values the server sent in the stats exchange, swapped).
#[derive(Clone, Debug, Default)]
pub(crate) struct Stats {
	pub total_size: i64,
	pub total_transferred_size: i64,
	pub total_written: i64,
	pub total_read: i64,
	pub literal_data: i64,
	pub matched_data: i64,
	/// Protocol 33: 4 KiB logical blocks the receiver wrote.
	pub touched_blocks_4k: i64,
	/// Milliseconds.
	pub flist_buildtime: i64,
	/// Milliseconds.
	pub flist_xfertime: i64,
	pub flist_size: i64,
	/// Every entry (regular files are what is left after the other kinds).
	pub num_files: i32,
	pub num_dirs: i32,
	pub num_symlinks: i32,
	pub num_devices: i32,
	pub num_specials: i32,
	pub created_files: i32,
	pub created_dirs: i32,
	pub created_symlinks: i32,
	pub created_devices: i32,
	pub created_specials: i32,
	pub deleted_files: i32,
	pub deleted_dirs: i32,
	pub deleted_symlinks: i32,
	pub deleted_devices: i32,
	pub deleted_specials: i32,
	pub xferred_files: i32,
}

/// `Number of files: 8 (reg: 5, dir: 2, link: 1)`.
fn itemized_counts(prefix: &str, counts: [i32; 5], human: u8) -> String {
	let comma = human.min(1);
	let total = counts[0];
	let mut line = format!("{prefix}: {}", big_num(i64::from(total), comma));
	if total != 0 {
		let reg = total - counts[1] - counts[2] - counts[3] - counts[4];
		let parts = [reg, counts[1], counts[2], counts[3], counts[4]];
		let labels = ["reg", "dir", "link", "dev", "special"];
		let mut sep = " (";
		for (label, count) in labels.iter().zip(parts) {
			if count != 0 {
				line.push_str(sep);
				line.push_str(label);
				line.push_str(": ");
				line.push_str(&big_num(i64::from(count), comma));
				sep = ", ";
			}
		}
		line.push(')');
	}
	line.push('\n');
	line
}

impl Stats {
	/// The --stats block (INFO stats ≥ 2), one `\n`-terminated line per entry, honoring -h
	/// and protocol-dependent lines. The blank line upstream prints before it (to stdout only)
	/// is not included; see `Logger::output_summary`.
	pub(super) fn stats_lines(&self, human: u8, proto: u32, levels: &OutLevels) -> Vec<String> {
		if levels.info(Info::Stats) < 2 {
			return Vec::new();
		}
		let comma = human.min(1);
		let num = |n: i64| big_num(n, human);
		let mut lines = vec![itemized_counts(
			"Number of files",
			[self.num_files, self.num_dirs, self.num_symlinks, self.num_devices, self.num_specials],
			human,
		)];
		if proto >= 29 {
			lines.push(itemized_counts(
				"Number of created files",
				[
					self.created_files,
					self.created_dirs,
					self.created_symlinks,
					self.created_devices,
					self.created_specials,
				],
				human,
			));
		}
		if proto >= 31 {
			lines.push(itemized_counts(
				"Number of deleted files",
				[
					self.deleted_files,
					self.deleted_dirs,
					self.deleted_symlinks,
					self.deleted_devices,
					self.deleted_specials,
				],
				human,
			));
		}
		lines.push(format!(
			"Number of regular files transferred: {}\n",
			big_num(i64::from(self.xferred_files), comma)
		));
		lines.push(format!("Total file size: {} bytes\n", num(self.total_size)));
		lines.push(format!(
			"Total transferred file size: {} bytes\n",
			num(self.total_transferred_size)
		));
		lines.push(format!("Literal data: {} bytes\n", num(self.literal_data)));
		if proto >= 33 {
			lines.push(format!(
				"Number of 4 KiB logical blocks touched: {}\n",
				big_num(self.touched_blocks_4k, comma)
			));
		}
		lines.push(format!("Matched data: {} bytes\n", num(self.matched_data)));
		lines.push(format!("File list size: {}\n", num(self.flist_size)));
		if self.flist_buildtime != 0 {
			lines.push(format!(
				"File list generation time: {} seconds\n",
				big_dnum(self.flist_buildtime as f64 / 1000.0, comma, 3)
			));
			lines.push(format!(
				"File list transfer time: {} seconds\n",
				big_dnum(self.flist_xfertime as f64 / 1000.0, comma, 3)
			));
		}
		lines.push(format!("Total bytes sent: {}\n", num(self.total_written)));
		lines.push(format!("Total bytes received: {}\n", num(self.total_read)));
		lines
	}

	/// "sent … bytes  received … bytes  … bytes/sec" and "total size is …  speedup is …":
	/// `elapsed` None prints `UNKNOWN` bytes/sec, `suffix` is `" (BATCH ONLY)"`,
	/// `" (DRY RUN)"`, or empty. The preceding blank line is not included.
	pub(crate) fn summary_lines(
		&self,
		human: u8,
		elapsed: Option<Duration>,
		suffix: &str,
	) -> [String; 2] {
		let total = self.total_written.saturating_add(self.total_read);
		let rate = match elapsed {
			// Upstream measures whole seconds between two time() calls.
			Some(elapsed) => big_dnum(total as f64 / (0.5 + elapsed.as_secs() as f64), human, 2),
			None => "UNKNOWN".to_owned(),
		};
		let speedup = self.total_size as f64 / total as f64;
		[
			format!(
				"sent {} bytes  received {} bytes  {rate} bytes/sec\n",
				big_num(self.total_written, human),
				big_num(self.total_read, human)
			),
			format!(
				"total size is {}  speedup is {}{suffix}\n",
				big_num(self.total_size, human),
				big_dnum(speedup, human.min(1), 2)
			),
		]
	}

	/// The log-file line upstream writes at exit: `sent X bytes  received Y bytes  total size Z`.
	pub(crate) fn log_exit_line(&self) -> String {
		format!(
			"sent {} bytes  received {} bytes  total size {}\n",
			big_num(self.total_written, 0),
			big_num(self.total_read, 0),
			big_num(self.total_size, 0)
		)
	}
}


