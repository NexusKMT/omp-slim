import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeWithSettings, reset as resetDiscoveryCache } from "@oh-my-pi/pi-coding-agent/discovery";
import { ExtensionDashboard } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/extension-dashboard";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const ARROW_DOWN = "\x1b[B";
const CTRL_O = "\x0f";

beforeAll(async () => {
	await initTheme(false);
});

describe("ExtensionDashboard inspector keyboard scroll", () => {
	let projectDir = "";
	let userAgentDir = "";
	let originalHome: string | undefined;
	let originalRows: number | undefined;

	beforeEach(async () => {
		clearFsCache();
		resetDiscoveryCache();
		resetSettingsForTest();
		originalHome = process.env.HOME;
		originalRows = process.stdout.rows;
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 18 });
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ext-inspector-scroll-"));
		userAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ext-inspector-scroll-user-"));
		process.env.HOME = userAgentDir;
		setAgentDir(userAgentDir);
		const commandsDir = path.join(projectDir, ".omp", "commands");
		await fs.mkdir(commandsDir, { recursive: true });
		const body = Array.from({ length: 80 }, (_, i) => `scroll-line-${i + 1}`).join("\n");
		await fs.writeFile(
			path.join(commandsDir, "scrollprobe.md"),
			`---\ndescription: "long inspector body"\n---\n\n${body}\n`,
		);
	});

	afterEach(async () => {
		resetSettingsForTest();
		resetDiscoveryCache();
		clearFsCache();
		__resetDirsFromEnvForTests();
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: originalRows });
		await removeWithRetries(projectDir);
		await removeWithRetries(userAgentDir);
	});

	test("PageDown/PageUp scroll an overflowed inspector; arrows stay on the list", async () => {
		const settings = await Settings.init({ inMemory: true, cwd: projectDir });
		initializeWithSettings(settings);
		const dashboard = await ExtensionDashboard.create({
			cwd: projectDir,
			settings,
			terminalHeight: 18,
		});

		dashboard.render(120);
		for (const ch of "scrollprobe") dashboard.handleInput(ch);

		const filtered = Bun.stripANSI(dashboard.render(120).join("\n"));
		expect(filtered).toContain("scrollprobe");
		expect(filtered).toContain("long inspector body");
		expect(filtered).not.toContain("scroll-line-80");

		dashboard.handleInput(CTRL_O);
		dashboard.render(120);
		dashboard.handleInput(PAGE_DOWN);
		const paged = Bun.stripANSI(dashboard.render(120).join("\n"));
		expect(paged).toMatch(/scroll-line-\d+/);

		dashboard.handleInput(PAGE_UP);
		const restored = Bun.stripANSI(dashboard.render(120).join("\n"));
		expect(restored).toContain("scrollprobe");
		expect(restored).toContain("long inspector body");

		dashboard.handleInput(ARROW_DOWN);
		const afterArrow = Bun.stripANSI(dashboard.render(120).join("\n"));
		expect(afterArrow).toContain("scrollprobe");
		expect(afterArrow).toContain("long inspector body");

		dashboard.dispose();
	});
});
