// Obfuscation contract for multi-message split: renderAdvisorDeltaChunks must redact
// secrets that ACTUALLY appear in rendered advisor context — toolResult
// details.diff and custom message content — matching the old single-block path.
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

import { renderAdvisorDeltaChunks } from "../../src/advisor/delta-split";

function chunksToText(chunks: AgentMessage[] | null): string | null {
	if (!chunks) return null;
	return chunks.map(c => ((c as { content: unknown }).content as { text: string }[])[0].text).join("\n");
}

// Fake SecretObfuscator-compatible object for the pure renderer's text pass.
function makeObfuscator() {
	return {
		obfuscate: (text: string) => text.replace(/SECRETVALUE123/g, "[REDACTED]"),
	} as any;
}

describe("renderAdvisorDeltaChunks obfuscation", () => {
	it("redacts secrets in toolResult details.diff", () => {
		const msg = {
			role: "toolResult",
			toolCallId: "c1",
			content: "ok",
			details: { diff: "--- a/x\n+++ b/x\n-SECRETVALUE123\n+new" },
			timestamp: 1,
		} as unknown as AgentMessage;
		const chunks = renderAdvisorDeltaChunks([msg], {
			wip: false,
			includeThinking: true,
			obfuscator: makeObfuscator(),
			advisorRegexSecretValues: new Set(),
		});
		const text = chunksToText(chunks) ?? "";
		console.log("diff chunk:", JSON.stringify(text));
		expect(text).not.toContain("SECRETVALUE123");
		expect(text).toContain("[REDACTED]");
	});

	it("redacts secrets in user message text", () => {
		const msg = {
			role: "user",
			content: [{ type: "text", text: "prefix SECRETVALUE123 suffix" }],
			timestamp: 1,
		} as AgentMessage;
		const chunks = renderAdvisorDeltaChunks([msg], {
			wip: false,
			includeThinking: true,
			obfuscator: makeObfuscator(),
			advisorRegexSecretValues: new Set(),
		});
		const text = chunksToText(chunks) ?? "";
		console.log("user chunk:", JSON.stringify(text));
		expect(text).not.toContain("SECRETVALUE123");
		expect(text).toContain("[REDACTED]");
	});
});
