import { afterEach, describe, expect, it, vi } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

// Regression probe for https://github.com/can1357/oh-my-pi/issues/4863
//
// On ConPTY hosts (native Windows + WSL) a full paint over a large transcript
// is bounded by #truncateLargeConptyFrame: it keeps only the tail and replaces
// the older committed prefix with an "older lines hidden" marker. That bound is
// wanted for the *initial* session resume (issue #2115) where a multi-megabyte
// synchronized frame stalls conhost. But it also fired on the user-initiated
// Ctrl+O expand (resetDisplay), so pressing Ctrl+O to review the whole session
// dropped everything above the retained tail. The reporter hit this under WSL.

const PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, "platform");

class LargeContent implements Component {
	#lines: string[];

	constructor(lineCount: number) {
		this.#lines = [];
		for (let i = 0; i < lineCount; i++) {
			this.#lines.push(`row ${i.toString().padStart(5, "0")}: ${"x".repeat(100)}`);
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const rendered = new Array<string>(this.#lines.length);
		for (let i = 0; i < this.#lines.length; i++) rendered[i] = this.#lines[i]!.slice(0, width);
		return rendered;
	}
}

describe("issue #4863: Ctrl+O full-view expand truncates the session on ConPTY", () => {
	afterEach(() => {
		if (PLATFORM_DESCRIPTOR) Object.defineProperty(process, "platform", PLATFORM_DESCRIPTOR);
		delete process.env.WSL_DISTRO_NAME;
		vi.restoreAllMocks();
	});

	it("does not drop older transcript rows on a user-driven resetDisplay under WSL", async () => {
		// Reporter's environment: WSL. isConPTYHosted() is true on linux when a
		// WSL marker is present (stdout still crosses into ConPTY at wslhost).
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		process.env.WSL_DISTRO_NAME = "Ubuntu";
		const term = new VirtualTerminal(80, 24, 20_000);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});
		const tui = new TUI(term);
		// ~8000 * ~110 bytes ≈ 880 KiB — over the 512 KiB ConPTY truncate threshold.
		tui.addChild(new LargeContent(8000));

		try {
			tui.start();
			await term.waitForRender();

			// The user presses Ctrl+O; the app calls resetDisplay() to replay the
			// whole transcript at its expanded heights.
			writes.length = 0;
			tui.resetDisplay();
			await term.waitForRender();

			const resetPaint = writes.find(write => write.includes("\x1b[2J"));
			expect(resetPaint).toBeDefined();
			// The Ctrl+O replay must NOT hide the top of the session.
			expect(resetPaint).not.toContain("older lines hidden");
			expect(term.getScrollBuffer().some(line => line.includes("row 00000"))).toBe(true);
		} finally {
			tui.stop();
		}
	});

	it("still bounds the initial session-resume paint on ConPTY (issue #2115)", async () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const term = new VirtualTerminal(80, 24, 20_000);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});
		const tui = new TUI(term);
		tui.addChild(new LargeContent(8000));

		try {
			tui.start({ clearScrollback: true });
			await term.waitForRender();

			const resumePaint = writes.find(write => write.includes("\x1b[2J"));
			expect(resumePaint).toBeDefined();
			// The first paint is a resume replay — it stays bounded.
			expect(resumePaint).toContain("older lines hidden");
			expect(Buffer.byteLength(resumePaint ?? "", "utf8")).toBeLessThan(128 * 1024);
		} finally {
			tui.stop();
		}
	});
});
