import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { RpcPromptResultFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { ONE_PIXEL_PNG as PNG, waitForFile } from "./helpers/skill-image";

function submissionOrder(messages: AgentMessage[]): string[] {
	return messages.flatMap(message => {
		if (message.role === "custom" && message.customType === "skill-prompt") return ["skill"];
		if (message.role !== "user") return [];
		const text =
			typeof message.content === "string"
				? message.content
				: message.content.map(part => (part.type === "text" ? part.text : "")).join("");
		return [text];
	});
}

let client: RpcClient;
let directory: string;

beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-skill-image-"));
	client = new RpcClient({
		command: [process.execPath, path.join(import.meta.dir, "fixtures", "skill-image-rpc-agent.ts")],
		cwd: directory,
		env: { PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1" },
	});
	await client.start();
});

afterEach(async () => {
	await client?.stop();
	await removeWithRetries(directory);
});

test("a later prompt stays behind an image skill while its current-model request runs", async () => {
	const results = new Map<string, RpcPromptResultFrame>();
	const bothSettled = Promise.withResolvers<void>();
	const unsubscribe = client.onPromptResult(frame => {
		if (frame.id) results.set(frame.id, frame);
		if (results.size === 2) bothSettled.resolve();
	});
	try {
		const skill = client.prompt("/skill:look what is this?", [{ type: "image", data: PNG, mimeType: "image/png" }]);
		// Wait for the real current-model request to start. Image preparation uses
		// local storage and must not trigger a separate vision request.
		await waitForFile(path.join(directory, "model-started"));
		await skill;
		const second = client.prompt("second", undefined, "followUp");
		// get_state runs on the serial queue after the second prompt was accepted and handed to the input gate.
		await client.getState();
		await Bun.write(path.join(directory, "model-release"), "");
		await Promise.all([skill, second]);
		await bothSettled.promise;
	} finally {
		unsubscribe();
	}
	expect([...results.values()].map(result => result.status)).toEqual(["completed", "completed"]);
	expect(submissionOrder(await client.getMessages())).toEqual(["skill", "second"]);
}, 30_000);
