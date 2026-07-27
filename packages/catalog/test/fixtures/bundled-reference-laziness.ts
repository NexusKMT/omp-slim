import { spyOn } from "bun:test";
import * as buildModule from "../../src/build";
import { ollamaCloudModelManagerOptions } from "../../src/provider-models/ollama";
import { nanoGptModelManagerOptions } from "../../src/provider-models/openai-compat";

const buildSpy = spyOn(buildModule, "buildModel");
let buildCalls = 0;
try {
	nanoGptModelManagerOptions();
	ollamaCloudModelManagerOptions();
	buildCalls = buildSpy.mock.calls.length;
} finally {
	buildSpy.mockRestore();
}

console.log(JSON.stringify({ buildCalls }));
