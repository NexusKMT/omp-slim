import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import type { ModelOverride } from "./models-config-schema";

export type ModelPatch = Partial<ModelSpec<Api>>;

/** Merge explicitly authored metadata without selecting or inferring another endpoint. */
export function applyModelOverride(model: Model<Api>, override: ModelOverride): Model<Api> {
	return buildModel({ ...model, ...override, compat: { ...model.compat, ...override.compat } });
}
