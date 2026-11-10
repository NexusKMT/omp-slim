/** Generic API keys and explicit model registry state shared with worker threads. */
import type {
	ApiKeyResolver,
	AuthApiKeyOptions,
	AuthCredential,
	AuthCredentialEntry,
	AuthPeekOptions,
	AuthSource,
	AuthSourceOptions,
	AuthStorage,
	AuthStorageData,
	ResolvedApiKey,
	StoredAuthCredential,
} from "@oh-my-pi/pi-ai";
import type {
	ModelRefreshStrategy,
	ModelRegistryMirrorBatch,
	ModelRegistryMirrorInputs,
	ModelRegistryRefreshOptions,
} from "../../config/model-registry";
import type { RpcMethod } from "../rpc";

export const AUTH_STORAGE_KIND = "auth-storage";
export const MODEL_REGISTRY_KIND = "model-registry";

export type AuthStorageProtocol = {
	"credentials.generation": RpcMethod<[], number>;
	"credentials.onGeneration": RpcMethod<[listener: (generation: number) => void], () => void>;
	"credentials.reload": RpcMethod<[], void>;
	"credentials.poll": RpcMethod<[], boolean>;
	"credentials.get": RpcMethod<[provider: string], AuthCredential | undefined>;
	"credentials.all": RpcMethod<[], AuthStorageData>;
	"credentials.list": RpcMethod<[provider?: string], StoredAuthCredential[]>;
	"credentials.has": RpcMethod<[provider: string], boolean>;
	"credentials.set": RpcMethod<[provider: string, credential: AuthCredentialEntry], void>;
	"credentials.upsert": RpcMethod<[provider: string, credential: AuthCredential], StoredAuthCredential[]>;
	"credentials.remove": RpcMethod<[provider: string], void>;
	"credentials.removeById": RpcMethod<[provider: string, credentialId: number], boolean>;
	"keys.get": RpcMethod<[provider: string, sessionId?: string, options?: AuthApiKeyOptions], string | undefined>;
	"keys.getWithCredential": RpcMethod<
		[provider: string, sessionId?: string, options?: AuthApiKeyOptions],
		ResolvedApiKey | undefined
	>;
	"keys.has": RpcMethod<[provider: string], boolean>;
	"keys.peek": RpcMethod<[provider: string, options?: AuthPeekOptions], string | undefined>;
	"keys.source": RpcMethod<[provider: string, options?: AuthSourceOptions], AuthSource | undefined>;
	"keys.describe": RpcMethod<[provider: string, sessionId?: string], string | undefined>;
	"keys.setRuntime": RpcMethod<[provider: string, apiKey: string], void>;
	"keys.removeRuntime": RpcMethod<[provider: string], void>;
	"keys.setConfig": RpcMethod<[provider: string, apiKeyConfig: string, options?: { fallback?: boolean }], void>;
	"keys.removeConfig": RpcMethod<[provider: string], void>;
	"keys.clearConfig": RpcMethod<[], void>;
	"keys.setResolver": RpcMethod<[resolver: (config: string) => Promise<string | undefined>], void>;
	"keys.resolver": RpcMethod<
		[provider: string, options?: { sessionId?: string; baseUrl?: string; modelId?: string }],
		ApiKeyResolver
	>;
};

export interface ModelRegistryMirrorWire extends ModelRegistryMirrorInputs {
	readonly authStorage: AuthStorage;
	readonly snapshot: ModelRegistryMirrorBatch;
}
export type ModelRegistryProtocol = {
	mirror: RpcMethod<[listener: (batch: ModelRegistryMirrorBatch) => void], ModelRegistryMirrorWire>;
	invalidateCommandConfigs: RpcMethod<[provider?: string], void>;
	refresh: RpcMethod<[strategy?: ModelRefreshStrategy, options?: ModelRegistryRefreshOptions], void>;
	refreshIfStale: RpcMethod<[], boolean>;
};
