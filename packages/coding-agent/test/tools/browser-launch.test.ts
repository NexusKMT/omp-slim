import { describe, expect, it } from "bun:test";
import {
	stealthIgnoreDefaultArgsForTest,
	systemChromiumCandidatesForTest,
} from "@oh-my-pi/pi-coding-agent/tools/browser/launch";

const AUTOMATION_FLAG = "--enable-automation";

const EDGE_EXECUTABLE_PATHS = [
	"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	"/usr/bin/microsoft-edge-stable",
] as const;

const CHROME_EXECUTABLE_PATHS = [
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/chromium",
] as const;

describe("browser launch stealth defaults", () => {
	it("keeps Puppeteer's automation default for Microsoft Edge executables", () => {
		for (const executablePath of EDGE_EXECUTABLE_PATHS) {
			const ignoreDefaultArgs = stealthIgnoreDefaultArgsForTest(executablePath);

			expect(ignoreDefaultArgs).not.toContain(AUTOMATION_FLAG);
			expect(ignoreDefaultArgs).toContain("--disable-extensions");
		}
	});

	it("continues filtering Puppeteer's automation default for Chrome and Chromium executables", () => {
		for (const executablePath of CHROME_EXECUTABLE_PATHS) {
			const ignoreDefaultArgs = stealthIgnoreDefaultArgsForTest(executablePath);

			expect(ignoreDefaultArgs).toContain(AUTOMATION_FLAG);
		}
	});
});

const UNGOOGLED_CHROMIUM_FLATPAK_ID = "io.github.ungoogled_software.ungoogled_chromium";

describe("system Chromium candidates on Linux", () => {
	it("offers Ungoogled Chromium executables", () => {
		if (process.platform !== "linux") return;
		const candidates = systemChromiumCandidatesForTest();

		expect(candidates).toContain("/usr/bin/ungoogled-chromium");
		expect(candidates).toContain("/usr/bin/ungoogled-chromium-browser");
		expect(candidates).toContain(`/var/lib/flatpak/exports/bin/${UNGOOGLED_CHROMIUM_FLATPAK_ID}`);

		const perUserFlatpak = candidates.find(candidate =>
			candidate.endsWith(`/.local/share/flatpak/exports/bin/${UNGOOGLED_CHROMIUM_FLATPAK_ID}`),
		);
		expect(perUserFlatpak).toBeDefined();
	});

	it("keeps the previously supported executables", () => {
		if (process.platform !== "linux") return;
		const candidates = systemChromiumCandidatesForTest();

		for (const executablePath of [
			"/usr/bin/google-chrome-stable",
			"/usr/bin/google-chrome",
			"/usr/bin/chromium",
			"/usr/bin/chromium-browser",
			"/snap/bin/chromium",
			"/var/lib/flatpak/exports/bin/com.google.Chrome",
			"/var/lib/flatpak/exports/bin/org.chromium.Chromium",
		]) {
			expect(candidates).toContain(executablePath);
		}
	});

	it("ranks Ungoogled Chromium below the stock builds", () => {
		if (process.platform !== "linux") return;
		const candidates = systemChromiumCandidatesForTest();
		const ungoogled = candidates.indexOf("/usr/bin/ungoogled-chromium");

		for (const executablePath of [
			"/usr/bin/google-chrome-stable",
			"/usr/bin/chromium",
			"/snap/bin/chromium",
			"/var/lib/flatpak/exports/bin/org.chromium.Chromium",
		]) {
			expect(ungoogled).toBeGreaterThan(candidates.indexOf(executablePath));
		}
	});
});
