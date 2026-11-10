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

// An id the startup catalog lacks may still come from an extension or account
// discovery, so `--provider p --model id` defers like `--model p/id` instead of
// exiting before either has run.
describe("--provider with a model the startup catalog lacks", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = path.join(os.tmpdir(), `pi-cli-provider-deferral-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
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
		authStorage.keys.setRuntime("anthropic", "test-key");
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
		expect(await deferredPattern(["--provider", "anthropic", "--model", "claude-unreleased-9"])).toBe(
			"anthropic/claude-unreleased-9",
		);
	});

	test("does not double the provider prefix", async () => {
		expect(await deferredPattern(["--provider", "anthropic", "--model", "anthropic/claude-unreleased-9"])).toBe(
			"anthropic/claude-unreleased-9",
		);
	});

	test("defers a discovery provider that holds no models until its refresh", async () => {
		const hasProvider = modelRegistry.hasProvider.bind(modelRegistry);
		vi.spyOn(modelRegistry, "hasProvider").mockImplementation(id => id === "proxy" || hasProvider(id));
		expect(await deferredPattern(["--provider", "proxy", "--model", "some-model"])).toBe("proxy/some-model");
	});
});

describe("print-mode suggestions for a provider-qualified miss", () => {
	test("never lists other providers' models", async () => {
		const home = path.join(os.tmpdir(), `pi-cli-qualified-hint-${Snowflake.next()}`);
		fs.mkdirSync(home, { recursive: true });
		try {
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
					"--provider",
					"anthropic",
					"--model",
					"gpt-4o",
					"hi",
				],
				{
					cwd: home,
					env: {
						PATH: process.env.PATH,
						HOME: home,
						USERPROFILE: home,
						TMPDIR: process.env.TMPDIR,
						NO_COLOR: "1",
						ANTHROPIC_API_KEY: "test-key",
						OPENAI_API_KEY: "test-key",
					},
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
			expect(exitCode).toBe(1);
			expect(stderr).toContain('Model "anthropic/gpt-4o" not found');
			expect(stderr).not.toContain("openai/");
		} finally {
			removeSyncWithRetries(home);
		}
	}, 60_000);
});

describe("print mode with a stale configured model", () => {
	test.each([
		{ name: "current model", config: "model: anthropic/claude-sonnet-9-9\n" },
		{ name: "legacy default", config: "modelRoles:\n  default: anthropic/claude-sonnet-9-9\n" },
	])(
		"rejects an unavailable $name without sending a provider request",
		async ({ config }) => {
			const fixtureHome = path.join(os.tmpdir(), `pi-cli-stale-model-${Snowflake.next()}`);
			const agentDir = path.join(fixtureHome, ".omp", "agent");
			let providerRequests = 0;
			const provider = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch() {
					providerRequests++;
					return Response.json(
						{ error: { type: "api_error", message: "Unexpected provider request" } },
						{ status: 500 },
					);
				},
			});
			try {
				await Bun.write(path.join(agentDir, "config.yml"), `${config}retry:\n  enabled: false\n`);
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
						"hi",
					],
					{
						cwd: fixtureHome,
						env: {
							PATH: process.env.PATH,
							HOME: fixtureHome,
							USERPROFILE: fixtureHome,
							TMPDIR: process.env.TMPDIR,
							NO_COLOR: "1",
							ANTHROPIC_API_KEY: "test-key",
							ANTHROPIC_BASE_URL: provider.url.href,
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
					expect(stderr).toContain("Configured model anthropic/claude-sonnet-9-9 is unavailable.");
					expect(stdout).toBe("");
					expect(providerRequests).toBe(0);
				} finally {
					proc.kill();
					await proc.exited;
				}
			} finally {
				provider.stop(true);
				removeSyncWithRetries(fixtureHome);
			}
		},
		60_000,
	);
});
