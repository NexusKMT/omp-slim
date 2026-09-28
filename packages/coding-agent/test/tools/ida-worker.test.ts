import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { $which, TempDir } from "@oh-my-pi/pi-utils";

const pythonPath = Bun.env.PYTHON ?? ($which("python3") ? "python3" : "python");
const workerPath = path.resolve(import.meta.dir, "../../src/ida/worker.py");

/** Empty stand-ins for the idalib modules `worker.py` imports; only module-level references need bodies. */
const STUBS: Record<string, string> = {
	"ida_domain/__init__.py": "class Database: pass\n",
	"ida_domain/database.py": "class IdaCommandOptions: pass\n",
	"ida_domain/xrefs.py": "class XrefType: pass\n",
	"ida_idp.py": "class IDB_Hooks:\n    def __init__(self, *a, **k): pass\n",
	"ida_hexrays.py": "class Hexrays_Hooks:\n    def __init__(self, *a, **k): pass\n",
};
for (const name of [
	"idapro",
	"ida_auto",
	"ida_bytes",
	"ida_funcs",
	"ida_idaapi",
	"ida_lines",
	"ida_loader",
	"ida_nalt",
	"ida_name",
	"ida_segment",
	"ida_typeinf",
	"ida_ua",
	"ida_xref",
	"idautils",
]) {
	STUBS[`${name}.py`] = "";
}

// `nomask` reproduces CPython on Windows, which has no `signal.pthread_sigmask`.
const LAUNCHER = `import runpy, signal, sys
if sys.argv[1] == "nomask" and hasattr(signal, "pthread_sigmask"):
    del signal.pthread_sigmask
runpy.run_path(sys.argv[2], run_name="__main__")
`;

describe("IDA worker protocol frames", () => {
	for (const mode of ["mask", "nomask"] as const) {
		it(`answers requests and closes cleanly (${mode === "mask" ? "POSIX signal masks" : "no signal masks, as on Windows"})`, async () => {
			using stubs = TempDir.createSync("@ida-worker-stubs-");
			await Promise.all(Object.entries(STUBS).map(([file, body]) => Bun.write(path.join(stubs.path(), file), body)));
			const requests = [
				{ id: 1, method: "nope", params: {} },
				{ id: 2, method: "close", params: { save: false } },
			];
			const proc = Bun.spawn([pythonPath, "-c", LAUNCHER, mode, workerPath], {
				stdin: new Response(requests.map(r => `${JSON.stringify(r)}\n`).join("")),
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, PYTHONPATH: stubs.path(), PYTHONIOENCODING: "utf-8" },
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);

			expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
			expect(
				stdout
					.trimEnd()
					.split("\n")
					.map(line => JSON.parse(line)),
			).toEqual([
				{ id: 1, ok: false, error: { type: "ValueError", message: "unknown method: nope" } },
				{ id: 2, ok: true, result: { closed: true, saved: false } },
			]);
		});
	}
});
