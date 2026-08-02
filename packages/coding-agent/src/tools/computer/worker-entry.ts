import { parentPort } from "node:worker_threads";
import { consumeWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import type { ComputerWorkerInbound, ComputerWorkerTransport } from "./protocol";
import { ComputerWorkerCore } from "./worker";

// Side-effect entry module: evaluating it inside a worker thread starts the
// computer worker; importing it from the main thread (tests, SDK embedding) is
// a no-op. The CLI host dispatches the `__omp_worker_computer` selector by
// dynamically importing this module after installing the worker inbox, so the
// computer worker graph stays off normal CLI startup. Loaded directly (source
// fallback outside a CLI host), top-level evaluation runs synchronously at
// worker start and `parentPort.on` below wins the flush on its own.
if (parentPort) {
	const port = parentPort;
	const inbox = consumeWorkerInbox();
	const transport: ComputerWorkerTransport = {
		send(message, transfer) {
			port.postMessage(message, transfer ?? []);
		},
		onMessage(handler) {
			if (inbox) return inbox.bind(message => handler(message as ComputerWorkerInbound));
			const listener = (message: unknown): void => handler(message as ComputerWorkerInbound);
			port.on("message", listener);
			return () => port.off("message", listener);
		},
		close() {
			port.close();
		},
	};

	new ComputerWorkerCore(transport);
}
