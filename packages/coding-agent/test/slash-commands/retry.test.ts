import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	ACP_BUILTIN_SLASH_COMMANDS,
	executeAcpBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

function createRuntime(didRetry: boolean) {
	const retry = vi.fn(async () => didRetry);
	const showStatus = vi.fn();
	const setText = vi.fn();
	return {
		retry,
		showStatus,
		setText,
		runtime: {
			ctx: {
				session: { retry } as unknown as InteractiveModeContext["session"],
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				showStatus,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/retry slash command", () => {
	it("clears the editor after starting a retry", async () => {
		const harness = createRuntime(true);

		const handled = await executeBuiltinSlashCommand("/retry", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.retry).toHaveBeenCalledTimes(1);
		expect(harness.showStatus).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("reports when there is no failed turn to retry", async () => {
		const harness = createRuntime(false);

		const handled = await executeBuiltinSlashCommand("/retry", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.retry).toHaveBeenCalledTimes(1);
		expect(harness.showStatus).toHaveBeenCalledWith("Nothing to retry");
		expect(harness.setText).toHaveBeenCalledWith("");
	});
});

function acpRuntime({ isStreaming = false, retryResult = false }: { isStreaming?: boolean; retryResult?: boolean }) {
	const retry = vi.fn(async () => retryResult);
	const waitForIdle = vi.fn(async () => {});
	const output = vi.fn();
	const runtime = {
		session: { isStreaming, retry, waitForIdle },
		output,
	} as unknown as SlashCommandRuntime;
	return { retry, waitForIdle, output, runtime };
}

describe("/retry dispatch (ACP)", () => {
	it("refuses to retry while streaming", async () => {
		const h = acpRuntime({ isStreaming: true });
		const result = await executeAcpBuiltinSlashCommand("/retry", h.runtime);
		expect(h.retry).not.toHaveBeenCalled();
		expect(result).toEqual({ consumed: true });
		expect((h.output.mock.calls[0]?.[0] as string) ?? "").toContain("before retrying");
	});

	it("reports when there is nothing to retry", async () => {
		const h = acpRuntime({ retryResult: false });
		const result = await executeAcpBuiltinSlashCommand("/retry", h.runtime);
		expect(h.output).toHaveBeenCalledWith("Nothing to retry.");
		expect(h.waitForIdle).not.toHaveBeenCalled();
		expect(result).toEqual({ consumed: true });
	});

	it("announces the retry and waits for the retried turn to settle", async () => {
		const h = acpRuntime({ retryResult: true });
		const result = await executeAcpBuiltinSlashCommand("/retry", h.runtime);
		expect(h.output.mock.calls[0]?.[0]).toBe("Retrying the last failed turn.");
		expect(h.waitForIdle).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ consumed: true });
	});

	it("is advertised to ACP clients", () => {
		expect(ACP_BUILTIN_SLASH_COMMANDS.find(c => c.name === "retry")).toBeDefined();
	});
});
