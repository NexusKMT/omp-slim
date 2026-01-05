import {
	type AssistantMessage,
	completeSimple,
	getModels,
	type Model,
	streamSimple,
	type TextContent,
	type ToolResultMessage,
	type Usage,
} from "@oh-my-pi/pi-ai";
import { html, LitElement } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { ModelSelector } from "../dialogs/ModelSelector";
import type { MessageEditor } from "./MessageEditor";
import "./MessageEditor.js";
import "./MessageList.js";
import "./Messages.js"; // Import for side effects to register the custom elements
import { getAppStorage } from "../storage/app-storage";
import "./StreamingMessageContainer.js";
import type { Agent, AgentEvent } from "@oh-my-pi/pi-agent-core";
import type { Attachment } from "../utils/attachment-utils";
import { formatUsage } from "../utils/format";
import { i18n } from "../utils/i18n";
import { createStreamFn } from "../utils/proxy-utils";
import { synthesizeOpenAI, transcribeOpenAI, VoiceCapture, type VoiceCaptureResult } from "../utils/voice";
import type { UserMessageWithAttachments } from "./Messages";
import type { StreamingMessageContainer } from "./StreamingMessageContainer";

@customElement("agent-interface")
export class AgentInterface extends LitElement {
	// Optional external session: when provided, this component becomes a view over the session
	@property({ attribute: false }) session?: Agent;
	@property({ type: Boolean }) enableAttachments = true;
	@property({ type: Boolean }) enableModelSelector = true;
	@property({ type: Boolean }) enableThinkingSelector = true;
	@property({ type: Boolean }) showThemeToggle = false;
	@property({ type: Boolean }) enableVoice = true;
	// Optional custom API key prompt handler - if not provided, uses default dialog
	@property({ attribute: false }) onApiKeyRequired?: (provider: string) => Promise<boolean>;
	// Optional callback called before sending a message
	@property({ attribute: false }) onBeforeSend?: () => void | Promise<void>;
	// Optional callback called before executing a tool call - return false to prevent execution
	@property({ attribute: false }) onBeforeToolCall?: (toolName: string, args: any) => boolean | Promise<boolean>;
	// Optional callback called when cost display is clicked
	@property({ attribute: false }) onCostClick?: () => void;

	// References
	@query("message-editor") private _messageEditor!: MessageEditor;
	@query("streaming-message-container") private _streamingContainer!: StreamingMessageContainer;

	@state() private voiceStatus: "idle" | "listening" | "transcribing" | "speaking" | "error" = "idle";

	private _autoScroll = true;
	private _lastScrollTop = 0;
	private _lastClientHeight = 0;
	private _scrollContainer?: HTMLElement;
	private _resizeObserver?: ResizeObserver;
	private _unsubscribeSession?: () => void;
	private voiceCapture?: VoiceCapture;
	private voiceAudio?: HTMLAudioElement;
	private voiceSummaryAbort?: AbortController;
	private voiceLastSpokenTimestamp = 0;
	private voiceKeyListener = (event: KeyboardEvent) => {
		void this.handleVoiceKey(event);
	};

	public setInput(text: string, attachments?: Attachment[]) {
		const update = () => {
			if (!this._messageEditor) requestAnimationFrame(update);
			else {
				this._messageEditor.value = text;
				this._messageEditor.attachments = attachments || [];
			}
		};
		update();
	}

	public setAutoScroll(enabled: boolean) {
		this._autoScroll = enabled;
	}

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override willUpdate(changedProperties: Map<string, any>) {
		super.willUpdate(changedProperties);

		// Re-subscribe when session property changes
		if (changedProperties.has("session")) {
			this.setupSessionSubscription();
		}
	}

	override async connectedCallback() {
		super.connectedCallback();

		this.style.display = "flex";
		this.style.flexDirection = "column";
		this.style.height = "100%";
		this.style.minHeight = "0";

		// Wait for first render to get scroll container
		await this.updateComplete;
		this._scrollContainer = this.querySelector(".overflow-y-auto") as HTMLElement;

		if (this._scrollContainer) {
			// Set up ResizeObserver to detect content changes
			this._resizeObserver = new ResizeObserver(() => {
				if (this._autoScroll && this._scrollContainer) {
					this._scrollContainer.scrollTop = this._scrollContainer.scrollHeight;
				}
			});

			// Observe the content container inside the scroll container
			const contentContainer = this._scrollContainer.querySelector(".max-w-3xl");
			if (contentContainer) {
				this._resizeObserver.observe(contentContainer);
			}

			// Set up scroll listener with better detection
			this._scrollContainer.addEventListener("scroll", this._handleScroll);
		}

		// Subscribe to external session if provided
		this.setupSessionSubscription();

		window.addEventListener("keydown", this.voiceKeyListener);
	}

