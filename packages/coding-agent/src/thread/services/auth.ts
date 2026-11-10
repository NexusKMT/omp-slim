/** API-key storage and explicit model registry references shared with subagent workers. */
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { ConfigurationError, MissingApiKeyError } from "@oh-my-pi/pi-ai/error";
import { logger } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../config/model-registry";
import type { MainThreadLink, WorkerThreadLink } from "../protocol";
import { type RemoteObject, type RpcServe, registerRpcError } from "../rpc";
import type { ThreadService, WorkerPeer } from "../services";
import {
	AUTH_STORAGE_KIND,
	type AuthStorageProtocol,
	MODEL_REGISTRY_KIND,
	type ModelRegistryProtocol,
} from "./auth-protocol";
import { RemoteAuthStorageBackend } from "./auth-remote";
import { RemoteModelRegistryOwner } from "./model-registry-mirror";
import { trackWorkerSubscription, type WireCallback } from "./support";
type MirrorHost = WireCallback<[registry: ModelRegistry]>;
export interface AuthServiceGlobals {
	readonly attachMirrorHost: (host: MirrorHost) => void;
}
class PeerAuthState {
	readonly subscriptions = new Set<() => void>();
	readonly mirrorHost = Promise.withResolvers<MirrorHost>();
	constructor() {
		this.mirrorHost.promise.catch(() => {});
	}
	release(): void {
		for (const unsubscribe of this.subscriptions) unsubscribe();
		this.mirrorHost.reject(new Error("Worker exited before its model registry mirror host attached"));
	}
}
const kPeerAuth = Symbol("thread.auth.peer");
function peerState(link: MainThreadLink): PeerAuthState {
	const existing: unknown = Reflect.get(link, kPeerAuth);
	if (existing instanceof PeerAuthState) return existing;
	const state = new PeerAuthState();
	Reflect.set(link, kPeerAuth, state);
	return state;
}

/** Swallow a rejection from a worker callback (its link may be closing); returns nothing either way. */
function settleQuietly(result: unknown): void {
	if (result instanceof Promise) {
		result.catch((error: unknown) => logger.debug("Worker auth callback failed", { error: String(error) }));
	}
}

function serveAuthStorage(state: PeerAuthState): RpcServe<AuthStorage, AuthStorageProtocol> {
	return {
		"credentials.generation": storage => storage.credentials.generation,
		"credentials.onGeneration": (storage, listener) =>
			trackWorkerSubscription(
				state.subscriptions,
				storage.credentials.onGeneration(generation => settleQuietly(listener(generation))),
			),
		"credentials.reload": storage => storage.credentials.reload(),
		"credentials.poll": storage => storage.credentials.poll(),
		"credentials.get": (storage, provider) => storage.credentials.get(provider),
		"credentials.all": storage => storage.credentials.all(),
		"credentials.list": (storage, provider) => storage.credentials.list(provider),
		"credentials.has": (storage, provider) => storage.credentials.has(provider),
		"credentials.set": (storage, provider, credential) => storage.credentials.set(provider, credential),
		"credentials.upsert": (storage, provider, credential) => storage.credentials.upsert(provider, credential),
		"credentials.remove": (storage, provider) => storage.credentials.remove(provider),
		"credentials.removeById": (storage, provider, id) => storage.credentials.removeById(provider, id),
		"keys.get": (storage, provider, sessionId, options) => storage.keys.get(provider, sessionId, options),
		"keys.getWithCredential": (storage, provider, sessionId, options) =>
			storage.keys.getWithCredential(provider, sessionId, options),
		"keys.has": (storage, provider) => storage.keys.has(provider),
		"keys.peek": (storage, provider, options) => storage.keys.peek(provider, options),
		"keys.source": (storage, provider, options) => storage.keys.source(provider, options),
		"keys.describe": (storage, provider, sessionId) => storage.keys.describe(provider, sessionId),
		"keys.setRuntime": (storage, provider, key) => storage.keys.setRuntime(provider, key),
		"keys.removeRuntime": (storage, provider) => storage.keys.removeRuntime(provider),
		"keys.setConfig": (storage, provider, config, options) => storage.keys.setConfig(provider, config, options),
		"keys.removeConfig": (storage, provider) => storage.keys.removeConfig(provider),
		"keys.clearConfig": storage => storage.keys.clearConfig(),
		"keys.setResolver": (storage, resolver) => storage.keys.setResolver(resolver),
		"keys.resolver": (storage, provider, options) => storage.keys.resolver(provider, options),
	};
}
function serveModelRegistry(state: PeerAuthState): RpcServe<ModelRegistry, ModelRegistryProtocol> {
	return {
		mirror: (registry, listener) => {
			const { snapshot, unsubscribe } = registry.subscribeMirror(batch => settleQuietly(listener(batch)));
			trackWorkerSubscription(state.subscriptions, unsubscribe);
			return { ...registry.mirrorInputs(), authStorage: registry.authStorage, snapshot };
		},
		invalidateCommandConfigs: (registry, provider) => registry.invalidateCommandConfigs(provider),
		refresh: (registry, strategy, options) => registry.refresh(strategy, options),
		refreshIfStale: registry => registry.refreshIfStale(),
	};
}
function mirrorModelRegistry(remote: RemoteObject<ModelRegistryProtocol>): ModelRegistry {
	// Batches arrive as later link messages, never during this synchronous build, so `registry` exists by then.
	const wire = remote.callSync("mirror", batch => {
		registry.applyMirrorBatch(batch);
	});
	const registry = new ModelRegistry(wire.authStorage, wire.modelsPath, {
		settings: wire.settings,
		owner: new RemoteModelRegistryOwner(remote),
	});
	registry.applyMirrorBatch(wire.snapshot);
	return registry;
}

