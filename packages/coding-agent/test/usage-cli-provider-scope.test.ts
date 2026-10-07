import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { runUsageCommand } from "@oh-my-pi/pi-coding-agent/cli/usage-cli";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";

let authStorage: AuthStorage;
let stdout: string;
let stderr: string;

beforeEach(async () => {
	authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	await authStorage.credentials.reload();
	await authStorage.credentials.set("groq", { type: "api_key", key: "gsk-test" });
	vi.spyOn(Settings, "loadReadOnly").mockResolvedValue(Settings.isolated());
	vi.spyOn(sdkModule, "discoverAuthStorage").mockResolvedValue(authStorage);
	stdout = "";
	stderr = "";
	vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
		stdout += String(chunk);
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
		stderr += String(chunk);
		return true;
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = 0;
});

test("omp usage --provider with no stored credentials names the providers that have them", async () => {
	await runUsageCommand({ provider: "claude", noExtensions: true });
	expect(Bun.stripANSI(stderr)).toBe(
		'No credentials stored for provider "claude". Providers with stored credentials: groq.\n',
	);
	expect(process.exitCode).toBe(1);
});

test("omp usage invalidate refuses a provider with no stored credentials", async () => {
	await runUsageCommand({ action: "invalidate", provider: "nosuch" });
	expect(stdout).toBe("");
	expect(Bun.stripANSI(stderr)).toBe(
		'No credentials stored for provider "nosuch". Providers with stored credentials: groq.\n',
	);
	expect(process.exitCode).toBe(1);

	process.exitCode = 0;
	await runUsageCommand({ action: "invalidate", provider: "groq" });
	expect(stdout).toBe('Invalidated cached usage reports for provider "groq".\n');
	expect(process.exitCode).toBe(0);
});
