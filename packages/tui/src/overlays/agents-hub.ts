/** Browse agent instructions, enable agents, and create a persona using the current session model. */
import type { TspPickerItem } from "@oh-my-pi/pi-wire";
import {
	type Component,
	Editor,
	Input,
	SelectList,
	matchesKey,
	routeSgrMouseInput,
	type TUI,
	truncateToWidth,
} from "../index";
import { code, col, md, span, text } from "../native/describe";
import type { DescribeContext, NativeNode, NativeUiEvent } from "../native/node";
import { CLOSE_ACTION, picker, pickerAction, pickerEvent, pickerQuery } from "../native/picker";
import { overlayCard, actionBar, actionButton } from "../native/overlay";
import type { AgentSource } from "../tools/task";
import { getEditorTheme, getSelectListTheme } from "../theme";
import { HubFrame, describeHubFrame, describeHubSidebar, type SidebarEntry } from "./hub-frame";

export interface HubAgent {
	name: string;
	description: string;
	systemPrompt: string;
	source: AgentSource;
	filePath?: string;
	disabled: boolean;
	advisor?: boolean;
}
export interface GeneratedAgentSpec {
	identifier: string;
	whenToUse: string;
	systemPrompt: string;
}
export interface AgentsHubDeps {
	loadAgents(): Promise<HubAgent[]>;
	setAgentDisabled(name: string, options: { disabled: boolean }): void;
	setAgentAdvisor?(name: string, enabled: boolean): void;
	generateAgent(description: string, onText: (text: string) => void): Promise<string>;
	saveAgent(scope: "project" | "user", spec: GeneratedAgentSpec): Promise<string>;
}
export interface AgentsHubCallbacks {
	onCancel(): void;
}
const SOURCES = ["project", "user", "bundled"] as const;
const SOURCE_LABEL = { project: "Project", user: "User", bundled: "Bundled" };
const agentId = (agent: HubAgent): string => `agent:${agent.source}:${agent.name}`;
const IDENTIFIER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+){1,5}$/;

function extractJsonObject(raw: string): string {
	// A bare JSON object may legitimately contain code fences inside string values; keep it intact.
	try {
		JSON.parse(raw);
		return raw;
	} catch {}
	const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenceMatch?.[1]) return fenceMatch[1].trim();
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start >= 0 && end >= start) return raw.slice(start, end + 1).trim();
	return raw.trim();
}

/**
 * Parse model output into a {@link GeneratedAgentSpec}. Accepts a bare JSON object
 * (tried first) or one wrapped in a code fence. Returns the spec with trimmed fields.
 * Throws if the output is not valid JSON or not an object, if `identifier`, `whenToUse`
 * or `systemPrompt` is missing or not a string, if the identifier is not lowercase
 * kebab-case with 2+ words, if `whenToUse` does not start with "Use this agent when",
 * or if `systemPrompt` is empty.
 */
export function parseGeneratedAgentSpec(raw: string): GeneratedAgentSpec {
	const parsed = JSON.parse(extractJsonObject(raw)) as Partial<GeneratedAgentSpec>;
	if (!parsed || typeof parsed !== "object") {
		throw new Error("Model output is not a JSON object");
	}
	if (
		typeof parsed.identifier !== "string" ||
		typeof parsed.whenToUse !== "string" ||
		typeof parsed.systemPrompt !== "string"
	) {
		throw new Error("Model output is missing required fields (identifier, whenToUse, systemPrompt)");
	}
	const identifier = parsed.identifier.trim();
	const whenToUse = parsed.whenToUse.trim();
	const systemPrompt = parsed.systemPrompt.trim();
	if (!IDENTIFIER_PATTERN.test(identifier)) {
		throw new Error("Generated identifier is invalid (must be lowercase kebab-case, 2+ words)");
	}
	if (!whenToUse.toLowerCase().startsWith("use this agent when")) {
		throw new Error("Generated whenToUse must start with 'Use this agent when...'");
	}
	if (!systemPrompt) {
		throw new Error("Generated systemPrompt is empty");
	}
	return { identifier, whenToUse, systemPrompt };
}

