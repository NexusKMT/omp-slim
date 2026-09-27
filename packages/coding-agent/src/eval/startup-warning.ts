import type { Settings } from "../config/settings";
import { checkPythonKernelAvailability } from "./py/kernel";
import { cfgEvalJs, cfgEvalPy, cfgPythonInterpreter } from "./settings";

const PYTHON_FIX_HINT = "Install Python 3.8+ or set python.interpreter, then verify with `omp setup python --check`.";

/**
 * Warning for an enabled Python eval backend with no working interpreter.
 * Disabled backends (`eval.py` / `eval.js`, `PI_PY` / `PI_JS`) are intentional and never reported.
 */
export async function resolvePythonEvalWarning({
	cwd,
	settings,
}: {
	cwd: string;
	settings: Settings;
}): Promise<string | undefined> {
	if (!cfgEvalPy.get(settings)) return undefined;
	const interpreter = cfgPythonInterpreter.get(settings)?.trim() || undefined;
	const availability = await checkPythonKernelAvailability(cwd, interpreter);
	if (availability.ok) return undefined;
	const reason = availability.reason ?? "no working Python interpreter";
	return cfgEvalJs.get(settings)
		? `Python eval unavailable (${reason}); eval will run JavaScript only. ${PYTHON_FIX_HINT}`
		: `Eval tool unavailable: ${reason}, and JavaScript eval is disabled. ${PYTHON_FIX_HINT}`;
}
