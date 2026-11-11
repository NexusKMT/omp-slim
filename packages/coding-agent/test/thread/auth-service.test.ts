import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MessageChannel } from "node:worker_threads";
import { AuthStorage } from "@oh-my-pi/pi-ai";

import { ModelRegistry } from "../../src/config/model-registry";

import type { MainThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import type { WorkerPeer } from "../../src/thread/services";
import { authService } from "../../src/thread/services/auth";
import type { AuthProbe, AuthTestGlobals } from "../fixtures/auth-service-worker";

const PROVIDER = "unit-key-thread";

describe("auth thread service", () => {
	let tempDir = "";
	let storage: AuthStorage;
	let registry: ModelRegistry;
	let worker: Worker | undefined;
	let link: MainThreadLink | undefined;
	let peer: WorkerPeer;
	let probe: AuthProbe;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auth-thread-"));
		storage = await AuthStorage.create(path.join(tempDir, "agent.db"));
		const modelsPath = path.join(tempDir, "models.json");
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					"unit-mirror": {
						baseUrl: "https://unit-mirror.example.invalid/v1",
						api: "openai-completions",
						apiKey: "mirror-config-key",
						models: [{ id: "mirror-model", name: "Mirror Model" }],
					},
				},
			}),
		);
		registry = new ModelRegistry(storage, modelsPath);
		if (registry.getError()) throw registry.getError();

		const spawned = new Worker(new URL("../fixtures/auth-service-worker.ts", import.meta.url).href, {
			type: "module",
		});
		worker = spawned;
		const channel = new MessageChannel();
		const counter = new SharedArrayBuffer(4);
		const { promise: ready, resolve: onReady } = Promise.withResolvers<void>();
		const readyListener = (event: MessageEvent): void => {
			if (event.data?.ready) {
				spawned.removeEventListener("message", readyListener);
				onReady();
			}
		};
		spawned.addEventListener("message", readyListener);
		spawned.postMessage({ sync: channel.port2, counter }, [channel.port2]);
		await ready;
		const mainLink: MainThreadLink = new RpcLink(
			{
				send: frame => spawned.postMessage(frame),
				listen: handler => {
					const listener = (event: MessageEvent<RpcFrame>): void => handler(event.data);
					spawned.addEventListener("message", listener);
					return () => spawned.removeEventListener("message", listener);
				},
			},
			{ name: "main↔auth-fixture", syncReplies: { port: channel.port1, counter: new Int32Array(counter) } },
		);
		link = mainLink;
		mainLink.handle("ping", nonce => nonce);
		peer = { threadId: "w1", link: mainLink };
		authService.installMain?.(peer);
		const { promise: probed, resolve: onProbe } = Promise.withResolvers<AuthProbe>();
		const test: AuthTestGlobals = { storage, ready: received => onProbe(received) };
		await mainLink.call("boot", { [authService.name]: authService.globals?.(peer), test });
		probe = await probed;
	});

	afterEach(async () => {
		link?.close("test done");
		link = undefined;
		await worker?.terminate();
		worker = undefined;
		storage.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("shares canonical storage and resolves current API keys across the worker boundary", async () => {
		expect(await probe.sameStorage(storage)).toBe(true);
		await storage.credentials.set(PROVIDER, { type: "api_key", key: "stored-key" });
		expect(await probe.key(PROVIDER, "child")).toBe("stored-key");
		storage.keys.setRuntime(PROVIDER, "runtime-key");
		expect(await probe.key(PROVIDER, "child")).toBe("runtime-key");
		storage.keys.removeRuntime(PROVIDER);
		expect(await probe.key(PROVIDER, "child")).toBe("stored-key");
	});

	it("preserves a callable key resolver and evaluates dynamic config on main", async () => {
		let current = "first-dynamic-key";
		storage.keys.setResolver(async config => (config === "dynamic-config" ? current : undefined));
		storage.keys.setConfig(PROVIDER, "dynamic-config");
		expect(await probe.resolvedKey(PROVIDER)).toBe("first-dynamic-key");
		current = "next-dynamic-key";
		expect(await probe.resolvedKey(PROVIDER)).toBe("next-dynamic-key");
	});

	it("delivers credential generations until the worker unsubscribes", async () => {
		await probe.watchGenerations();
		await storage.credentials.set(PROVIDER, { type: "api_key", key: "key" });
		expect((await probe.generations()).at(-1)).toBe(storage.credentials.generation);
		await probe.unwatchGenerations();
		const seen = (await probe.generations()).length;
		await storage.credentials.remove(PROVIDER);
		expect((await probe.generations()).length).toBe(seen);
	});

	it("reads current credential sources without an availability cache", async () => {
		expect(await probe.sourceKinds([PROVIDER])).toEqual([undefined]);
		await storage.credentials.set(PROVIDER, { type: "api_key", key: "stored-key" });
		expect(await probe.sourceKinds([PROVIDER])).toEqual(["api_key"]);
		storage.keys.setRuntime(PROVIDER, "runtime-key");
		expect(await probe.sourceKinds([PROVIDER])).toEqual(["runtime"]);
		storage.keys.removeRuntime(PROVIDER);
		await storage.credentials.remove(PROVIDER);
		expect(await probe.sourceKinds([PROVIDER])).toEqual([undefined]);
	});

	it("mirrors explicit models locally and keeps main-owned key config", async () => {
		expect(await probe.registry(registry)).toEqual({
			local: true,
			canonical: true,
			sharesAuth: true,
			hasModel: true,
			apiKey: "mirror-config-key",
		});
		expect((await probe.registry(registry)).canonical).toBe(true);
		expect(await storage.keys.get("unit-mirror")).toBe("mirror-config-key");
	});
});
