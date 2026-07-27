import { ollamaCloudModelManagerOptions } from "../../src/provider-models/ollama";
import { nanoGptModelManagerOptions } from "../../src/provider-models/openai-compat";

const originalSet = Map.prototype.set;
let mapWrites = 0;
Map.prototype.set = function (key, value) {
	mapWrites++;
	return originalSet.call(this, key, value);
};

try {
	nanoGptModelManagerOptions();
	ollamaCloudModelManagerOptions();
} finally {
	Map.prototype.set = originalSet;
}

console.log(JSON.stringify({ mapWrites }));
