import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { __resetDirsFromEnvForTests, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { runSearchCommand } from "../../../src/cli/web-search-cli";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalOmpProfile = process.env.OMP_PROFILE;
const originalPiProfile = process.env.PI_PROFILE;

let tempAgentDir: TempDir | undefined;
let originalExitCode: typeof process.exitCode;

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

function makeFetchMock(): typeof fetch {
	return Object.assign(
		async (input: string | Request | URL): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url === "https://www.startpage.com/") {
				return new Response("<html><body></body></html>", {
					status: 200,
					headers: { "Content-Type": "text/html" },
				});
			}
			if (url.startsWith("https://www.startpage.com/sp/search")) {
				return new Response(
					'<div class="result"><a class="result-link" href="https://startpage.example"><h2>Startpage result</h2></a><p class="description">startpage</p></div>',
					{ status: 200, headers: { "Content-Type": "text/html" } },
				);
			}
			if (url === "https://html.duckduckgo.com/html/") {
				return new Response(
					'<div class="result"><a class="result__a" href="https://duckduckgo.example">DuckDuckGo result</a><a class="result__snippet">duckduckgo</a></div>',
					{ status: 200, headers: { "Content-Type": "text/html" } },
				);
			}
			return new Response(`unexpected URL: ${url}`, { status: 500 });
		},
		{ preconnect: fetch.preconnect },
	);
}

beforeEach(async () => {
	originalExitCode = process.exitCode;
	process.exitCode = undefined;
	resetSettingsForTest();
	tempAgentDir = TempDir.createSync("@omp-search-cli-");
	setAgentDir(tempAgentDir.path());
	await Settings.init({ inMemory: true, cwd: tempAgentDir.path() });
});

afterEach(async () => {
	vi.restoreAllMocks();
	resetSettingsForTest();
	process.exitCode = originalExitCode;
	restoreEnv("PI_CODING_AGENT_DIR", originalAgentDir);
	restoreEnv("OMP_PROFILE", originalOmpProfile);
	restoreEnv("PI_PROFILE", originalPiProfile);
	__resetDirsFromEnvForTests();
	// runSearchCommand opens <agentDir>/models.db; Windows cannot delete an open database.
	closeModelCache();
	if (tempAgentDir) {
		await tempAgentDir.remove();
		tempAgentDir = undefined;
	}
});

describe("runSearchCommand HTTP engine selection", () => {
	it.each(["startpage", "duckduckgo"] as const)("searches using the explicit %s engine", async engine => {
		vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchMock());
		let stdout = "";
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		});

		await runSearchCommand({ query: "explicit HTTP engine selection", engine, limit: 1, expanded: false });

		const plain = stripVTControlCharacters(stdout);
		expect(plain).toContain(`${engine}.example`);
		expect(plain).not.toContain(`${engine === "startpage" ? "duckduckgo" : "startpage"}.example`);
	});
});
