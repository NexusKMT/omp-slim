import { type MessagePort, parentPort } from "node:worker_threads";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { MissingApiKeyError } from "@oh-my-pi/pi-ai/error";
import { ModelRegistry } from "../../src/config/model-registry";

import type { WorkerThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import { authService } from "../../src/thread/services/auth";

/** Worker-side operations the test drives; each crosses to main as an async function. */
export interface AuthProbe {
	resolvedKey(provider: string): Promise<string | undefined>;
	key(provider: string, sessionId: string): Promise<string | undefined>;
	keyError(provider: string, sessionId: string): Promise<{ missingApiKey: boolean; message: string }>;

	sameStorage(storage: AuthStorage): Promise<boolean>;
	watchGenerations(): Promise<void>;
	generations(): Promise<number[]>;
	unwatchGenerations(): Promise<void>;
	/** `keys.source(provider)?.kind` of each provider, read through the worker's storage. */
	sourceKinds(providers: string[]): Promise<Array<string | undefined>>;
	registry(registry: ModelRegistry): Promise<{
		local: boolean;
		canonical: boolean;
		sharesAuth: boolean;
		hasModel: boolean;
		apiKey: string | undefined;
	}>;
}

/** Test-only boot globals next to the services' own. */
export interface AuthTestGlobals {
	storage: AuthStorage;
	ready(probe: AuthProbe): void;
}

function isTestGlobals(value: unknown): value is AuthTestGlobals {
	return (
		typeof value === "object" &&
		value !== null &&
		Reflect.get(value, "storage") instanceof AuthStorage &&
		typeof Reflect.get(value, "ready") === "function"
	);
}

function buildProbe(storage: AuthStorage): AuthProbe {
	const seen: number[] = [];
	let unwatch: (() => void) | undefined;
	let firstRegistry: ModelRegistry | undefined;
	return {
		key: (provider, sessionId) => storage.keys.get(provider, sessionId),
		resolvedKey: async provider => {
			const value = await storage.keys.resolver(provider)({ error: undefined, lastChance: false });
			return typeof value === "string" ? value : value?.apiKey;
		},
		keyError: async (provider, sessionId) => {
			try {
				await storage.keys.get(provider, sessionId);
				return { missingApiKey: false, message: "resolved" };
			} catch (error) {
				return {
					missingApiKey: error instanceof MissingApiKeyError,
					message: error instanceof Error ? error.message : String(error),
				};
			}
		},

		sameStorage: async other => other === storage,
		watchGenerations: async () => {
			unwatch = storage.credentials.onGeneration(generation => {
				seen.push(generation);
			});
		},
		generations: async () => [...seen],
		sourceKinds: async providers => providers.map(provider => storage.keys.source(provider)?.kind),
		unwatchGenerations: async () => {
			unwatch?.();
			unwatch = undefined;
		},
		registry: async registry => {
			firstRegistry ??= registry;
			return {
				local: registry instanceof ModelRegistry,
				canonical: firstRegistry === registry,
				sharesAuth: registry.authStorage === storage,
				hasModel: registry.find("unit-mirror", "mirror-model") !== undefined,
				apiKey: await registry.getApiKeyForProvider("unit-mirror"),
			};
		},
	};
}

const port = parentPort;
if (!port) throw new Error("fixture must run in a worker");

port.once("message", (init: { sync: MessagePort; counter: SharedArrayBuffer }) => {
	const link: WorkerThreadLink = new RpcLink(
		{
			send: frame => port.postMessage(frame),
			listen: handler => {
				const listener = (frame: RpcFrame): void => handler(frame);
				port.on("message", listener);
				return () => port.off("message", listener);
			},
		},
		{ name: "auth-fixture", sync: { port: init.sync, counter: new Int32Array(init.counter) } },
	);
	authService.installWorker?.(link);
	link.handle("ping", nonce => nonce);
	link.handle("boot", async globals => {
		await authService.boot?.(globals[authService.name], link);
		const test = globals.test;
		if (!isTestGlobals(test)) throw new Error("auth fixture: missing test globals");
		await test.ready(buildProbe(test.storage));
	});
	port.postMessage({ ready: true });
});
