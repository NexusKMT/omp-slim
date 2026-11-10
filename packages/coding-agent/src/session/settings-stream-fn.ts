/** Apply session request limits, cancellation watchdogs and output budgets to Chat Completions. */
import { fitOutputTokensToContextWindow, type StreamFn, Tokenizer } from "@oh-my-pi/pi-agent-core";
import { type SimpleStreamOptions, streamSimple } from "@oh-my-pi/pi-ai";
import type { Settings } from "../config/settings";
import {
	cfgModelLoopGuardCheckAssistantContent,
	cfgModelLoopGuardEnabled,
	cfgOmitThinking,
	cfgProvidersMaxInFlightRequests,
	cfgProvidersStreamFirstEventTimeoutSeconds,
	cfgProvidersStreamIdleTimeoutSeconds,
	cfgRetryMaxDelayMs,
	validateProviderMaxInFlightRequests,
} from "./settings";

function timeoutSecondsToMs(value: number): number | undefined {
	if (!Number.isFinite(value) || value < 0) return undefined;
	return value === 0 ? 0 : Math.max(1, Math.trunc(value * 1000));
}

export function createSettingsAwareStreamFn(settings: Settings, base: StreamFn = streamSimple): StreamFn {
	const tokenizers = new Map<string, Tokenizer>();
	return (model, context, options) => {
		const key = `${model.provider}\0${model.id}`;
		let tokenizer = tokenizers.get(key);
		if (!tokenizer) {
			tokenizer = new Tokenizer(model);
			tokenizers.set(key, tokenizer);
		}
		const merged: SimpleStreamOptions = {
			...options,
			maxTokens: fitOutputTokensToContextWindow(model, context, options?.maxTokens, tokenizer),
			streamFirstEventTimeoutMs:
				options?.streamFirstEventTimeoutMs ??
				timeoutSecondsToMs(cfgProvidersStreamFirstEventTimeoutSeconds.get(settings)),
			streamIdleTimeoutMs:
				options?.streamIdleTimeoutMs ?? timeoutSecondsToMs(cfgProvidersStreamIdleTimeoutSeconds.get(settings)),
			maxRetryDelayMs: options?.maxRetryDelayMs ?? cfgRetryMaxDelayMs.get(settings),
			maxInFlightRequests: validateProviderMaxInFlightRequests(
				options?.maxInFlightRequests ?? cfgProvidersMaxInFlightRequests.get(settings),
			),
			loopGuard: {
				enabled: cfgModelLoopGuardEnabled.get(settings),
				checkAssistantContent: cfgModelLoopGuardCheckAssistantContent.get(settings),
				...options?.loopGuard,
			},
			hideThinkingSummary: options?.hideThinkingSummary ?? cfgOmitThinking.get(settings),
		};
		return base(model, context, merged);
	};
}