export class AgentsHubComponent implements Component {
	#agents: HubAgent[] = [];
	#rows: HubAgent[] = [];
	#scope = "all";
	#sidebar = false;
	#search = new Input();
	#list = new SelectList([], 12, getSelectListTheme());
	#frame: HubFrame;
	#notice: string | undefined;
	#disposed = false;
	#createInput: Editor | undefined;
	#createSpec: GeneratedAgentSpec | undefined;
	#createScope: "project" | "user" = "project";
	#busy = false;
	#stream = "";
	#version = 0;
	#nativeCache: { version: number; node: NativeNode } | undefined;
	#entries: SidebarEntry<string>[] = [
		{ id: "all", kind: "all", label: "All agents" },
		...SOURCES.map(source => ({ id: source, kind: "source", label: SOURCE_LABEL[source] })),
		{ id: "new", kind: "new", label: "+ New agent" },
	];
	constructor(
		private tui: TUI,
		private deps: AgentsHubDeps,
		private callbacks: AgentsHubCallbacks,
	) {
		this.#frame = new HubFrame(
			"Agents",
			{ min: 16, max: 24 },
			(width, rows) =>
				this.#frame.renderSidebar(
					this.#entries,
					width,
					rows,
					{ id: this.#scope, focused: this.#sidebar, follow: true, clamp: true },
					() => ({ icon: "", annotation: "" }),
				),
			(width, rows) => this.#renderBody(width, rows ?? 20),
			{ bodyMinWidth: 28, preserveSidebar: true },
		);
		this.#list.onSelect = () => this.#toggle();
	}
	static async create(
		tui: TUI,
		deps: AgentsHubDeps,
		callbacks: AgentsHubCallbacks = { onCancel: () => {} },
	): Promise<AgentsHubComponent> {
		const hub = new AgentsHubComponent(tui, deps, callbacks);
		await hub.#reload();
		return hub;
	}
	dispose(): void {
		this.#disposed = true;
	}
	invalidate(): void {
		this.#version++;
		this.#frame.invalidate();
	}
	#repaint(): void {
		this.invalidate();
		if (!this.#disposed) this.tui.requestRender();
	}
	async #reload(): Promise<void> {
		this.#agents = await this.deps.loadAgents();
		this.#filter();
		this.#repaint();
	}
	#filter(): void {
		const query = this.#search.getValue().toLowerCase().split(/\s+/).filter(Boolean);
		const selected = this.#list.getSelectedItem()?.value;
		this.#rows = this.#agents.filter(
			agent =>
				(this.#scope === "all" || agent.source === this.#scope) &&
				query.every(token =>
					`${agent.name} ${agent.description} ${SOURCE_LABEL[agent.source]}`.toLowerCase().includes(token),
				),
		);
		this.#list.setItems(
			this.#rows.map(agent => ({
				value: agentId(agent),
				label: `${agent.disabled ? "○" : "●"} ${agent.name}`,
				description: agent.description,
			})),
		);
		if (selected) this.#list.setSelectedValue(selected);
	}
	#selected(): HubAgent | undefined {
		const selected = this.#list.getSelectedItem()?.value;
		return this.#rows.find(agent => agentId(agent) === selected);
	}
	#setScope(id: string): void {
		if (id === "new") {
			this.#beginCreate();
			return;
		}
		if (!this.#entries.some(entry => entry.id === id)) return;
		this.#scope = id;
		this.#filter();
		this.#repaint();
	}
	#toggle(): void {
		const agent = this.#selected();
		if (!agent) return;
		const disabled = !agent.disabled;
		try {
			this.deps.setAgentDisabled(agent.name, { disabled });
			agent.disabled = disabled;
			this.#filter();
			this.#notice = `${agent.name} ${disabled ? "disabled" : "enabled"}`;
		} catch (error) {
			this.#notice = String(error);
		}
		this.#repaint();
	}
	#toggleAdvisor(): void {
		const agent = this.#selected();
		if (!agent || !this.deps.setAgentAdvisor) return;
		try {
			this.deps.setAgentAdvisor(agent.name, !agent.advisor);
			agent.advisor = !agent.advisor;
			this.#notice = `${agent.name} advisor ${agent.advisor ? "enabled" : "disabled"}`;
		} catch (error) {
			this.#notice = String(error);
		}
		this.#repaint();
	}
	#beginCreate(): void {
		if (this.#busy) return;
		this.#createSpec = undefined;
		this.#notice = undefined;
		const editor = new Editor(getEditorTheme());
		editor.setBorderVisible(false);
		editor.disableSubmit = true;
		this.#createInput = editor;
		this.#repaint();
	}
	#clearCreate(): void {
		if (this.#busy) return;
		this.#createInput = undefined;
		this.#createSpec = undefined;
		this.#stream = "";
		this.#notice = undefined;
		this.#repaint();
	}
	async #generate(): Promise<void> {
		const description = this.#createInput?.getText().trim();
		if (!description) {
			this.#notice = "Describe the agent to create.";
			this.#repaint();
			return;
		}
		if (this.#busy) return;
		this.#busy = true;
		this.#notice = undefined;
		this.#stream = "";
		this.#repaint();
		try {
			const raw = await this.deps.generateAgent(description, part => {
				this.#stream += part;
				this.#repaint();
			});
			if (!this.#disposed) this.#createSpec = parseGeneratedAgentSpec(raw);
		} catch (error) {
			this.#notice = error instanceof Error ? error.message : String(error);
		} finally {
			this.#busy = false;
			this.#repaint();
		}
	}
	async #save(): Promise<void> {
		const spec = this.#createSpec;
		if (!spec || this.#busy) return;
		this.#busy = true;
		try {
			await this.deps.saveAgent(this.#createScope, spec);
			this.#createInput = undefined;
			this.#createSpec = undefined;
			this.#notice = `Created agent ${spec.identifier}`;
			await this.#reload();
		} catch (error) {
			this.#notice = error instanceof Error ? error.message : String(error);
		} finally {
			this.#busy = false;
			this.#repaint();
		}
	}
	handleInput(data: string): void {
		if (this.#createInput) {
			if (this.#busy) return;
			if (matchesKey(data, "escape")) {
				this.#clearCreate();
				return;
			}
			if (this.#createSpec) {
				if (matchesKey(data, "tab")) this.#createScope = this.#createScope === "project" ? "user" : "project";
				else if (matchesKey(data, "enter")) void this.#save();
			} else if (matchesKey(data, "ctrl+enter") || matchesKey(data, "alt+enter")) void this.#generate();
			else this.#createInput.handleInput(data);
			this.#repaint();
			return;
		}
		if (
			routeSgrMouseInput(data, event => {
				const hit = this.#frame.locate(event.row, event.col);
				if (hit.overSidebar && event.leftClick) {
					const entry = this.#entries[this.#frame.sidebarScroll + hit.contentLine];
					if (entry) this.#setScope(entry.id);
				} else if (hit.overBody) {
					if (event.wheel) this.#list.handleWheel(event.wheel);
					else if (event.leftClick) {
						const index = this.#list.hitTest(hit.bodyLine - 1);
						if (index !== undefined) this.#list.setSelectedIndex(index);
					}
				}
				this.#repaint();
			})
		)
			return;
		if (matchesKey(data, "escape")) {
			if (this.#search.getValue()) {
				this.#search.setValue("");
				this.#filter();
			} else this.callbacks.onCancel();
			this.#repaint();
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "left")) {
			this.#sidebar = !this.#sidebar;
			this.#repaint();
			return;
		}
		if (this.#sidebar) {
			const index = this.#entries.findIndex(entry => entry.id === this.#scope);
			if (matchesKey(data, "up") || matchesKey(data, "down")) {
				const next = (index + (matchesKey(data, "up") ? -1 : 1) + this.#entries.length) % this.#entries.length;
				this.#setScope(this.#entries[next]!.id);
				return;
			}
			if (matchesKey(data, "enter") || matchesKey(data, "right")) {
				this.#sidebar = false;
				this.#repaint();
				return;
			}
		}
		if (
			matchesKey(data, "up") ||
			matchesKey(data, "down") ||
			matchesKey(data, "pageUp") ||
			matchesKey(data, "pageDown")
		)
			this.#list.handleInput(data);
		else if (matchesKey(data, "enter") || matchesKey(data, "space")) this.#toggle();
		else if (matchesKey(data, "ctrl+n")) this.#beginCreate();
		else {
			this.#search.handleInput(data);
			this.#filter();
		}
		this.#repaint();
	}
	#renderBody(width: number, rows: number): string[] {
		if (this.#createInput) {
			if (this.#busy)
				return [
					"Creating agent…",
					...this.#stream
						.split("\n")
						.slice(-Math.max(1, rows - 2))
						.map(line => truncateToWidth(line, width)),
				];
			if (this.#createSpec)
				return [
					this.#createSpec.identifier,
					this.#createSpec.whenToUse,
					...this.#createSpec.systemPrompt
						.split("\n")
						.slice(0, rows - 5)
						.map(line => truncateToWidth(line, width)),
					`Save to ${this.#createScope} · tab changes scope · enter saves`,
				];
			return ["Describe the agent · alt+enter generates", ...this.#createInput.render(width)];
		}
		return [...this.#search.render(width), ...this.#list.render(width)].slice(0, rows);
	}
	render(width: number): string[] {
		return [
			...this.#frame.render(
				width,
				this.tui.terminal?.rows || 30,
				this.#entries,
				this.#notice ?? "space/enter toggle · tab scopes · ctrl+n create · esc close",
			),
		];
	}
	nativeSheet(cx: DescribeContext): boolean {
		return !this.#createInput && cx.supports("picker");
	}
	describe(cx?: DescribeContext): NativeNode {
		if (this.#createInput) {
			const body = this.#createSpec
				? [
						text(this.#createSpec.identifier),
						text(this.#createSpec.whenToUse),
						md(this.#createSpec.systemPrompt),
						text(`Save in ${this.#createScope}`),
					]
				: this.#busy
					? [text("Creating agent…"), code(this.#stream)]
					: [this.#createInput];
			return overlayCard("omp.overlay.agents.create", "Create agent", [
				...body,
				...(this.#notice ? [text([span(this.#notice, "warning")])] : []),
				actionBar([
					actionButton("Cancel", "cancel"),
					...(this.#createSpec
						? [actionButton("Change scope", "save-scope"), actionButton("Save", "save")]
						: [actionButton("Generate", "generate")]),
				]),
			]);
		}
		if (!cx?.supports("picker"))
			return describeHubFrame(
				"omp.overlay.agents-hub",
				"Agents",
				describeHubSidebar(this.#entries, this.#scope, () => ({ icon: "", annotation: "" })),
				col([this.#search, this.#list]),
				text("space toggles · ctrl+n creates"),
			);
		if (this.#nativeCache?.version === this.#version) return this.#nativeCache.node;
		const selected = this.#selected();
		const items: TspPickerItem[] = this.#rows.map(agent => ({
			id: agentId(agent),
			label: agent.name,
			detail: agent.description,
			facts: { source: SOURCE_LABEL[agent.source] },
			chips: agent.disabled ? [{ text: "disabled" }] : [],
		}));
		const root = picker(
			{
				title: "Agents",
				subtitle: this.#notice ?? "All agents use the current session model and thinking level",
				noun: "agents",
				size: "screen",
				layout: "rows",
				preview: "side",
				...pickerQuery(this.#search),
				items,
				selected: selected ? agentId(selected) : null,
				columns: [{ id: "source", head: "Source", format: "dim" }],
				scopes: this.#entries.map(entry => ({ id: entry.id, label: entry.label })),
				scope: this.#scope,
				actions: [
					pickerAction("toggle", selected?.disabled ? "Enable" : "Disable", "space"),
					...(this.deps.setAgentAdvisor
						? [pickerAction("advisor", selected?.advisor ? "Disable advisor" : "Enable advisor")]
						: []),
					pickerAction("new", "New agent", "ctrl+n"),
					CLOSE_ACTION,
				],
			},
			selected
				? [
						text(selected.description),
						...(selected.filePath ? [text(selected.filePath)] : []),
						md(selected.systemPrompt),
					]
				: [],
		);
		this.#nativeCache = { version: this.#version, node: root };
		return root;
	}
	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#createInput) {
			if (event.type === "action") {
				if (event.act === "generate") void this.#generate();
				else if (event.act === "save") void this.#save();
				else if (event.act === "save-scope") {
					this.#createScope = this.#createScope === "project" ? "user" : "project";
					this.#repaint();
				} else if (event.act === "cancel") this.#clearCreate();
			}
			return;
		}
		if (event.key === "sidebar" && (event.type === "select" || event.type === "activate")) {
			this.#setScope(event.item);
			return;
		}
		const picked = pickerEvent(event);
		if (!picked) return;
		if (picked.kind !== "action") {
			if (!this.#rows.some(agent => agentId(agent) === picked.item)) return;
			this.#list.setSelectedValue(picked.item);
			if (picked.kind === "activate") this.#toggle();
			this.#repaint();
			return;
		}
		if (picked.act === "scope" && picked.value) this.#setScope(picked.value);
		else if (picked.act === "toggle") this.#toggle();
		else if (picked.act === "advisor") this.#toggleAdvisor();
		else if (picked.act === "new") this.#beginCreate();
		else if (picked.act === "close") this.handleInput("\x1b");
	}
}
