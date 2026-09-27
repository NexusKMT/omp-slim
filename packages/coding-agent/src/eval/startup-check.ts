import type { Settings } from "../config/settings";
import { checkPythonKernelAvailability } from "./py/kernel";
import { cfgEvalJs, cfgEvalPy, cfgPythonInterpreter } from "./settings";

const PYTHON_FIX_HINT = "Install Python 3.8+ or set python.interpreter, then verify with `omp setup python --check`.";

/**
 * Eval capability check for a fresh install's first interactive launch.
 *
 * Only reports a Python backend that is enabled but has no working
 * interpreter. A backend disabled through `eval.py` / `eval.js` (or
 * `PI_PY` / `PI_JS`) is an intentional choice and is never reported.
 * The caller decides "first launch"; this function does not persist anything.
 */
export async function checkEvalCapabilities(options: { cwd: string; settings: Settings }): Promise<string | undefined> {
	if (!cfgEvalPy.get(options.settings)) return undefined;
	const interpreter = cfgPythonInterpreter.get(options.settings)?.trim() || undefined;
	const availability = await checkPythonKernelAvailability(options.cwd, interpreter);
	if (availability.ok) return undefined;
	const reason = availability.reason ?? "no working Python interpreter";
	return cfgEvalJs.get(options.settings)
		? `Python eval unavailable (${reason}); eval will run JavaScript only. ${PYTHON_FIX_HINT}`
		: `Eval tool unavailable: ${reason}, and JavaScript eval is disabled. ${PYTHON_FIX_HINT}`;
}
