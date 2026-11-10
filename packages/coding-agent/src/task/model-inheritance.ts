import type { Effort, Model } from "@oh-my-pi/pi-ai";
import { assertModelSupportsEffortCeiling } from "@oh-my-pi/pi-tui/thinking";
import { formatModelStringWithRouting } from "../config/model-resolver";

/**
 * This guard survives in a parked agent's revival recipe. Construct it outside
 * the executor's scope so its closure cannot retain the disposed session.
 */
export function inheritedModelGuard(model: Model, effortCeiling?: Effort): (dispatchModel: Model) => void {
	const identity = formatModelStringWithRouting(model);
	return dispatchModel => {
		if (formatModelStringWithRouting(dispatchModel) !== identity) {
			throw new Error("Subagents must use the inherited parent model.");
		}
		if (effortCeiling) assertModelSupportsEffortCeiling(dispatchModel, effortCeiling);
	};
}
