import { describe, expect, it, vi } from "bun:test";
import {
	ACP_BUILTIN_SLASH_COMMANDS,
	executeAcpBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

function acpRuntime({
	isStreaming = false,
	isGeneratingHandoff = false,
	handoffResult,
	handoffError,
}: {
	isStreaming?: boolean;
	isGeneratingHandoff?: boolean;
	handoffResult?: unknown;
	handoffError?: Error;
}) {
	const handoff = vi.fn(async () => {
		if (handoffError) throw handoffError;
		return handoffResult;
	});
	const output = vi.fn();
	const runtime = {
		session: { isStreaming, isGeneratingHandoff, handoff },
		output,
	} as unknown as SlashCommandRuntime;
	return { handoff, output, runtime };
}

describe("/handoff dispatch (ACP)", () => {
	it("refuses to hand off while streaming", async () => {
		const h = acpRuntime({ isStreaming: true });
		await executeAcpBuiltinSlashCommand("/handoff", h.runtime);
		expect(h.handoff).not.toHaveBeenCalled();
		expect((h.output.mock.calls[0]?.[0] as string) ?? "").toContain("before handing off");
	});

	it("refuses to hand off while a handoff is already generating", async () => {
		const h = acpRuntime({ isGeneratingHandoff: true });
		await executeAcpBuiltinSlashCommand("/handoff", h.runtime);
		expect(h.handoff).not.toHaveBeenCalled();
		expect(h.output).toHaveBeenCalledWith("Handoff generation is already in progress.");
	});

	it("passes focus instructions through, undefined when bare", async () => {
		const h1 = acpRuntime({ handoffResult: { document: "doc" } });
		await executeAcpBuiltinSlashCommand("/handoff focus on auth", h1.runtime);
		expect(h1.handoff).toHaveBeenCalledWith("focus on auth");

		const h2 = acpRuntime({ handoffResult: { document: "doc" } });
		await executeAcpBuiltinSlashCommand("/handoff", h2.runtime);
		expect(h2.handoff).toHaveBeenCalledWith(undefined);
	});

	it("reports success with no saved path as a single line", async () => {
		const h = acpRuntime({ handoffResult: { document: "doc" } });
		await executeAcpBuiltinSlashCommand("/handoff", h.runtime);
		expect(h.output).toHaveBeenCalledWith("Context handed off and compacted in place.");
	});

	it("includes the saved path when present, in one output call", async () => {
		const h = acpRuntime({ handoffResult: { document: "doc", savedPath: "/tmp/handoff.md" } });
		await executeAcpBuiltinSlashCommand("/handoff", h.runtime);
		expect(h.output).toHaveBeenCalledTimes(1);
		const text = h.output.mock.calls[0]?.[0] as string;
		expect(text).toContain("Context handed off and compacted in place.");
		expect(text).toContain("Handoff document saved to: /tmp/handoff.md");
	});

	it("reports cancellation when the handoff resolves undefined", async () => {
		const h = acpRuntime({ handoffResult: undefined });
		await executeAcpBuiltinSlashCommand("/handoff", h.runtime);
		expect(h.output).toHaveBeenCalledWith("Handoff cancelled.");
	});

	it("reports cancellation without the failed prefix when the handoff throws cancellation", async () => {
		const h = acpRuntime({ handoffError: new Error("Handoff cancelled") });
		await executeAcpBuiltinSlashCommand("/handoff", h.runtime);
		expect(h.output).toHaveBeenCalledWith("Handoff cancelled.");
	});

	it("surfaces other failures behind the Handoff failed prefix", async () => {
		const h = acpRuntime({ handoffError: new Error("Nothing to hand off (no messages yet)") });
		await executeAcpBuiltinSlashCommand("/handoff", h.runtime);
		expect(h.output).toHaveBeenCalledWith("Handoff failed: Nothing to hand off (no messages yet)");
	});

	it("is advertised with the focus hint and the ACP description", () => {
		const advertised = ACP_BUILTIN_SLASH_COMMANDS.find(c => c.name === "handoff");
		expect(advertised?.input?.hint).toBe("[focus instructions]");
		expect(advertised?.description).toBe("Summarize the session into a handoff document and compact in place");
	});
});
