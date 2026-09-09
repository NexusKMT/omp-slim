import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SessionSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/session-selector";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";

beforeAll(async () => {
	await initTheme();
});

afterAll(async () => {
	await initTheme();
});

function createSession(id: string, title: string, modified: string): SessionInfo {
	return {
		path: `/work/${id}.jsonl`,
		id,
		cwd: "/work",
		title,
		created: new Date("2024-01-01T00:00:00Z"),
		modified: new Date(modified),
		messageCount: 1,
		size: 2048,
		firstMessage: `first message ${id}`,
		allMessagesText: `first message ${id}`,
	};
}

function renderPlain(sessions: SessionInfo[], currentSessionPath?: string): string {
	const selector = new SessionSelectorComponent(
		sessions,
		() => {},
		() => {},
		() => {},
		{
			getTerminalRows: () => 100,
			currentSessionPath,
		},
	);
	return stripAnsi(selector.render(120).join("\n"));
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function sessionSection(rendered: string, title: string): string {
	const lines = rendered.split("\n");
	const idx = lines.findIndex(line => line.includes(title));
	expect(idx).toBeGreaterThan(-1);
	return lines.slice(idx, idx + 4).join("\n");
}

describe("SessionSelectorComponent current session marker", () => {
	const newer = createSession("newer", "Newer session", "2024-01-03T00:00:00Z");
	const older = createSession("older", "Older session", "2024-01-02T00:00:00Z");

	it("renders no current marker when the live session path is not provided", () => {
		const rendered = renderPlain([newer, older]);
		expect(sessionSection(rendered, "Newer session")).not.toContain("current");
		expect(sessionSection(rendered, "Older session")).not.toContain("current");
	});

	it("labels only the live session current on the metadata line", () => {
		const rendered = renderPlain([newer, older], older.path);
		expect(sessionSection(rendered, "Older session")).toContain("current");
		expect(sessionSection(rendered, "Newer session")).not.toContain("current");
	});

	it("focuses the live session even when it is not the most recent row", () => {
		const rendered = renderPlain([newer, older], older.path);
		const cursor = theme.nav.cursor;
		expect(sessionSection(rendered, "Older session")).toContain(`${cursor} Older session`);
		expect(sessionSection(rendered, "Newer session")).not.toContain(`${cursor} Newer session`);
	});

	it("resets focus to the top search match when the live session is excluded", () => {
		const work = createSession("work", "Alpha work", "2024-01-03T00:00:00Z");
		const live = createSession("live", "Beta live", "2024-01-02T00:00:00Z");
		const other = createSession("other", "Alpha other", "2024-01-01T00:00:00Z");
		const selector = new SessionSelectorComponent(
			[work, live, other],
			() => {},
			() => {},
			() => {},
			{
				getTerminalRows: () => 100,
				currentSessionPath: live.path,
			},
		);
		for (const ch of "alpha") selector.handleInput(ch);
		const rendered = stripAnsi(selector.render(120).join("\n"));
		const cursor = theme.nav.cursor;
		expect(sessionSection(rendered, "Alpha work")).toContain(`${cursor} Alpha work`);
		expect(sessionSection(rendered, "Alpha other")).not.toContain(`${cursor} Alpha other`);
	});
});
