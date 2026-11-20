import { isBunTestRuntime, TempDir } from "@oh-my-pi/pi-utils";
import * as path from "node:path";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { createAgentSession } from "../../src/sdk";
import { AuthStorage } from "../../src/session/auth-storage";
import { CostGate } from "../../src/session/cost-gate";
import { SessionManager } from "../../src/session/session-manager";
import { createAssistantMessage } from "../helpers/agent-session-setup";

// Run as `bun <this-file> supplied|root`, not under `bun test`:
// the SDK intentionally disables its description store in Bun's test runtime.
const mode = Bun.argv[2];
if (mode !== "supplied" && mode !== "root") throw new Error(`Unknown mode: ${mode}`);
// Without the store no compression starts, so `supplied`/`root` would pass vacuously.
if (isBunTestRuntime()) throw new Error("Run this fixture outside the test runtime (unset PI_TEST_RUNTIME)");
using dir = TempDir.createSync("@omp-skill-cap-probe-");
let calls = 0;
const originalFetch = globalThis.fetch;
const rejectingFetch = async () => {
	calls++;
	throw new Error("network refused by probe");
};
rejectingFetch.preconnect = originalFetch.preconnect;
globalThis.fetch = rejectingFetch;
const auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
try {
	const settings = Settings.isolated({
		"session.maxCost": 1,
		// The gate's warning marks the moment it was recorded.
		"session.warnCost": 1,
		"marketplace.autoUpdate": "off",
	});
	settings.setModel("denied/probe");
	const registry = new ModelRegistry(auth, path.join(dir.path(), "models.yml"), { settings });
	registry.registerProvider("denied", {
		api: "openai-completions",
		baseUrl: "https://provider.invalid/v1",
		apiKey: "synthetic-not-a-credential",
		models: [
			{
				id: "probe",
				name: "Probe",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 4096,
				maxTokens: 1024,
			},
		],
	});
	const model = registry.find("denied", "probe");
	if (!model) throw new Error("Missing synthetic model");
	const sessionManager = SessionManager.inMemory(dir.path());
	if (mode === "root") {
		const previous = createAssistantMessage("Earlier spend");
		previous.usage.cost.total = 1;
		sessionManager.appendMessage(previous);
	}
	const recorded = Promise.withResolvers<void>();
	const gate =
		mode === "root" ? undefined : new CostGate(settings, mode === "supplied" ? 1 : 0, () => recorded.resolve());
	const { session } = await createAgentSession({
		cwd: dir.path(),
		agentDir: dir.path(),
		sessionManager,
		authStorage: auth,
		modelRegistry: registry,
		settings,
		model,
		costGate: gate,
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		skills: [
			{
				name: "attribution",
				description:
					"An uncached synthetic skill description to trigger background compression without any provider network admission.",
				filePath: path.join(dir.path(), "SKILL.md"),
				baseDir: dir.path(),
				source: "native:project",
			},
		],
	});
	await session.dispose();
	console.log(JSON.stringify({ calls, spent: session.costGate.spent }));
} finally {
	auth.close();
	globalThis.fetch = originalFetch;
}
