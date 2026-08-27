import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

interface RunningJob {
	id: string;
	type: "bash" | "task";
	status: "running";
	label: string;
	startTime: number;
}

let settingsState: SettingsTestState | undefined;

beforeEach(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterEach(() => {
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
});

function runningJob(type: RunningJob["type"], index: number): RunningJob {
	return {
		id: `${type}-${index}`,
		type,
		status: "running",
		label: `${type} ${index}`,
		startTime: index,
	};
}

function makeComponent(running: RunningJob[]): StatusLineComponent {
	const messages: unknown[] = [];
	const model = { id: "test-model", name: "Test Model", contextWindow: 100_000 };
	const session = {
		state: { messages, model },
		messages,
		model,
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		isAdvisorActive: () => false,
		getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
		getAsyncJobSnapshot: () => ({ running }),
		settings: { get: () => false },
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getSessionName: () => undefined,
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
		getContextUsage: () => undefined,
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
	const component = new StatusLineComponent(session);
	component.updateSettings({
		preset: "custom",
		leftSegments: [],
		rightSegments: [],
		separator: "none",
		transparent: true,
	});
	return component;
}

describe("status-line background-job badge", () => {
	it("excludes task subagents and shows only running bash jobs", () => {
		const subagentCount = 3;
		const running = Array.from({ length: subagentCount }, (_, index) => runningJob("task", index));
		const component = makeComponent(running);
		component.setSubagentCount(subagentCount);

		const taskOnly = stripVTControlCharacters(component.getTopBorder(120).content);
		expect(taskOnly).toContain(`${theme.icon.agents} ${subagentCount} agents`);
		expect(taskOnly).not.toContain(theme.icon.job);

		running.push(runningJob("bash", subagentCount));
		const withBash = stripVTControlCharacters(component.getTopBorder(120).content);
		expect(withBash).toContain(`${theme.icon.agents} ${subagentCount} agents`);
		expect(withBash).toContain(`${theme.icon.job} 1`);
	});
});
