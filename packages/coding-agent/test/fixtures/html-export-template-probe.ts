import { createHash } from "node:crypto";
import { getTemplate } from "../../src/export/html/index";

const first = getTemplate();
const repeated = getTemplate();

process.stdout.write(
	JSON.stringify({
		chars: first.length,
		bytes: Buffer.byteLength(first),
		sha256: createHash("sha256").update(first).digest("hex"),
		stableCache: repeated === first,
	}),
);
