export interface EventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface EventBusController extends EventBus {
	clear(): void;
}

class SimpleEventEmitter {
	private listeners = new Map<string, Set<(data: unknown) => void>>();

	on(channel: string, handler: (data: unknown) => void): void {
		if (!this.listeners.has(channel)) {
			this.listeners.set(channel, new Set());
		}
		this.listeners.get(channel)!.add(handler);
	}

	off(channel: string, handler: (data: unknown) => void): void {
		this.listeners.get(channel)?.delete(handler);
	}

	emit(channel: string, data: unknown): void {
		const handlers = this.listeners.get(channel);
		if (handlers) {
			for (const handler of handlers) {
				handler(data);
			}
		}
	}

	removeAllListeners(): void {
		this.listeners.clear();
	}
}

export function createEventBus(): EventBusController {
	const emitter = new SimpleEventEmitter();
	return {
		emit: (channel, data) => {
			emitter.emit(channel, data);
		},
		on: (channel, handler) => {
			const safeHandler = async (data: unknown) => {
				try {
					await handler(data);
				} catch (err) {
					console.error(`Event handler error (${channel}):`, err);
				}
			};
			emitter.on(channel, safeHandler);
			return () => emitter.off(channel, safeHandler);
		},
		clear: () => {
			emitter.removeAllListeners();
		},
	};
}
