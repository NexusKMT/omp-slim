import { describe, expect, it } from "bun:test";
import { isIdleClient, sendRequest } from "@oh-my-pi/pi-coding-agent/lsp/client";
import type { LspClient } from "@oh-my-pi/pi-coding-agent/lsp/types";

const IDLE_TIMEOUT_MS = 60_000;

/**
 * Minimal in-memory LSP client. `stdin` is a sink so `sendRequest` can register
 * a pending request without a real server process; nothing ever answers, so the
 * request stays in flight until the test settles it by hand.
 */
function makeClient(): LspClient {
	return {
		name: "test-lsp",
		cwd: process.cwd(),
		config: { command: "test-lsp", fileTypes: [".ts"], rootMarkers: [] },
		proc: { stdin: { write() {}, flush: async () => {} } } as unknown as LspClient["proc"],
		requestId: 0,
		diagnostics: new Map(),
		diagnosticsVersion: 0,
		openFiles: new Map(),
		pendingRequests: new Map(),
		messageBuffer: new Uint8Array(),
		isReading: false,
		status: "ready",
		lastActivity: Date.now(),
		writeQueue: Promise.resolve(),
		activeProgressTokens: new Set(),
		projectLoaded: Promise.resolve(),
		resolveProjectLoaded: () => {},
	};
}

/**
 * Settle a pending request the way the message reader does: it removes the
 * entry from `pendingRequests` *before* invoking the stored resolver, so the
 * map drains on the reader's side, not inside the resolver.
 */
function settle(client: LspClient, id: number, outcome: { value: unknown } | { error: Error }): void {
	const entry = client.pendingRequests.get(id);
	if (!entry) throw new Error(`no pending request with id ${id}`);
	client.pendingRequests.delete(id);
	if ("error" in outcome) entry.reject(outcome.error);
	else entry.resolve(outcome.value);
}

describe("idle checker (#8390)", () => {
	it("never reports a client with an in-flight request as idle", async () => {
		const client = makeClient();
		const pending = sendRequest(client, "textDocument/hover", {}, undefined, 10 * IDLE_TIMEOUT_MS);
		// The request was *sent* long ago and is still outstanding: exactly the
		// shape that used to be torn down mid-flight.
		client.lastActivity = Date.now() - 10 * IDLE_TIMEOUT_MS;

		expect(client.pendingRequests.size).toBe(1);

		// Control: the previous checker was `now - lastActivity > timeoutMs` with
		// no in-flight check, so this exact client was reapable — the request
		// below would have been rejected with "LSP client shutdown" mid-flight.
		// Keep both assertions together so a regression that drops the guard
		// fails loudly instead of silently agreeing with the old behaviour.
		expect(Date.now() - client.lastActivity > IDLE_TIMEOUT_MS).toBe(true);
		expect(isIdleClient(client, Date.now(), IDLE_TIMEOUT_MS)).toBe(false);
		// Not even an arbitrarily distant sweep may reap it while work is in flight.
		expect(isIdleClient(client, Date.now() + 24 * 60 * 60_000, IDLE_TIMEOUT_MS)).toBe(false);

		settle(client, 1, { value: { contents: "ok" } });
		await expect(pending).resolves.toEqual({ contents: "ok" });
	});

	it("reports a quiet client as idle once the window elapses", () => {
		const client = makeClient();
		client.lastActivity = Date.now() - 10 * IDLE_TIMEOUT_MS;

		expect(client.pendingRequests.size).toBe(0);
		expect(isIdleClient(client, Date.now(), IDLE_TIMEOUT_MS)).toBe(true);
	});

	it("keeps a client below the idle window alive", () => {
		const client = makeClient();
		client.lastActivity = Date.now();

		expect(isIdleClient(client, Date.now() + IDLE_TIMEOUT_MS - 1, IDLE_TIMEOUT_MS)).toBe(false);
	});

	it("refreshes lastActivity when a request settles so a fresh answer is not reaped", async () => {
		const client = makeClient();
		const pending = sendRequest(client, "textDocument/hover", {}, undefined, 10 * IDLE_TIMEOUT_MS);
		const sentAt = Date.now() - 10 * IDLE_TIMEOUT_MS;
		client.lastActivity = sentAt;

		settle(client, 1, { value: { contents: "ok" } });
		await expect(pending).resolves.toEqual({ contents: "ok" });

		// The map has drained, so the pending-request guard no longer applies —
		// only the refreshed timestamp stands between a just-answered client and
		// the next sweep.
		expect(client.pendingRequests.size).toBe(0);
		expect(client.lastActivity).toBeGreaterThan(sentAt);
		expect(isIdleClient(client, Date.now(), IDLE_TIMEOUT_MS)).toBe(false);
		// It does become eligible again once the full window passes with no work.
		expect(isIdleClient(client, client.lastActivity + IDLE_TIMEOUT_MS + 1, IDLE_TIMEOUT_MS)).toBe(true);
	});

	it("refreshes lastActivity when a request settles with an error", async () => {
		const client = makeClient();
		const pending = sendRequest(client, "textDocument/hover", {}, undefined, 10 * IDLE_TIMEOUT_MS);
		const sentAt = Date.now() - 10 * IDLE_TIMEOUT_MS;
		client.lastActivity = sentAt;

		settle(client, 1, { error: new Error("LSP error -32601: Unknown request") });
		await expect(pending).rejects.toThrow(/-32601/);

		expect(client.pendingRequests.size).toBe(0);
		expect(client.lastActivity).toBeGreaterThan(sentAt);
		expect(isIdleClient(client, Date.now(), IDLE_TIMEOUT_MS)).toBe(false);
	});
});
