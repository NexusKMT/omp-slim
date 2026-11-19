import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// Extensions may register a model after CLI parsing, so defer unresolved selectors until they load.
describe("--provider with a model registered by an extension", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = path.join(os.tmpdir(), `pi-cli-provider-deferral-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		await Bun.write(
			path.join(tempDir, "models.yml"),
			[
				"providers:",
				"  gateway:",
				"    baseUrl: https://models.example.invalid/v1",
				"    api: openai-completions",
				"    models:",
				"      - id: configured-model",
			].join("\n"),
		);
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function deferredPattern(cliArgs: string[]): Promise<string | string[] | undefined> {
		authStorage.keys.setRuntime("gateway", "test-key");
		vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			throw new Error(`buildSessionOptions exited with ${code}`);
		});
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const options = await buildSessionOptions(
			parseArgs(cliArgs),
			[],
			SessionManager.inMemory(),
			modelRegistry,
			Settings.isolated(),
		);
		return options.modelPattern;
	}

	test("defers the provider-qualified selector to post-extension resolution", async () => {
		expect(await deferredPattern(["--provider", "gateway", "--model", "extension-model"])).toBe(
			"gateway/extension-model",
		);
	});

	test("does not double the provider prefix", async () => {
		expect(await deferredPattern(["--provider", "gateway", "--model", "gateway/extension-model"])).toBe(
			"gateway/extension-model",
		);
	});
});

describe("print mode with an unavailable model", () => {
	test.each([
		{
			name: "CLI selector",
			args: ["--provider", "gateway", "--model", "missing-model"],
			error: 'Model "gateway/missing-model" is not configured',
		},
		{
			name: "configured selector",
			args: [],
			error: "Configured model gateway/missing-model is unavailable.",
		},
	])(
		"rejects the $name without requesting another available model",
		async ({ args, error }) => {
			const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cli-unavailable-model-"));
			const agentDir = path.join(workspace, "agent");
			let providerRequests = 0;
			const provider = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch() {
					providerRequests++;
					return Response.json({ error: { message: "Unexpected request" } }, { status: 500 });
				},
			});
			try {
				await Bun.write(
					path.join(agentDir, "config.yml"),
					"model: gateway/missing-model\nretry:\n  enabled: false\n",
				);
				await Bun.write(
					path.join(agentDir, "models.yml"),
					`providers:
  other:
    baseUrl: ${provider.url.href}v1
    apiKey: test-key
    models:
      - id: available-model
`,
				);
				const proc = Bun.spawn(
					[
						process.execPath,
						path.resolve(import.meta.dir, "../src/cli.ts"),
						"--no-title",
						"--no-lsp",
						"--no-extensions",
						"--no-tools",
						"--no-session",
						"-p",
						...args,
						"hi",
					],
					{
						cwd: workspace,
						env: {
							PATH: process.env.PATH,
							TMPDIR: process.env.TMPDIR,
							PI_CODING_AGENT_DIR: agentDir,
							NO_COLOR: "1",
						},
						stdin: "ignore",
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				try {
					const [exitCode, stdout, stderr] = await Promise.all([
						proc.exited,
						new Response(proc.stdout).text(),
						new Response(proc.stderr).text(),
					]);
					expect(exitCode).toBe(1);
					expect(stderr).toContain(error);
					expect(stderr).not.toContain("other/available-model");
					expect(stdout).toBe("");
					expect(providerRequests).toBe(0);
				} finally {
					proc.kill();
					await proc.exited;
				}
			} finally {
				provider.stop(true);
				removeSyncWithRetries(workspace);
			}
		},
		60_000,
	);
});
