/** Refresh an explicit local model registry through its owning main thread. */
import type {
	ModelRefreshStrategy,
	ModelRegistryOwner,
	ModelRegistryRefreshOptions,
} from "../../config/model-registry";
import type { RemoteObject } from "../rpc";
import type { ModelRegistryProtocol } from "./auth-protocol";
export class RemoteModelRegistryOwner implements ModelRegistryOwner {
	constructor(readonly remote: RemoteObject<ModelRegistryProtocol>) {}
	invalidateCommandConfigs(provider?: string): void {
		this.remote.notify("invalidateCommandConfigs", provider);
	}
	refresh(strategy?: ModelRefreshStrategy, options?: ModelRegistryRefreshOptions): Promise<void> {
		return this.remote.call("refresh", strategy, options);
	}
	refreshIfStale(): Promise<boolean> {
		return this.remote.call("refreshIfStale");
	}
}
