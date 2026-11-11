/** Typed judgments run only through the current chat model, when explicitly requested. */
import {
	type AgentTelemetry,
	type AgentTelemetryConfig,
	recordJudgmentTelemetry,
	resolveTelemetry,
} from "@oh-my-pi/pi-agent-core";
import {
	type AssistantMessage,
	chatTextBackend,
	type Judge,
	type JudgeOptions,
	type JudgmentRequest,
	type JudgmentResult,
	type Model,
	type Questions,
	TextJudge,
	type Usage,
} from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { isEmbeddedImageContent } from "@oh-my-pi/pi-ai/images/shared";
import { sendsImageInputOnWire } from "@oh-my-pi/pi-ai/providers/vision-guard";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { CostGateApi } from "../session/cost-gate";
import type { SessionManager } from "../session/session-manager";
import { normalizeModelContextImages } from "../utils/image-loading";
import type { JudgmentCache } from "./cache";

export * from "./cache";

/** Usage of one billed judgment attempt, recorded on the session ledger by callers. */
export interface JudgmentUsage {
	purpose: string;
	role: string;
	api: string;
	provider: string;
	model: string;
	usage: Usage;
	stopReason: AssistantMessage["stopReason"];
	errorMessage?: string;
}

export interface JudgeDeps {
	settings: Settings;
	registry: ModelRegistry;
	/** The only model this judgment may use; omitted means judgment is unavailable. */
	sessionModel?: Model;
	sessionId?: string;
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
	purpose: string;
	onUsage?: (usage: JudgmentUsage) => void;
	telemetry?: AgentTelemetryConfig;
	/** Retained for callers that share historical judgment caches. Chat judgments do not use it. */
	cache?: JudgmentCache;
	costGate?: CostGateApi;
}

interface JudgmentAttempt extends Omit<JudgmentUsage, "purpose"> {
	startedAt: number;
}

/** Session journal surface that records off-transcript model cost; journal-only managers omit it. */
export type JudgmentUsageLedger = Pick<SessionManager, "appendModelUsage" | "getSessionId" | "getLeafId">;

function isUsageLedger(manager: Partial<JudgmentUsageLedger>): manager is JudgmentUsageLedger {
	return (
		manager.appendModelUsage !== undefined && manager.getSessionId !== undefined && manager.getLeafId !== undefined
	);
}

/**
 * Build a {@link JudgeDeps.onUsage} that journals every billed judgment attempt
 * as a `model_usage` entry beneath the session leaf at record time, so
 * `getSessionStats()` counts it in session totals. Attempts that land after
 * the session changes are dropped by the ledger. Returns `undefined` when the
 * journal cannot record usage.
 */
export function journalJudgmentUsage(manager: Partial<JudgmentUsageLedger> | undefined): JudgeDeps["onUsage"] {
	if (!manager || !isUsageLedger(manager)) return undefined;
	const sessionId = manager.getSessionId();
	return usage => {
		manager.appendModelUsage(usage, { sessionId, parentId: manager.getLeafId() });
	};
}

/** Kept for consumers that distinguish explicit prompted judgments from native-only automation. */
export type JudgeKind = "native" | "local" | "online";

/** Native auxiliary judges are disabled; automatic features must not spend the chat model's tokens. */
export function hasNativeJudge(_settings: Settings, _registry: ModelRegistry): boolean {
	return false;
}

/** Create an explicit judgment facade bound to the caller's current model. */
export function resolveJudge(deps: JudgeDeps): ChainJudge {
	return new ChainJudge(deps);
}

/** A single current-model judgment, with no model discovery, role selection, or fallback. */
export class ChainJudge implements Judge {
	readonly label = "current model";
	readonly #deps: JudgeDeps;
	readonly #telemetry: AgentTelemetry | undefined;

	constructor(deps: JudgeDeps) {
		this.#deps = deps;
		this.#telemetry = resolveTelemetry(deps.telemetry, deps.sessionId);
	}

	primaryModel(): Model | undefined {
		const model = this.#deps.sessionModel;
		return model && modelKind(model) === "chat" && model.api !== "local-inference" ? model : undefined;
	}

	async judge<Q extends Questions>(
		request: JudgmentRequest<Q>,
		options: JudgeOptions = {},
	): Promise<JudgmentResult<Q>> {
		const model = this.#requireModel();
		const images = request.images ?? [];
		for (const [index, image] of images.entries()) {
			if (!isEmbeddedImageContent(image)) {
				throw new AIError.ValidationError(
					`judgment: images[${index}] must contain non-empty base64 data and an image MIME type`,
				);
			}
		}
		for (const question of Object.values(request.questions)) {
			if (question.type === "box") throw new Error("judgment: the current chat model cannot answer box questions");
		}
		if (images.length > 0 && !sendsImageInputOnWire(model)) {
			throw new Error("judgment: the current model does not support images");
		}
		const prepared =
			images.length === 0 ? request : { ...request, images: (await normalizeModelContextImages([...images])) ?? [] };
		return this.withCandidate(judge => judge.judge(prepared, options), options);
	}

	async withCandidate<T>(run: (judge: Judge, kind: JudgeKind) => Promise<T>, options: JudgeOptions = {}): Promise<T> {
		const model = this.#requireModel();
		const signal = options.signal;
		this.#deps.costGate?.admit();
		return untilAborted(signal, async () => {
			const { registry, sessionId } = this.#deps;
			if (!(await registry.getApiKey(model, sessionId, { signal }))) {
				throw new Error(`judgment: no API key for current model ${model.provider}/${model.id}`);
			}
			const backend = chatTextBackend(model, {
				apiKey: registry.resolver(model, sessionId),
				sessionId,
				metadata: this.#deps.metadataResolver?.(model.provider),
				onAttempt: attempt =>
					this.#report({
						role: "default",
						api: attempt.api,
						provider: attempt.provider,
						model: attempt.model,
						usage: attempt.usage,
						stopReason: attempt.stopReason,
						errorMessage: attempt.errorMessage,
						startedAt: attempt.timestamp,
					}),
			});
			return run(withCandidateSignal(new TextJudge(backend), signal), "online");
		});
	}

	#requireModel(): Model {
		const model = this.primaryModel();
		if (!model) throw new Error("judgment: no current chat model is selected");
		return model;
	}

	#report(attempt: JudgmentAttempt): void {
		const { startedAt, ...rest } = attempt;
		const usage: JudgmentUsage = { purpose: this.#deps.purpose, ...rest };
		this.#deps.costGate?.record(usage.usage.cost.total);
		this.#deps.onUsage?.(usage);
		recordJudgmentTelemetry(this.#telemetry, {
			provider: usage.provider,
			model: usage.model,
			purpose: usage.purpose,
			usage: usage.usage,
			stopReason: usage.stopReason,
			errorMessage: usage.errorMessage,
			startTime: startedAt,
		}).catch(error => logger.warn("judgment telemetry failed", { error: String(error) }));
	}
}

/** Bind transport cancellation even when a withCandidate callback omits its call options. */
function withCandidateSignal(judge: Judge, parent: AbortSignal | undefined): Judge {
	return {
		label: judge.label,
		...(judge.supportsImages === undefined ? {} : { supportsImages: judge.supportsImages }),
		async judge<Q extends Questions>(
			request: JudgmentRequest<Q>,
			options?: JudgeOptions,
		): Promise<JudgmentResult<Q>> {
			const signal = parent
				? options?.signal && options.signal !== parent
					? AbortSignal.any([parent, options.signal])
					: parent
				: options?.signal;
			return judge.judge(request, { ...options, signal });
		},
	};
}
