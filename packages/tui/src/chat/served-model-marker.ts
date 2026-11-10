import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { MessageDividerComponent } from "../chrome/message-divider";
import { theme } from "../theme";

/** A turn whose response reported a model id different from the requested id. */
export interface ServedModelMismatch {
	/** Model id the request asked for. */
	requested: string;
	/** Model id reported by the Chat response. */
	served: string;
	/** Configured provider the request went to. */
	provider: string;
	/** Historical upstream host, when present in a saved response. */
	upstreamProvider?: string;
}

/** Report a response model id different from the requested id, without guessing aliases. */
export function detectServedModelMismatch(message: AssistantMessage): ServedModelMismatch | undefined {
	const served = message.upstreamModel;
	if (!served || served === message.model) return undefined;
	return {
		requested: message.model,
		served,
		provider: message.provider,
		...(message.upstreamProvider ? { upstreamProvider: message.upstreamProvider } : {}),
	};
}

/**
 * Per-transcript memory that surfaces each distinct (requested → served)
 * reported difference once. A gateway that swaps models does so for every turn, so
 * repeating the marker would only add noise; a new pair after a model switch
 * still gets its own marker. Replaced wholesale on rebuild so replaying history
 * re-derives the same first occurrence.
 */
export class ServedModelTracker {
	readonly #announced = new Set<string>();

	/** The mismatch to render for `message`, or undefined when there is none or it was already shown. */
	check(message: AssistantMessage): ServedModelMismatch | undefined {
		const mismatch = detectServedModelMismatch(message);
		if (!mismatch) return undefined;
		const key = `${mismatch.provider}\0${mismatch.requested}\0${mismatch.served}`;
		if (this.#announced.has(key)) return undefined;
		this.#announced.add(key);
		return mismatch;
	}
}

/**
 * Slim left-aligned divider rendered after the first assistant turn whose
 * response reported a different model id. Same shape as the
 * message divider, in the warning color:
 *
 *   ────────── ⚠ response model endpoint-snapshot · requested main-model · via custom
 */
export class ServedModelMarkerComponent extends MessageDividerComponent {
	constructor(info: ServedModelMismatch) {
		super({
			label: () => {
				const dot = theme.sep.dot.trim();
				const via = info.upstreamProvider ? `${info.provider}/${info.upstreamProvider}` : info.provider;
				return `${theme.status.warning} response model ${info.served} ${dot} requested ${info.requested} ${dot} via ${via}`;
			},
			labelColor: "warning",
			ruleColor: "dim",
			ruleWidth: 10,
			role: "omp.marker.served-model",
			native: {
				icon: "warn",
				label: () => {
					const via = info.upstreamProvider ? `${info.provider}/${info.upstreamProvider}` : info.provider;
					return `Response model ${info.served} · requested ${info.requested} · via ${via}`;
				},
			},
		});
	}
}
