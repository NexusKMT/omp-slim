import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { RpcPromptResultFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

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

/** Resolve with `file`'s text once it is non-empty, driven by directory change events rather than a polling timer. */
async function waitForFileText(file: string): Promise<string> {
	const read = async () => ((await Bun.file(file).exists()) ? await Bun.file(file).text() : "");
	const controller = new AbortController();
	const events = fs.watch(path.dirname(file), { signal: controller.signal });
	try {
		let text = await read();
		if (text) return text;
		for await (const _ of events) {
			text = await read();
			if (text) return text;
		}
		throw new Error(`watch on ${file} ended before it was written`);
	} finally {
		controller.abort();
	}
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

test("a later prompt does not overtake an idle image skill while its image is described", async () => {
	const results = new Map<string, RpcPromptResultFrame>();
	const bothSettled = Promise.withResolvers<void>();
	const unsubscribe = client.onPromptResult(frame => {
		if (frame.id) results.set(frame.id, frame);
		if (results.size === 2) bothSettled.resolve();
	});
	try {
		const skill = client.prompt("/skill:look what is this?", [{ type: "image", data: PNG, mimeType: "image/png" }]);
		const fixturePid = Number(await waitForFileText(path.join(directory, "vision-started")));
		const second = client.prompt("second", undefined, "followUp");
		// get_state runs on the serial queue after the second prompt was accepted and handed to the input gate.
		await client.getState();
		process.kill(fixturePid, "SIGUSR1");
		await Promise.all([skill, second]);
		await bothSettled.promise;
	} finally {
		unsubscribe();
	}
	expect([...results.values()].map(result => result.status)).toEqual(["completed", "completed"]);
	expect(submissionOrder(await client.getMessages())).toEqual(["skill", "second"]);
}, 30_000);
