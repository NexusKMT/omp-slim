/**
 * `bun run gen:rpc`: regenerates every artifact derived from the RPC wire schema.
 *
 * Outputs (all committed; `test/rpc-wire/generated.test.ts` fails when stale):
 * - `src/modes/rpc/wire/rpc-wire.schema.json`: the language-neutral bundle
 * - `src/modes/rpc/wire/rpc-wire.generated.ts`: TypeScript wire types
 */
import * as path from "node:path";
import { buildRpcWireBundle } from "../../src/modes/rpc/wire";
import { buildWireModel } from "./model";
import { emitTypeScript } from "./typescript";

const PACKAGE_DIR = path.resolve(import.meta.dir, "../..");
const WIRE_DIR = path.join(PACKAGE_DIR, "src/modes/rpc/wire");

/** Generated file path → contents. */
export function generateRpcArtifacts(): Map<string, string> {
	const bundle = buildRpcWireBundle();
	const model = buildWireModel(bundle);
	return new Map([
		[path.join(WIRE_DIR, "rpc-wire.schema.json"), `${JSON.stringify(bundle, null, "\t")}\n`],
		[path.join(WIRE_DIR, "rpc-wire.generated.ts"), emitTypeScript(model)],
	]);
}

if (import.meta.main) {
	for (const [file, contents] of generateRpcArtifacts()) {
		await Bun.write(file, contents);
		console.log(`wrote ${path.relative(process.cwd(), file)}`);
	}
}