	override disconnectedCallback() {
		super.disconnectedCallback();

		// Clean up observers and listeners
		if (this._resizeObserver) {
			this._resizeObserver.disconnect();
			this._resizeObserver = undefined;
		}

		if (this._scrollContainer) {
			this._scrollContainer.removeEventListener("scroll", this._handleScroll);
		}

		if (this._unsubscribeSession) {
			this._unsubscribeSession();
			this._unsubscribeSession = undefined;
		}

		window.removeEventListener("keydown", this.voiceKeyListener);
		void this.stopVoiceCapture("manual");
		this.stopVoicePlayback();
		this.voiceSummaryAbort?.abort();
	}

	private setupSessionSubscription() {
		if (this._unsubscribeSession) {
			this._unsubscribeSession();
			this._unsubscribeSession = undefined;
		}
		if (!this.session) return;

		// Set default streamFn with proxy support if not already set
		if (this.session.streamFn === streamSimple) {
			this.session.streamFn = createStreamFn(async () => {
				const enabled = await getAppStorage().settings.get<boolean>("proxy.enabled");
				return enabled ? (await getAppStorage().settings.get<string>("proxy.url")) || undefined : undefined;
			});
		}

		// Set default getApiKey if not already set
		if (!this.session.getApiKey) {
			this.session.getApiKey = async (provider: string) => {
				const key = await getAppStorage().providerKeys.get(provider);
				return key ?? undefined;
			};
		}

		this._unsubscribeSession = this.session.subscribe(async (ev: AgentEvent) => {
			switch (ev.type) {
				case "message_start":
				case "message_end":
				case "turn_start":
				case "turn_end":
				case "agent_start":
					this.requestUpdate();
					break;
				case "agent_end":
					// Clear streaming container when agent finishes
					if (this._streamingContainer) {
						this._streamingContainer.isStreaming = false;
						this._streamingContainer.setMessage(null, true);
					}
					this.requestUpdate();
					void this.handleAgentEnd();
					break;
				case "message_update":
					if (this._streamingContainer) {
						const isStreaming = this.session?.state.isStreaming || false;
						this._streamingContainer.isStreaming = isStreaming;
						this._streamingContainer.setMessage(ev.message, !isStreaming);
					}
					this.requestUpdate();
					break;
			}
		});
	}

	private _handleScroll = (_ev: any) => {
		if (!this._scrollContainer) return;

		const currentScrollTop = this._scrollContainer.scrollTop;
		const scrollHeight = this._scrollContainer.scrollHeight;
		const clientHeight = this._scrollContainer.clientHeight;
		const distanceFromBottom = scrollHeight - currentScrollTop - clientHeight;

		// Ignore relayout due to message editor getting pushed up by stats
		if (clientHeight < this._lastClientHeight) {
			this._lastClientHeight = clientHeight;
			return;
		}

		// Only disable auto-scroll if user scrolled UP or is far from bottom
		if (currentScrollTop !== 0 && currentScrollTop < this._lastScrollTop && distanceFromBottom > 50) {
			this._autoScroll = false;
		} else if (distanceFromBottom < 10) {
			// Re-enable if very close to bottom
			this._autoScroll = true;
		}

		this._lastScrollTop = currentScrollTop;
		this._lastClientHeight = clientHeight;
	};

	private async handleVoiceKey(event: KeyboardEvent): Promise<void> {
		if (!this.enableVoice) return;
		if (event.code !== "CapsLock" && event.key !== "CapsLock") return;
		if (event.repeat) return;
		event.preventDefault();

		if (this.voiceStatus === "transcribing" || this.voiceStatus === "speaking") {
			return;
		}

		if (this.voiceCapture?.isRecording) {
			await this.stopVoiceCapture("manual");
		} else {
			await this.startVoiceCapture();
		}
	}

	private async startVoiceCapture(): Promise<void> {
		if (!this.enableVoice || this.voiceCapture?.isRecording) return;
		const apiKey = await this.resolveApiKey("openai");
		if (!apiKey) {
			this.voiceStatus = "error";
			console.error("Voice capture requires an OpenAI API key.");
			return;
		}

		this.voiceStatus = "listening";
		this.voiceCapture = new VoiceCapture();
		const resultPromise = this.voiceCapture.start();
		void resultPromise
			.then((result) => this.handleVoiceCaptureResult(result))
			.catch((error) => {
				this.voiceStatus = "error";
				this.voiceCapture = undefined;
				console.error("Failed to start voice capture:", error);
			});
	}

