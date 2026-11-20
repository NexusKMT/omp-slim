#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { createJsonParsePlugin } from "./json-parse-plugin";
import { createLegacyPiVirtualModulePlugin } from "./legacy-pi-virtual-module";

const packageDir = path.join(import.meta.dir, "..");
const defaultOutDir = path.join(packageDir, "dist");
const shebang = "#!/usr/bin/env bun\n";
// Remove old inline-viewer sidecars left in an existing output directory.
const obsoleteHtmlExportAssetPattern =
	/^(?:template-[^.]+\.(?:css|html|js)|tool-views\.generated-[^.]+\.js|(?:marked|highlight)\.min-[^.]+\.js)$/;

// Native/platform dependencies and on-demand model runtimes stay outside the bundle.
const ALWAYS_EXTERNAL = ["@oh-my-pi/pi-natives", "@huggingface/transformers", "fastembed", "onnxruntime-node"];

/**
 * Embeds `@oh-my-pi/pi-natives/THIRD-PARTY-NOTICES.txt` even though the natives package is external. An external
 * text import would be hoisted to a top-level import of `dist/cli.js`, reading the installed addon's notices on every
 * launch instead of only for `omp --license`.
 */
const inlineNativeNoticesPlugin: Bun.BunPlugin = {
	name: "inline-native-notices",
	setup(build) {
		build.onResolve({ filter: /^@oh-my-pi\/pi-natives\/THIRD-PARTY-NOTICES\.txt$/ }, () => ({
			path: path.join(packageDir, "../natives/THIRD-PARTY-NOTICES.txt"),
		}));
	},
};

// Heavy, lazily-used third-party leaf deps. Each is a declared `dependency`, so the
// published package resolves it from node_modules at runtime; bundling only embeds a
// redundant copy that bloats dist/cli.js. NEVER add a patched dependency here — the
// bundle is where a root `patchedDependencies` patch is baked in, so an externalized
// import would load the unpatched npm package in users' installs (currently
// @ark/schema is patched, so it — and arktype, which pulls @ark/schema — stay
// bundled).
const RUNTIME_EXTERNAL = ["@babel/parser"];

async function ensureShebang(cliPath: string): Promise<void> {
	const text = await Bun.file(cliPath).text();
	if (text.startsWith(shebang)) return;
	const withoutExisting = text.startsWith("#!") ? text.slice(text.indexOf("\n") + 1) : text;
	await Bun.write(cliPath, shebang + withoutExisting);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

async function cleanBundleOutputs(outDir: string): Promise<void> {
	// dist/ is shared with the dev binary (dist/omp); only remove assets
	// emitted by this script.
	let entries: string[];
	try {
		entries = await fs.readdir(outDir);
	} catch (err) {
		if (isEnoent(err)) return;
		throw err;
	}
	await Promise.all(
		entries
			.filter(
				entry =>
					entry === "cli.js" ||
					entry === "export-viewer.generated.txt" ||
					entry.endsWith(".node") ||
					entry.endsWith(".js.map") ||
					/\.json-[^/]+\.zst$/.test(entry) ||
					(entry.startsWith("CHANGELOG-") && entry.endsWith(".md")) ||
					obsoleteHtmlExportAssetPattern.test(entry),
			)
			.map(entry => fs.rm(path.join(outDir, entry), { force: true })),
	);
}

/** Builds the npm CLI bundle into `outDir`; release scripts use the package `dist` directory by default. */
export async function bundleDist(outDir: string = defaultOutDir): Promise<void> {
	const cliPath = path.join(outDir, "cli.js");
	const start = Bun.nanoseconds();
	await cleanBundleOutputs(outDir);
	// Build in-process.
	const output = await Bun.build({
		entrypoints: [path.join(packageDir, "src/cli.ts")],
		outdir: outDir,
		target: "bun",
		plugins: [createJsonParsePlugin(), await createLegacyPiVirtualModulePlugin(), inlineNativeNoticesPlugin],
		external: [...ALWAYS_EXTERNAL, ...RUNTIME_EXTERNAL],
		define: {
			"process.env.PI_BUNDLED": JSON.stringify("true"),
		},
		minify: {
			whitespace: true,
			syntax: true,
			identifiers: true,
			keepNames: true,
		},
		throw: false,
	});
	if (!output.success) {
		throw new Error(`CLI bundle failed:\n${output.logs.map(log => log.message).join("\n")}`);
	}
	await ensureShebang(cliPath);
	const stat = await fs.stat(cliPath);
	const elapsedMs = (Bun.nanoseconds() - start) / 1_000_000;
	process.stdout.write(
		`Bundled coding-agent CLI to ${cliPath} (${formatBytes(stat.size)}) in ${elapsedMs.toFixed(0)}ms\n`,
	);
}

if (import.meta.main) await bundleDist();
