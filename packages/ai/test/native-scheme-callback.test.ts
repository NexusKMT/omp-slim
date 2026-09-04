import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createNativeSchemeCallbackReceiver,
	type NativeSchemeCommandRunner,
} from "@oh-my-pi/pi-ai/registry/oauth/native-scheme-callback";

interface FakeLaunchServices {
	callbackPath?: string;
	handler: string;
	handlerChanges: string[];
}

function fakeRunner(state: FakeLaunchServices): NativeSchemeCommandRunner {
	return async (command, args) => {
		if (command === "/usr/bin/osascript") {
			if (args.length === 6) {
				const handler = args.at(-1) ?? "none";
				state.handler = handler;
				state.handlerChanges.push(handler);
				return { exitCode: 0, stdout: "0", stderr: "" };
			}
			return { exitCode: 0, stdout: state.handler, stderr: "" };
		}
		if (command === "/usr/bin/osacompile") {
			const outputLine = args.find(arg => arg.startsWith("set outputFile to POSIX file "));
			const callbackPath = outputLine?.match(/POSIX file "([^"]+)"$/u)?.[1];
			if (!callbackPath) return { exitCode: 1, stdout: "", stderr: "callback path missing" };
			state.callbackPath = callbackPath;
		}
		return { exitCode: 0, stdout: "", stderr: "" };
	};
}

const homes: string[] = [];

afterEach(async () => {
	await Promise.all(homes.splice(0).map(home => fs.rm(home, { recursive: true, force: true })));
});

describe("native custom-scheme OAuth callbacks", () => {
	it("captures a macOS URL event and restores the previous scheme handler", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-callback-test-"));
		homes.push(home);
		const state: FakeLaunchServices = {
			handler: "com.zhipuai.code",
			handlerChanges: [],
		};
		const receiver = await createNativeSchemeCallbackReceiver("zcode", {
			env: { HOME: home },
			platform: "darwin",
			runCommand: fakeRunner(state),
		});
		if (!receiver || !state.callbackPath) throw new Error("native callback receiver was not created");
		const callbackUrl = "zcode://zai-auth/callback?code=authorization-code&state=expected-state";

		await Bun.write(state.callbackPath, callbackUrl);
		expect(await receiver.waitForCallback()).toBe(callbackUrl);
		expect(state.handler).toStartWith("dev.omp.oauth-callback.");

		await receiver.dispose();

		expect(state.handler).toBe("com.zhipuai.code");
		expect(state.handlerChanges).toHaveLength(2);
		expect(await Bun.file(path.join(home, ".omp", "oauth", "darwin-url-callback.json")).exists()).toBe(false);
	});

	it("leaves non-macOS callers on the manual callback path", async () => {
		const calls: string[] = [];
		const receiver = await createNativeSchemeCallbackReceiver("zcode", {
			platform: "linux",
			runCommand: async command => {
				calls.push(command);
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		});

		expect(receiver).toBeUndefined();
		expect(calls).toEqual([]);
	});
});
