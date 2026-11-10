/** Worker references to the main thread's API-key store. */
import type { AuthStorageBackend, CredentialsApi, KeysApi } from "@oh-my-pi/pi-ai";
import { type RemoteObject, RpcClosedError } from "../rpc";
import type { AuthStorageProtocol } from "./auth-protocol";

function remoteUnsubscribe(unsubscribe: () => void): () => void {
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		try {
			unsubscribe();
		} catch (error) {
			if (!(error instanceof RpcClosedError)) throw error;
		}
	};
}

/** The main thread owns persistence; closing a worker only releases its subscriptions. */
export class RemoteAuthStorageBackend implements AuthStorageBackend {
	readonly credentials: CredentialsApi;
	readonly keys: KeysApi;
	readonly #subscriptions = new Set<() => void>();
	constructor(remote: RemoteObject<AuthStorageProtocol>) {
		this.credentials = {
			get generation() {
				return remote.callSync("credentials.generation");
			},
			onGeneration: listener => {
				const unsubscribe = remoteUnsubscribe(remote.callSync("credentials.onGeneration", listener));
				const dispose = () => {
					unsubscribe();
					this.#subscriptions.delete(dispose);
				};
				this.#subscriptions.add(dispose);
				return dispose;
			},
			reload: () => remote.call("credentials.reload"),
			poll: () => remote.call("credentials.poll"),
			get: provider => remote.callSync("credentials.get", provider),
			all: () => remote.callSync("credentials.all"),
			list: provider => remote.callSync("credentials.list", provider),
			has: provider => remote.callSync("credentials.has", provider),
			set: (provider, credential) => remote.call("credentials.set", provider, credential),
			upsert: (provider, credential) => remote.call("credentials.upsert", provider, credential),
			remove: provider => remote.call("credentials.remove", provider),
			removeById: (provider, id) => remote.call("credentials.removeById", provider, id),
		};
		this.keys = {
			get: (provider, sessionId, options) => remote.call("keys.get", provider, sessionId, options),
			getWithCredential: (provider, sessionId, options) =>
				remote.call("keys.getWithCredential", provider, sessionId, options),
			has: provider => remote.call("keys.has", provider),
			peek: (provider, options) => remote.call("keys.peek", provider, options),
			source: (provider, options) => remote.callSync("keys.source", provider, options),
			describe: (provider, sessionId) => remote.callSync("keys.describe", provider, sessionId),
			setRuntime: (provider, key) => remote.notify("keys.setRuntime", provider, key),
			removeRuntime: provider => remote.notify("keys.removeRuntime", provider),
			setConfig: (provider, config, options) => remote.notify("keys.setConfig", provider, config, options),
			removeConfig: provider => remote.notify("keys.removeConfig", provider),
			clearConfig: () => remote.notify("keys.clearConfig"),
			setResolver: resolver => remote.notify("keys.setResolver", resolver),
			resolver: (provider, options) => remote.callSync("keys.resolver", provider, options),
		};
	}
	close(): void {
		for (const unsubscribe of this.#subscriptions) unsubscribe();
	}
}
