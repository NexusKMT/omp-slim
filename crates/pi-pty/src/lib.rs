//! PTY output draining shared by the native addon and its lifecycle tests.
//!
//! This crate has no shell, N-API or language-parser dependency so queue,
//! cancellation and EOF regressions can run without rebuilding the addon.

use std::{
	sync::atomic::{AtomicBool, Ordering},
	time::Duration,
};

const POST_CANCEL_DRAIN_TIMEOUT: Duration = Duration::from_millis(300);
/// Idle window used only when the child has already exited, the reader has
/// *not* hit EOF, the bridge queue is empty, and no `on_chunk` is in flight.
/// That is a permanently open slave (daemon / extra holder), not slow JS.
/// A reader parked on a full bridge is backpressure and must not use this.
const STUCK_SLAVE_IDLE: Duration = Duration::from_secs(2);
/// Wait for the JS pump after the child has exited and the master is dropped.
///
/// `queued` is a clone of the reader sender, used only to see whether the
/// bridge still holds bytes (backpressure vs open slave). It is dropped as
/// soon as the reader has exited so the pump is not left parked on `recv`.
///
/// Cancel/timeout must not pin the promise on a slow callback. A successful
/// finite run must not resolve until accepted output reached `on_chunk`
/// (#7421). After reader EOF, wait for the pump with no idle timeout. A
/// reader parked on a full bridge is backpressure, not a hang. Only a
/// permanently open slave (EOF never arrives, queue empty, no in-flight
/// callback) may skip the unbounded wait. `stop_pump` is invoked on every
/// abandonment path, then this waits up to `POST_CANCEL_DRAIN_TIMEOUT` for
/// the pump task to observe abort so `start()` does not resolve while
/// `call_async` is still in Rust. An already-queued napi callback can still
/// run once; TSFN work lives on the JS thread.
pub fn await_output_drain<T>(
	pump_done_rx: flume::Receiver<()>,
	reader_thread: std::thread::JoinHandle<()>,
	queued: flume::Sender<T>,
	in_js: &AtomicBool,
	abandon_slow_js: bool,
	stop_pump: impl FnOnce(),
) {
	let mut stop_pump = Some(stop_pump);

	if abandon_slow_js {
		if let Some(stop_pump) = stop_pump.take() {
			stop_pump();
		}
		drop(queued);
		let _ = pump_done_rx.recv_timeout(POST_CANCEL_DRAIN_TIMEOUT);
		if reader_thread.is_finished() {
			let _ = reader_thread.join();
		}
		return;
	}

	loop {
		if reader_thread.is_finished() {
			drop(queued);
			// Unbounded by design (#7421, same as shell.rs `drain_handle.await`).
			let _ = pump_done_rx.recv();
			let _ = reader_thread.join();
			return;
		}

		match pump_done_rx.recv_timeout(STUCK_SLAVE_IDLE) {
			Ok(()) | Err(flume::RecvTimeoutError::Disconnected) => {
				if reader_thread.is_finished() {
					let _ = reader_thread.join();
				}
				return;
			},
			Err(flume::RecvTimeoutError::Timeout) => {
				if reader_thread.is_finished() {
					continue;
				}
				if queued.is_empty() && !in_js.load(Ordering::Acquire) {
					if let Some(stop_pump) = stop_pump.take() {
						stop_pump();
					}
					drop(queued);
					let _ = pump_done_rx.recv_timeout(POST_CANCEL_DRAIN_TIMEOUT);
					return;
				}
			},
		}
	}
}

#[cfg(test)]
mod reader_queue_tests {
	use std::{
		sync::{
			Arc,
			atomic::{AtomicBool, Ordering},
		},
		time::{Duration, Instant},
	};

	use super::{POST_CANCEL_DRAIN_TIMEOUT, STUCK_SLAVE_IDLE, await_output_drain};

	#[test]
	fn drain_waits_for_slow_js_after_reader_eof() {
		let (pump_tx, pump_rx) = flume::bounded(1);
		let reader = std::thread::spawn(|| {});
		let (queued, _) = flume::bounded::<String>(1);
		let in_js = AtomicBool::new(false);
		std::thread::spawn(move || {
			std::thread::sleep(Duration::from_millis(2500));
			let _ = pump_tx.send(());
		});
		let start = Instant::now();
		await_output_drain(pump_rx, reader, queued, &in_js, false, || {});
		assert!(
			start.elapsed() >= Duration::from_millis(2400),
			"must not time out a slow callback after reader EOF",
		);
	}

