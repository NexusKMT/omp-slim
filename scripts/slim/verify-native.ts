#!/usr/bin/env bun

import { createRequire } from "node:module";
import * as path from "node:path";

const requireAddon = createRequire(import.meta.url);
const nativeDir = path.resolve(import.meta.dir, "../../packages/natives/native");
const addons = [
	...new Bun.Glob(`pi_natives.${process.platform}-${process.arch}*.node`).scanSync({
		cwd: nativeDir,
		absolute: true,
	}),
];
if (addons.length === 0) throw new Error(`No compiled addon for ${process.platform}-${process.arch}`);

const retired =
	/^(?:AudioCapture|AudioPlayback|LiveWebRtcPeer|Desktop.*|MacOSFrontApp|cosineSimilarityPairs|mmrRerankIndices|vectorIndexTopK)$/;
const retained = [
	"executeShell",
	"copyToClipboard",
	"readImageFromClipboard",
	"readTextFromClipboard",
	"pdfToMarkdown",
];

for (const addon of addons) {
	const bindings = requireAddon(addon) as Record<string, unknown>;
	const remaining = Object.keys(bindings).filter(name => retired.test(name));
	if (remaining.length > 0) throw new Error(`${path.basename(addon)} still exports: ${remaining.join(", ")}`);
	for (const name of retained) {
		if (typeof bindings[name] !== "function") throw new Error(`${path.basename(addon)} is missing ${name}`);
	}
	console.log(`${path.basename(addon)}: retired desktop/audio/vector exports absent; core exports present`);
}
