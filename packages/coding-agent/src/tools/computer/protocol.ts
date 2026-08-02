import type {
	DesktopAction,
	DesktopCapabilities,
	DesktopCapture,
	DesktopSessionOptions,
	DesktopWindow,
} from "@oh-my-pi/pi-natives";

export const COMPUTER_WORKER_ARG = "__omp_worker_computer";

export type ComputerWorkerInbound =
	| { type: "ping"; id: string }
	| { type: "init"; options: DesktopSessionOptions }
	| { type: "list"; id: string }
	| { type: "execute"; id: string; window: string; actions: DesktopAction[] }
	| { type: "close" };

export type ComputerWorkerOutbound =
	| { type: "pong"; id: string }
	| { type: "ready"; capabilities: DesktopCapabilities }
	| { type: "windows"; id: string; windows: DesktopWindow[]; capabilities: DesktopCapabilities }
	| { type: "result"; id: string; capture: DesktopCapture; capabilities: DesktopCapabilities }
	| { type: "error"; id?: string; error: ComputerWorkerError }
	| { type: "closed" };

export interface ComputerWorkerError {
	name: string;
	message: string;
	stack?: string;
}

export interface ComputerWorkerTransport {
	send(message: ComputerWorkerOutbound, transfer?: Bun.Transferable[]): void;
	onMessage(handler: (message: ComputerWorkerInbound) => void): () => void;
	close(): void;
}