	#[test]
	fn drain_drops_sender_clone_after_reader_eof_so_pump_unblocks() {
		let (reader_tx, reader_rx) = flume::bounded::<String>(1);
		let queued = reader_tx.clone();
		drop(reader_tx);
		let (pump_tx, pump_rx) = flume::bounded(1);
		std::thread::spawn(move || {
			let _ = reader_rx.recv();
			let _ = pump_tx.send(());
		});
		let reader = std::thread::spawn(|| {});
		let deadline = Instant::now() + Duration::from_secs(1);
		while !reader.is_finished() && Instant::now() < deadline {
			std::thread::sleep(Duration::from_millis(1));
		}
		assert!(reader.is_finished(), "reader fixture must have exited");
		let in_js = AtomicBool::new(false);
		let start = Instant::now();
		await_output_drain(pump_rx, reader, queued, &in_js, false, || {});
		assert!(
			start.elapsed() < STUCK_SLAVE_IDLE,
			"holding the sender clone after EOF parks the pump until idle timeout",
		);
	}

	#[test]
	fn drain_gives_up_only_on_open_slave_idle() {
		let (_pump_tx, pump_rx) = flume::bounded::<()>(1);
		let reader = std::thread::spawn(|| {
			std::thread::park();
		});
		let (queued, _) = flume::bounded::<String>(1);
		let in_js = AtomicBool::new(false);
		let stopped = AtomicBool::new(false);
		let start = Instant::now();
		await_output_drain(pump_rx, reader, queued, &in_js, false, || {
			stopped.store(true, Ordering::Release);
		});
		let elapsed = start.elapsed();
		assert!(elapsed >= STUCK_SLAVE_IDLE);
		assert!(elapsed < STUCK_SLAVE_IDLE + Duration::from_secs(2));
		assert!(stopped.load(Ordering::Acquire), "open slave must stop the pump");
	}

	#[test]
	fn drain_does_not_treat_queued_backpressure_as_stuck_slave() {
		let (pump_tx, pump_rx) = flume::bounded(1);
		let reader = std::thread::spawn(std::thread::park);
		let (queued, _rx) = flume::bounded::<String>(1);
		queued.send("x".into()).expect("queue accepts a chunk");
		let in_js = AtomicBool::new(false);
		std::thread::spawn(move || {
			std::thread::sleep(Duration::from_millis(2500));
			let _ = pump_tx.send(());
		});
		let start = Instant::now();
		await_output_drain(pump_rx, reader, queued, &in_js, false, || {});
		assert!(
			start.elapsed() >= Duration::from_millis(2400),
			"queued output is backpressure, not a stuck slave",
		);
	}

	#[test]
	fn drain_does_not_treat_in_flight_callback_as_stuck_slave() {
		let (pump_tx, pump_rx) = flume::bounded(1);
		let reader = std::thread::spawn(std::thread::park);
		let (queued, _) = flume::bounded::<String>(1);
		let in_js = Arc::new(AtomicBool::new(true));
		let in_js_flag = Arc::clone(&in_js);
		std::thread::spawn(move || {
			std::thread::sleep(Duration::from_millis(2500));
			in_js_flag.store(false, Ordering::Release);
			let _ = pump_tx.send(());
		});
		let start = Instant::now();
		await_output_drain(pump_rx, reader, queued, &in_js, false, || {});
		assert!(
			start.elapsed() >= Duration::from_millis(2400),
			"an in-flight on_chunk is slow JS, not a stuck slave",
		);
	}

	#[test]
	fn drain_cancel_does_not_wait_for_slow_js() {
		let (_pump_tx, pump_rx) = flume::bounded::<()>(1);
		let reader = std::thread::spawn(std::thread::park);
		let (queued, _) = flume::bounded::<String>(1);
		let in_js = AtomicBool::new(true);
		let stopped = AtomicBool::new(false);
		let start = Instant::now();
		await_output_drain(pump_rx, reader, queued, &in_js, true, || {
			stopped.store(true, Ordering::Release);
		});
		assert!(
			start.elapsed() < Duration::from_secs(2),
			"cancel must not pin the promise on a stalled callback",
		);
		assert!(start.elapsed() >= POST_CANCEL_DRAIN_TIMEOUT);
		assert!(stopped.load(Ordering::Acquire), "cancel must stop the pump");
	}

	#[test]
	fn drain_cancel_returns_once_pump_observes_stop() {
		let (pump_tx, pump_rx) = flume::bounded::<()>(1);
		let reader = std::thread::spawn(std::thread::park);
		let (queued, _) = flume::bounded::<String>(1);
		let in_js = AtomicBool::new(true);
		let start = Instant::now();
		await_output_drain(pump_rx, reader, queued, &in_js, true, move || {
			drop(pump_tx);
		});
		assert!(
			start.elapsed() < POST_CANCEL_DRAIN_TIMEOUT,
			"after stop disconnects the pump, cancel must not sit out the full drain timeout",
		);
	}
}