/** Worker side: mirrors built by {@link prewarmModelRegistryMirror}, kept for the worker's life. */
const prewarmedMirrors = new Set<ModelRegistry>();

/**
 * Build worker `peer`'s mirror of `registry` now and compose its catalog
 * (`getAll`, `getAvailable`), so the first subagent session there finds it
 * warm. The mirror stays alive for the worker's life. Resolves once done;
 * rejects when the worker exits first.
 */
export async function prewarmModelRegistryMirror(peer: WorkerPeer, registry: ModelRegistry): Promise<void> {
	const host = await peerState(peer.link).mirrorHost.promise;
	await host(registry);
}
let authErrorsRegistered = false;
function registerAuthErrors(): void {
	if (authErrorsRegistered) return;
	authErrorsRegistered = true;
	registerRpcError("MissingApiKeyError", message => new MissingApiKeyError(undefined, message));
	registerRpcError("ConfigurationError", message => new ConfigurationError(message));
}
function isAuthServiceGlobals(value: unknown): value is AuthServiceGlobals {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "attachMirrorHost") === "function";
}
export const authService: ThreadService = {
	name: "auth",
	installMain(peer: WorkerPeer): void {
		registerAuthErrors();
		const link = peer.link;
		link.exportClass<AuthStorage, AuthStorageProtocol>(
			AUTH_STORAGE_KIND,
			(value): value is AuthStorage => value instanceof AuthStorage,
			serveAuthStorage(peerState(link)),
		);
		link.exportClass<ModelRegistry, ModelRegistryProtocol>(
			MODEL_REGISTRY_KIND,
			(value): value is ModelRegistry => value instanceof ModelRegistry,
			serveModelRegistry(peerState(link)),
		);
	},
	globals(peer: WorkerPeer): AuthServiceGlobals {
		const state = peerState(peer.link);
		return { attachMirrorHost: host => state.mirrorHost.resolve(host) };
	},
	onWorkerExit(peer: WorkerPeer): void {
		peerState(peer.link).release();
	},
	installWorker(link: WorkerThreadLink): void {
		registerAuthErrors();
		link.importClass<AuthStorage, AuthStorageProtocol>(
			AUTH_STORAGE_KIND,
			remote => new AuthStorage(new RemoteAuthStorageBackend(remote)),
		);
		link.importClass<ModelRegistry, ModelRegistryProtocol>(MODEL_REGISTRY_KIND, mirrorModelRegistry);
	},
	boot(globals: unknown): void {
		if (!isAuthServiceGlobals(globals))
			throw new Error("auth service: boot globals lack the model registry mirror host");
		const host: MirrorHost = registry => {
			prewarmedMirrors.add(registry);
			registry.getAll("all");
			registry.getAvailable("all");
		};
		settleQuietly(globals.attachMirrorHost(host));
	},
};
