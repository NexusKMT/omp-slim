import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Personality } from "@oh-my-pi/pi-coding-agent/session/settings";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { __resetDirsFromEnvForTests, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "./helpers/settings-test-state";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

const OVERRIDE = "Follow ASD-STE100 Simplified Technical English for all responses.";

// Custom templates can opt into the retained personality setting and user override.
describe("PERSONALITY.md in an explicit template", () => {
	let tempDir = "";
	let tempAgentDir = "";
	let originalAgentDirEnv: string | undefined;
	let originalOmpProfileEnv: string | undefined;
	let originalPiProfileEnv: string | undefined;

	beforeEach(() => {
		originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
		originalOmpProfileEnv = process.env.OMP_PROFILE;
		originalPiProfileEnv = process.env.PI_PROFILE;
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-personality-"));
		tempAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-personality-agent-"));
		setAgentDir(tempAgentDir);
	});

	afterEach(() => {
		restoreEnvValue("PI_CODING_AGENT_DIR", originalAgentDirEnv);
		restoreEnvValue("OMP_PROFILE", originalOmpProfileEnv);
		restoreEnvValue("PI_PROFILE", originalPiProfileEnv);
		__resetDirsFromEnvForTests();
		removeSyncWithRetries(tempDir);
		removeSyncWithRetries(tempAgentDir);
	});

	async function renderPrompt(personality?: Personality): Promise<string> {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			personality,
			systemPromptTemplate: "{{personality}}",
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
		});
		return systemPrompt.join("\n\n");
	}

	function writePersonalityFile(content: string): void {
		fs.writeFileSync(path.join(tempAgentDir, "PERSONALITY.md"), content);
	}

	it("replaces the selected preset's text with <agentDir>/PERSONALITY.md", async () => {
		writePersonalityFile(OVERRIDE);

		const rendered = await renderPrompt("default");
		expect(rendered).toContain(OVERRIDE);
	});

	it(`omits the block for personality "none" even when PERSONALITY.md exists (subagent contract)`, async () => {
		writePersonalityFile(OVERRIDE);

		const rendered = await renderPrompt("none");
		expect(rendered).not.toContain(OVERRIDE);
	});

	it("falls back to the configured preset when the file is empty", async () => {
		const fallback = await renderPrompt("default");
		writePersonalityFile("   \n");

		const rendered = await renderPrompt("default");
		expect(rendered).toBe(fallback);
	});
});