	private async stopVoiceCapture(reason: "manual" | "silence" | "max" | "error"): Promise<void> {
		if (!this.voiceCapture) return;
		await this.voiceCapture.stop(reason);
	}

	private async handleVoiceCaptureResult(result: VoiceCaptureResult): Promise<void> {
		if (this.voiceStatus === "transcribing" || this.voiceStatus === "speaking") return;
		if (!result.blob) {
			this.voiceStatus = "idle";
			this.voiceCapture = undefined;
			return;
		}
		this.voiceStatus = "transcribing";
		try {
			const transcript = await this.transcribeAudio(result.blob);
			if (transcript.trim()) {
				await this.sendVoiceMessage(transcript);
			}
			this.voiceStatus = "idle";
			this.voiceCapture = undefined;
		} catch (error) {
			this.voiceStatus = "error";
			this.voiceCapture = undefined;
			console.error("Voice transcription failed:", error);
		}
	}

	private async transcribeAudio(blob: Blob): Promise<string> {
		const apiKey = await this.resolveApiKey("openai");
		if (!apiKey) {
			throw new Error("OpenAI API key required for transcription.");
		}
		return transcribeOpenAI(blob, {
			apiKey,
			model: "whisper-1",
			prompt: "Short voice command or question.",
		});
	}

	private async sendVoiceMessage(input: string): Promise<void> {
		const session = this.session;
		if (!session) return;

		// Design choice: keep the agent's full response for the UI, and generate short voice summaries separately.
		const text = input.trim();
		if (!text) return;

		if (!(await this.ensureApiKeyForProvider(session.state.model?.provider))) {
			return;
		}

		if (session.state.isStreaming) {
			if (this.onBeforeSend) {
				await this.onBeforeSend();
			}
			session.queueMessage({ role: "user", content: text, timestamp: Date.now() });
			return;
		}

		await this.sendMessage(text);
	}

	private async handleAgentEnd(): Promise<void> {
		if (!this.enableVoice) return;
		const session = this.session;
		if (!session) return;

		const lastAssistant = this.getLastAssistantMessage(session.state.messages);
		if (!lastAssistant) return;
		if (lastAssistant.timestamp <= this.voiceLastSpokenTimestamp) return;

		const assistantText = this.extractAssistantText(lastAssistant);
		if (!assistantText.trim()) return;

		this.voiceLastSpokenTimestamp = lastAssistant.timestamp;

		try {
			const summary = await this.summarizeForVoice(assistantText);
			if (summary.trim()) {
				await this.speak(summary);
			}
		} catch (error) {
			this.voiceStatus = "error";
			console.error("Voice summary failed:", error);
		}
	}

