/**
 * Regression test for issue #13579.
 *
 * `omp usage` never loaded extensions, so a usage provider registered via
 * `pi.registerProvider(name, { usage })` was never consulted and the account
 * landed in `accountsWithoutUsage` instead of producing a report.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { runUsageCommand } from "@oh-my-pi/pi-coding-agent/cli/usage-cli";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { TempDir } from "@oh-my-pi/pi-utils";

const EXTENSION_SOURCE = `export default function (pi) {
	pi.registerProvider("ext-usage", {
		usage: {
			id: "ext-usage",
			async fetchUsage() {
				return {
					provider: "ext-usage",
					fetchedAt: Date.now(),
					limits: [{
						id: "credits",
						label: "Credits",
						scope: { provider: "ext-usage" },
						amount: { used: 6, limit: 10, unit: "usd", usedFraction: 0.6 },
					}],
				};
			},
		},
	});
}
`;

let tmp: TempDir;
let extPath: string;

beforeEach(async () => {
	tmp = await TempDir.create("@issue-13579-");
	extPath = tmp.join("ext.ts");
	await Bun.write(extPath, EXTENSION_SOURCE);
	const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	await authStorage.credentials.reload();
	await authStorage.credentials.set("ext-usage", { type: "api_key", key: "sk-test" });
	vi.spyOn(Settings, "loadReadOnly").mockResolvedValue(Settings.isolated());
	vi.spyOn(sdkModule, "discoverAuthStorage").mockResolvedValue(authStorage);
});

afterEach(async () => {
	vi.restoreAllMocks();
	await tmp.remove();
});

async function usageJson(extensions: string[]): Promise<{
	reports: Array<{ provider: string; limits: Array<{ id: string }> }>;
	accountsWithoutUsage: Array<{ provider: string }>;
}> {
	const chunks: string[] = [];
	vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
		chunks.push(String(chunk));
		return true;
	});
	await runUsageCommand({ json: true, provider: "ext-usage", extensions, noExtensions: true });
	return JSON.parse(chunks.join(""));
}

test("omp usage reports accounts through an extension-registered usage provider (issue #13579)", async () => {
	const output = await usageJson([extPath]);
	expect(output.reports.map(report => [report.provider, report.limits.map(limit => limit.id)])).toEqual([
		["ext-usage", ["credits"]],
	]);
	expect(output.accountsWithoutUsage).toEqual([]);
});
