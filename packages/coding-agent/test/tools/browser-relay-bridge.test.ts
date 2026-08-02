import { describe, expect, it } from "bun:test";
import { RelayBridge, type RelaySocket } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/bridge";
import type { RelayToExtMessage, TabSnapshot } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";

class FakeExtSocket implements RelaySocket {
	readonly messages: RelayToExtMessage[] = [];
	send(text: string): void {
		this.messages.push(JSON.parse(text) as RelayToExtMessage);
	}
	close(): void {}
	rpcs(op: string): Array<Extract<RelayToExtMessage, { t: "rpc" }>> {
		return this.messages.filter(
			(msg): msg is Extract<RelayToExtMessage, { t: "rpc" }> => msg.t === "rpc" && msg.op === op,
		);
	}
}

function tab(overrides: Partial<TabSnapshot> & { tabId: number }): TabSnapshot {
	return {
		url: "https://example.com/",
		title: "Example",
		active: false,
		windowId: 1,
		pinned: false,
		groupId: -1,
		...overrides,
	};
}

function connect(bridge: RelayBridge, socket: FakeExtSocket, tabs: TabSnapshot[]): void {
	bridge.extConnected(socket);
	bridge.extMessage(
		socket,
		JSON.stringify({
			t: "hello",
			userAgent: "test",
			browserVersion: "Chrome/151.0.0.0",
			tabs,
			attachedTabIds: [],
		}),
	);
}

describe("RelayBridge tab grouping", () => {
	it("groups only controllable, unpinned, ungrouped tabs on hello", () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const socket = new FakeExtSocket();
		connect(bridge, socket, [
			tab({ tabId: 1 }),
			tab({ tabId: 2, url: "chrome://settings/" }),
			tab({ tabId: 3, pinned: true }),
			tab({ tabId: 4, groupId: 77 }), // already in a user group
			tab({ tabId: 5, url: "about:blank" }),
		]);
		const groups = socket.rpcs("group");
		expect(groups).toHaveLength(1);
		const group = groups[0]! as { tabIds: number[]; title: string; color: string };
		expect(group.tabIds.toSorted()).toEqual([1, 5]);
		expect(group.title).toBe("omp");
		expect(group.color).toBe("cyan");
	});

	it("does not issue group RPCs when grouping is disabled", () => {
		const bridge = new RelayBridge({});
		const socket = new FakeExtSocket();
		connect(bridge, socket, [tab({ tabId: 1 })]);
		expect(socket.rpcs("group")).toHaveLength(0);
	});

	it("never re-groups a tab the user pulled out of the omp group", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const socket = new FakeExtSocket();
		connect(bridge, socket, [tab({ tabId: 1 })]);
		const first = socket.rpcs("group")[0]!;
		bridge.extMessage(
			socket,
			JSON.stringify({ t: "rpcResult", id: first.id, ok: true, result: { grouped: { "1": 42 } } }),
		);
		// Flush the rpc .then() microtask chain (no timers involved).
		await Promise.resolve();
		await Promise.resolve();
		// Chrome reports the grouping we just made — no opt-out.
		bridge.extMessage(socket, JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 1, groupId: 42 }) }));
		// The user drags the tab out of the group.
		bridge.extMessage(socket, JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 1, groupId: -1 }) }));
		// A later navigation on the now-ungrouped tab must not re-group it.
		bridge.extMessage(
			socket,
			JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 1, groupId: -1, url: "https://example.com/other" }) }),
		);
		expect(socket.rpcs("group")).toHaveLength(1);
	});

	it("groups a newly created controllable tab", () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const socket = new FakeExtSocket();
		connect(bridge, socket, []);
		bridge.extMessage(socket, JSON.stringify({ t: "tabCreated", tab: tab({ tabId: 9 }) }));
		const groups = socket.rpcs("group");
		expect(groups).toHaveLength(1);
		expect((groups[0] as unknown as { tabIds: number[] }).tabIds).toEqual([9]);
	});
});
