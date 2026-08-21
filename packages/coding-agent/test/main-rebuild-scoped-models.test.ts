import { describe, expect, it } from "bun:test";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { resolveModelScope } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	rebuildScopedModelsAfterDiscovery,
	type ScopedModelSink,
	toSessionScopedModels,
} from "@oh-my-pi/pi-coding-agent/main";

function model(id: string): Model<Api> {
	return buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider: "prov",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	});
}

/** Mutable stand-in for {@link ModelRegistry}: `available` grows to mimic a background discovery pass. */
class FakeRegistry {
	available: Model<Api>[];
	constructor(initial: Model<Api>[]) {
		this.available = initial;
	}
	getAvailable(): Model<Api>[] {
		return this.available;
	}
	async awaitBackgroundRefresh(): Promise<void> {}
}

class FakeSession implements ScopedModelSink {
	isDisposed = false;
	scopedModels: ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	setCalls = 0;
	constructor(initial: ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }>) {
		this.scopedModels = initial;
	}
	setScopedModels(scopedModels: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>): void {
		this.setCalls += 1;
		this.scopedModels = scopedModels;
	}
}

async function startupScope(
	patterns: string[],
	registry: FakeRegistry,
	settings: Settings,
): Promise<Array<{ model: Model; thinkingLevel?: ThinkingLevel }>> {
	return toSessionScopedModels(await resolveModelScope(patterns, registry, undefined, settings), settings);
}

describe("rebuildScopedModelsAfterDiscovery", () => {
	it("adds an enabledModels model that only materializes after background discovery", async () => {
		const settings = Settings.isolated({ enabledModels: ["prov/a", "prov/b"] });
		const registry = new FakeRegistry([model("a")]);
		// Startup resolves the scope before discovery: `prov/b` is not yet available.
		const session = new FakeSession(await startupScope(["prov/a", "prov/b"], registry, settings));
		expect(session.scopedModels.map(s => s.model.id)).toEqual(["a"]);

		// Background discovery completes and populates the registry.
		registry.available = [model("a"), model("b")];
		await rebuildScopedModelsAfterDiscovery(session, parseArgs([]), registry, settings);

		expect(session.setCalls).toBe(1);
		expect(session.scopedModels.map(s => s.model.id)).toEqual(["a", "b"]);
	});

	it("leaves the scope untouched when discovery adds nothing matching", async () => {
		const settings = Settings.isolated({ enabledModels: ["prov/a", "prov/b"] });
		const registry = new FakeRegistry([model("a"), model("b")]);
		const session = new FakeSession(await startupScope(["prov/a", "prov/b"], registry, settings));
		const before = session.scopedModels;

		// A later discovery pass adds an unrelated, out-of-scope model.
		registry.available = [model("a"), model("b"), model("c")];
		await rebuildScopedModelsAfterDiscovery(session, parseArgs([]), registry, settings);

		expect(session.setCalls).toBe(0);
		expect(session.scopedModels).toBe(before);
	});

	it("does not promote an empty (collapsed) scope into a scoped session", async () => {
		const settings = Settings.isolated({ enabledModels: ["prov/b"] });
		const registry = new FakeRegistry([model("a")]);
		// `prov/b` matches nothing at startup, so no scope is active.
		const session = new FakeSession(await startupScope(["prov/b"], registry, settings));
		expect(session.scopedModels).toHaveLength(0);

		registry.available = [model("a"), model("b")];
		await rebuildScopedModelsAfterDiscovery(session, parseArgs([]), registry, settings);

		// Turning a collapsed scope into a live one is the SDK discovery-fallback's job.
		expect(session.setCalls).toBe(0);
		expect(session.scopedModels).toHaveLength(0);
	});

	it("re-resolves an explicit --models scope against the discovery-backed catalog", async () => {
		const settings = Settings.isolated();
		const registry = new FakeRegistry([model("a")]);
		const session = new FakeSession(await startupScope(["prov/a", "prov/b"], registry, settings));
		expect(session.scopedModels.map(s => s.model.id)).toEqual(["a"]);

		registry.available = [model("a"), model("b")];
		await rebuildScopedModelsAfterDiscovery(session, parseArgs(["--models", "prov/a,prov/b"]), registry, settings);

		expect(session.scopedModels.map(s => s.model.id)).toEqual(["a", "b"]);
	});

	it("skips the rebuild once the session is disposed", async () => {
		const settings = Settings.isolated({ enabledModels: ["prov/a", "prov/b"] });
		const registry = new FakeRegistry([model("a")]);
		const session = new FakeSession(await startupScope(["prov/a", "prov/b"], registry, settings));
		session.isDisposed = true;

		registry.available = [model("a"), model("b")];
		await rebuildScopedModelsAfterDiscovery(session, parseArgs([]), registry, settings);

		expect(session.setCalls).toBe(0);
		expect(session.scopedModels.map(s => s.model.id)).toEqual(["a"]);
	});
});
