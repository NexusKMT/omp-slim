import { createRequire } from "node:module";
import * as os from "node:os";
import { resolveRuntimeModule } from "@oh-my-pi/pi-utils";

const SHERPA_PACKAGE = "sherpa-onnx-node";

interface SherpaOfflineResult {
	text?: string;
}

interface SherpaOfflineStream {
	acceptWaveform(audio: { samples: Float32Array; sampleRate: number }): void;
}

interface SherpaOfflineConfig {
	modelConfig: {
		transducer: { encoder: string; decoder: string; joiner: string };
		tokens: string;
		modelType: string;
		numThreads: number;
		provider: string;
		debug: number;
	};
	decodingMethod: string;
}

/** A sherpa-onnx recognizer instance used by the STT worker. */
export interface SherpaOfflineRecognizer {
	createStream(): SherpaOfflineStream;
	decodeAsync(stream: SherpaOfflineStream): Promise<SherpaOfflineResult>;
}

/** The native sherpa-onnx module surface used by the STT worker. */
export interface SherpaRuntime {
	OfflineRecognizer: {
		createAsync(config: SherpaOfflineConfig): Promise<SherpaOfflineRecognizer>;
	};
}

function getPlatformPackage(): string {
	const platform = os.platform() === "win32" ? "win" : os.platform();
	return `sherpa-onnx-${platform}-${os.arch()}`;
}

/** Loads the source-workspace sherpa wrapper colocated with its native platform package. */
export function loadSourceSherpaRuntime(sourceUrl: string): SherpaRuntime {
	const sourceRequire = createRequire(sourceUrl);
	const platformPackage = getPlatformPackage();
	for (const nodeModules of sourceRequire.resolve.paths(SHERPA_PACKAGE) ?? []) {
		if (!resolveRuntimeModule(nodeModules, platformPackage)) continue;
		const entry = resolveRuntimeModule(nodeModules, SHERPA_PACKAGE);
		if (entry) return createRequire(entry)(entry);
	}
	return sourceRequire(SHERPA_PACKAGE);
}