	private async summarizeForVoice(text: string): Promise<string> {
		const model = this.resolveFastModel() || this.session?.state.model;
		if (!model) {
			return this.fallbackSummary(text);
		}

		const apiKey = await this.resolveApiKey(model.provider);
		if (!apiKey) {
			return this.fallbackSummary(text);
		}

		this.voiceSummaryAbort?.abort();
		this.voiceSummaryAbort = new AbortController();

		const prompt = [
			"Summarize the assistant response for voice playback.",
			"Keep it to 1-3 short sentences, conversational tone.",
			"Preserve any question the assistant asked.",
			'Keep uncertainty if present (e.g. "hmm... maybe...").',
			"Do not use bullet points.",
			"",
			"Assistant response:",
			text,
		].join("\n");

		const result = await completeSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: prompt,
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey,
				maxTokens: 200,
				temperature: 0.2,
				signal: this.voiceSummaryAbort.signal,
			},
		);

		const summary = this.extractAssistantText(result);
		return summary.trim() || this.fallbackSummary(text);
	}

	private async speak(text: string): Promise<void> {
		const apiKey = await this.resolveApiKey("openai");
		if (!apiKey) {
			console.error("OpenAI API key required for speech synthesis.");
			return;
		}

		this.stopVoicePlayback();
		this.voiceStatus = "speaking";

		const audioBlob = await synthesizeOpenAI(text, {
			apiKey,
			model: "tts-1",
			voice: "alloy",
			responseFormat: "mp3",
		});

		const audioUrl = URL.createObjectURL(audioBlob);
		const audio = new Audio(audioUrl);
		this.voiceAudio = audio;

		try {
			await audio.play();
			await new Promise<void>((resolve, reject) => {
				audio.onended = () => resolve();
				audio.onerror = () => reject(new Error("Audio playback failed"));
			});
		} finally {
			URL.revokeObjectURL(audioUrl);
			if (this.voiceAudio === audio) {
				this.voiceAudio = undefined;
			}
			this.voiceStatus = "idle";
		}
	}

	private stopVoicePlayback(): void {
		if (this.voiceAudio) {
			this.voiceAudio.pause();
			this.voiceAudio.currentTime = 0;
			this.voiceAudio = undefined;
		}
	}

	private resolveFastModel(): Model<any> | undefined {
		const openAiModels = getModels("openai");
		const preferred = ["gpt-5-mini", "gpt-4o-mini", "gpt-4.1-mini"];
		for (const id of preferred) {
			const found = openAiModels.find((m) => m.id === id);
			if (found) return found;
		}
		return openAiModels.find((m) => m.id.includes("mini")) || undefined;
	}

	private async resolveApiKey(provider: string): Promise<string | undefined> {
		if (this.session?.getApiKey) {
			const key = await this.session.getApiKey(provider);
			if (key) return key;
		}
		const stored = await getAppStorage().providerKeys.get(provider);
		return stored ?? undefined;
	}

	private async ensureApiKeyForProvider(provider?: string): Promise<boolean> {
		if (!provider) return false;
		const apiKey = await getAppStorage().providerKeys.get(provider);
		if (apiKey) return true;

		if (!this.onApiKeyRequired) {
			console.error("No API key configured and no onApiKeyRequired handler set");
			return false;
		}

		const success = await this.onApiKeyRequired(provider);
		return success;
	}

	private getLastAssistantMessage(messages: readonly unknown[]): AssistantMessage | undefined {
		for (let i = messages.length - 1; i >= 0; i -= 1) {
			const message = messages[i];
			if (this.isAssistantMessage(message)) {
				return message;
			}
		}
		return undefined;
	}

	private isAssistantMessage(message: unknown): message is AssistantMessage {
		if (!message || typeof message !== "object") return false;
		return (message as AssistantMessage).role === "assistant";
	}

	private extractAssistantText(message: AssistantMessage): string {
		return message.content
			.filter((part): part is TextContent => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	}

	private fallbackSummary(text: string): string {
		const cleaned = text.replace(/\s+/g, " ").trim();
		const matches = cleaned.match(/[^.!?]+[.!?]+/g);
		if (matches && matches.length > 0) {
			return matches.slice(0, 2).join(" ").trim();
		}
		return cleaned.slice(0, 240);
	}

	public async sendMessage(input: string, attachments?: Attachment[]) {
		if ((!input.trim() && attachments?.length === 0) || this.session?.state.isStreaming) return;
		const session = this.session;
		if (!session) throw new Error("No session set on AgentInterface");
		if (!session.state.model) throw new Error("No model set on AgentInterface");

		// Check if API key exists for the provider (only needed in direct mode)
		const provider = session.state.model.provider;
		const apiKey = await getAppStorage().providerKeys.get(provider);

		// If no API key, prompt for it
		if (!apiKey) {
			if (!this.onApiKeyRequired) {
				console.error("No API key configured and no onApiKeyRequired handler set");
				return;
			}

			const success = await this.onApiKeyRequired(provider);

			// If still no API key, abort the send
			if (!success) {
				return;
			}
		}

		// Call onBeforeSend hook before sending
		if (this.onBeforeSend) {
			await this.onBeforeSend();
		}

		// Only clear editor after we know we can send
		this._messageEditor.value = "";
		this._messageEditor.attachments = [];
		this._autoScroll = true; // Enable auto-scroll when sending a message

		// Compose message with attachments if any
		if (attachments && attachments.length > 0) {
			const message: UserMessageWithAttachments = {
				role: "user-with-attachments",
				content: input,
				attachments,
				timestamp: Date.now(),
			};
			await this.session?.prompt(message);
		} else {
			await this.session?.prompt(input);
		}
	}

	private renderMessages() {
		if (!this.session)
			return html`<div class="p-4 text-center text-muted-foreground">${i18n("No session available")}</div>`;
		const state = this.session.state;
		// Build a map of tool results to allow inline rendering in assistant messages
		const toolResultsById = new Map<string, ToolResultMessage<any>>();
		for (const message of state.messages) {
			if (message.role === "toolResult") {
				toolResultsById.set(message.toolCallId, message);
			}
		}
		return html`
			<div class="flex flex-col gap-3">
				<!-- Stable messages list - won't re-render during streaming -->
				<message-list
					.messages=${this.session.state.messages}
					.tools=${state.tools}
					.pendingToolCalls=${this.session ? this.session.state.pendingToolCalls : new Set<string>()}
					.isStreaming=${state.isStreaming}
					.onCostClick=${this.onCostClick}
				></message-list>

				<!-- Streaming message container - manages its own updates -->
				<streaming-message-container
					class="${state.isStreaming ? "" : "hidden"}"
					.tools=${state.tools}
					.isStreaming=${state.isStreaming}
					.pendingToolCalls=${state.pendingToolCalls}
					.toolResultsById=${toolResultsById}
					.onCostClick=${this.onCostClick}
				></streaming-message-container>
			</div>
		`;
	}

	private renderStats() {
		if (!this.session) return html`<div class="text-xs h-5"></div>`;

		const state = this.session.state;
		const totals = state.messages
			.filter((m) => m.role === "assistant")
			.reduce(
				(acc, msg: any) => {
					const usage = msg.usage;
					if (usage) {
						acc.input += usage.input;
						acc.output += usage.output;
						acc.cacheRead += usage.cacheRead;
						acc.cacheWrite += usage.cacheWrite;
						acc.cost.total += usage.cost.total;
					}
					return acc;
				},
				{
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				} satisfies Usage,
			);

		const hasTotals = totals.input || totals.output || totals.cacheRead || totals.cacheWrite;
		const totalsText = hasTotals ? formatUsage(totals) : "";

		return html`
			<div class="text-xs text-muted-foreground flex justify-between items-center h-5">
				<div class="flex items-center gap-2">
					${this.showThemeToggle ? html`<theme-toggle></theme-toggle>` : html``}
					${this.renderVoiceStatus()}
				</div>
				<div class="flex ml-auto items-center gap-3">
					${
						totalsText
							? this.onCostClick
								? html`<span class="cursor-pointer hover:text-foreground transition-colors" @click=${this.onCostClick}
									>${totalsText}</span
							  >`
								: html`<span>${totalsText}</span>`
							: ""
					}
				</div>
			</div>
		`;
	}

	private renderVoiceStatus() {
		if (!this.enableVoice || this.voiceStatus === "idle") return html``;
		const statusText =
			this.voiceStatus === "listening"
				? "Listening... (Caps Lock to stop)"
				: this.voiceStatus === "transcribing"
					? "Transcribing..."
					: this.voiceStatus === "speaking"
						? "Speaking..."
						: "Voice error";
		return html`<span>${statusText}</span>`;
	}

	override render() {
		if (!this.session)
			return html`<div class="p-4 text-center text-muted-foreground">${i18n("No session set")}</div>`;

		const session = this.session;
		const state = this.session.state;
		return html`
			<div class="flex flex-col h-full bg-background text-foreground">
				<!-- Messages Area -->
				<div class="flex-1 overflow-y-auto">
					<div class="max-w-3xl mx-auto p-4 pb-0">${this.renderMessages()}</div>
				</div>

				<!-- Input Area -->
				<div class="shrink-0">
					<div class="max-w-3xl mx-auto px-2">
						<message-editor
							.isStreaming=${state.isStreaming}
							.currentModel=${state.model}
							.thinkingLevel=${state.thinkingLevel}
							.showAttachmentButton=${this.enableAttachments}
							.showModelSelector=${this.enableModelSelector}
							.showThinkingSelector=${this.enableThinkingSelector}
							.onSend=${(input: string, attachments: Attachment[]) => {
								this.sendMessage(input, attachments);
							}}
							.onAbort=${() => session.abort()}
							.onModelSelect=${() => {
								ModelSelector.open(state.model, (model) => session.setModel(model));
							}}
							.onThinkingChange=${
								this.enableThinkingSelector
									? (level: "off" | "minimal" | "low" | "medium" | "high") => {
											session.setThinkingLevel(level);
										}
									: undefined
							}
						></message-editor>
						${this.renderStats()}
					</div>
				</div>
			</div>
		`;
	}
}

// Register custom element with guard
if (!customElements.get("agent-interface")) {
	customElements.define("agent-interface", AgentInterface);
}
