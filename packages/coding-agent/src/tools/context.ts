import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolCallContext,
} from "@oh-my-pi/pi-agent-core";
import type { CustomToolContext } from "../extensibility/custom-tools/types";
import type { ExtensionUIContext } from "../extensibility/extensions/types";

/** Options a tool passes when delegating to another tool's native implementation via {@link AgentToolContext.invokeTool}. */
export interface InvokeToolOptions {
	/** Abort signal forwarded to the invoked tool's `execute`. */
	signal?: AbortSignal;
	/** Progress callback forwarded to the invoked tool's `execute`. */
	onUpdate?: AgentToolUpdateCallback;
}

declare module "@oh-my-pi/pi-agent-core" {
	interface AgentToolContext extends CustomToolContext {
		ui?: ExtensionUIContext;
		hasUI?: boolean;
		toolNames?: string[];
		toolCall?: ToolCallContext;
		/** Set on `xd://` device dispatches: the write tool's outer approval gate
		 *  already resolved this call at the mounted tool's tier, so the inner
		 *  wrapper must not re-prompt for the same action (explicit per-tool
		 *  policies and overrides still apply). */
		xdevApproved?: boolean;
		/** Set only after an interactive prompt approves provider computer safety checks. */
		providerSafetyApproved?: boolean;
		/**
		 * Run the NATIVE built-in implementation of `name` with `params` and return its result,
		 * bypassing any extension re-registration of that name. Lets a tool that re-registers a
		 * built-in (e.g. wrapping `write`) delegate to the original instead of reimplementing it —
		 * the native tool performs its own side effects and internal bookkeeping. Resolves to
		 * `undefined` when no native tool of that name exists. The invoked tool's approval gate is
		 * NOT re-run: the caller is itself an already-approved tool call. Recursion is depth-guarded.
		 */
		invokeTool?<TDetails = unknown>(
			name: string,
			params: Record<string, unknown>,
			options?: InvokeToolOptions,
		): Promise<AgentToolResult<TDetails> | undefined>;
	}
}

/** Max depth for `invokeTool` delegation chains — guards a re-registered tool that recurses into itself. */
const MAX_INVOKE_DEPTH = 8;

export class ToolContextStore {
	#uiContext: ExtensionUIContext | undefined;
	#hasUI = false;
	#toolNames: string[] = [];
	#invokeDepth = 0;

	/**
	 * @param getBaseContext  builds the per-call base tool context.
	 * @param resolveNativeTool  resolves a tool NAME to its native built-in implementation (the
	 *   pre-extension-override tool), or undefined if there is no native tool of that name. Used to
	 *   back `ctx.invokeTool`. Lazy: called at invoke time, after the registry is fully assembled.
	 */
	constructor(
		private readonly getBaseContext: () => CustomToolContext,
		private readonly resolveNativeTool?: (name: string) => AgentTool<any> | undefined,
	) {}

	getContext(toolCall?: ToolCallContext): AgentToolContext {
		return {
			...this.getBaseContext(),
			ui: this.#uiContext,
			hasUI: this.#hasUI,
			toolNames: this.#toolNames,
			toolCall,
			invokeTool: this.resolveNativeTool
				? (name, params, options) => this.#invokeTool(name, params, options)
				: undefined,
		};
	}

	async #invokeTool<TDetails = unknown>(
		name: string,
		params: Record<string, unknown>,
		options?: InvokeToolOptions,
	): Promise<AgentToolResult<TDetails> | undefined> {
		const native = this.resolveNativeTool?.(name);
		if (!native) return undefined;
		if (this.#invokeDepth >= MAX_INVOKE_DEPTH) {
			throw new Error(
				`invokeTool: delegation depth exceeded ${MAX_INVOKE_DEPTH} (recursive invokeTool for "${name}"?)`,
			);
		}
		// Nested context so the invoked tool sees the same session state (ui, cwd, etc.) and can itself
		// delegate. Its approval gate is NOT re-run: it is reached via the native execute directly, not
		// the ExtensionToolWrapper, so the caller's already-granted approval covers it.
		const nestedContext = this.getContext(undefined);
		this.#invokeDepth++;
		try {
			const toolCallId = `invoke-${name}-${Date.now().toString(36)}-${this.#invokeDepth}`;
			return (await native.execute(
				toolCallId,
				params as never,
				options?.signal,
				options?.onUpdate as never,
				nestedContext,
			)) as AgentToolResult<TDetails>;
		} finally {
			this.#invokeDepth--;
		}
	}

	setUIContext(uiContext: ExtensionUIContext, hasUI: boolean): void {
		this.#uiContext = uiContext;
		this.#hasUI = hasUI;
	}

	setToolNames(names: string[]): void {
		this.#toolNames = names;
	}
}
