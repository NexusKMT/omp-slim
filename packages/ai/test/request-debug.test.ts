import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { stream, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { AssistantMessage, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { createRequestDebugSession } from "@oh-my-pi/pi-ai/utils/request-debug";
import { transportFetch } from "@oh-my-pi/pi-ai/utils/transport-fetch";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { removeWithRetries } from "../../utils/src/temp";

const enc = new TextEncoder();

let previousDebugFlag: string | undefined;
let previousCwd: string;
let tempDir: string | undefined;

beforeEach(async () => {
	previousDebugFlag = Bun.env.PI_REQ_DEBUG;
	previousCwd = process.cwd();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-req-debug-"));
	process.chdir(tempDir);
});

afterEach(async () => {
	process.chdir(previousCwd);
	if (previousDebugFlag === undefined) delete Bun.env.PI_REQ_DEBUG;
	else Bun.env.PI_REQ_DEBUG = previousDebugFlag;
	if (tempDir) await removeWithRetries(tempDir);
	tempDir = undefined;
});

function chunkedResponse(chunks: Uint8Array[]): Response {
	let index = 0;
	return new Response(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				if (index >= chunks.length) {
					controller.close();
					return;
				}
				controller.enqueue(chunks[index++]!);
			},
		}),
		{ status: 201, statusText: "Created", headers: { "x-request-id": "resp-1", "content-type": "text/plain" } },
	);
}

function splitResponseLog(bytes: Uint8Array): { headers: string; body: Uint8Array } {
	const separator = enc.encode("\r\n\r\n");
	let separatorIndex = -1;
	for (let i = 0; i <= bytes.length - separator.length; i++) {
		let matched = true;
		for (let j = 0; j < separator.length; j++) {
			if (bytes[i + j] !== separator[j]) {
				matched = false;
				break;
			}
		}
		if (matched) {
			separatorIndex = i;
			break;
		}
	}
	expect(separatorIndex).toBeGreaterThanOrEqual(0);
	return {
		headers: new TextDecoder().decode(bytes.subarray(0, separatorIndex)),
		body: bytes.subarray(separatorIndex + separator.length),
	};
}

/** Find the latest rr-session-*.json written to the temp dir by PI_REQ_DEBUG
 * and derive its matching .res.log (rr-session-N.res.log, not .json.res.log). */
async function findDebugFiles(): Promise<{ requestPath: string; responsePath: string }> {
	const entries = await fs.readdir(tempDir!);
	const jsonFiles = entries.filter(f => /^rr-session-\d+\.json$/.test(f));
	expect(jsonFiles.length).toBeGreaterThan(0);
	jsonFiles.sort((a, b) => {
		const na = Number(a.match(/\d+/)![0]);
		const nb = Number(b.match(/\d+/)![0]);
		return na - nb;
	});
	const latest = jsonFiles[jsonFiles.length - 1]!;
	const id = latest.match(/\d+/)![0];
	return {
		requestPath: path.join(tempDir!, latest),
		responsePath: path.join(tempDir!, `rr-session-${id}.res.log`),
	};
}

describe("PI_REQ_DEBUG request/response recording", () => {
	it("redacts credential headers given as a record, as socket transports pass them", async () => {
		const session = await createRequestDebugSession({
			protocol: "websocket",
			method: "POST",
			url: "wss://provider.test/v1/responses",
			headers: { Authorization: "Bearer request-secret", "OpenAI-Beta": "responses=v1" },
		});
		const log = await session.openResponseLog("WebSocket 101 Switching Protocols", {
			"Set-Cookie": ["a=cookie-secret", "b=cookie-secret"],
			"x-request-id": "resp-3",
		});
		await log.close();

		const dump = (await fs.readFile(session.requestPath, "utf8")) + (await fs.readFile(session.responsePath, "utf8"));
		expect(dump).not.toContain("request-secret");
		expect(dump).not.toContain("cookie-secret");
		expect(JSON.parse(await fs.readFile(session.requestPath, "utf8")).headers).toEqual({
			Authorization: "[redacted]",
			"OpenAI-Beta": "responses=v1",
		});
		expect(splitResponseLog(await fs.readFile(session.responsePath)).headers).toContain("Set-Cookie: [redacted]");
	});
});
