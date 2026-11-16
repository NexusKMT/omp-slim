import * as fs from "node:fs";
import * as path from "node:path";

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Write a stub executable `name` into `dir` that runs the JavaScript `source`
 * under the current Bun binary, forwarding every argument (`process.argv[2]`
 * is the first one). Returns the path to invoke.
 *
 * The launcher is an `exec` shell script, so signals reach the script itself.
 */
export function writeFakeExecutable(dir: string, name: string, source: string): string {
	const script = path.join(dir, `${name}.fake.js`);
	fs.writeFileSync(script, source);
	const launcher = path.join(dir, name);
	fs.writeFileSync(launcher, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`);
	fs.chmodSync(launcher, 0o755);
	return launcher;
}
