/**
 * Extension loader - loads TypeScript extension modules using native Bun import.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { KeyId } from "@oh-my-pi/pi-tui";
import * as TypeBox from "@sinclair/typebox";
import { type ExtensionModule, extensionModuleCapability } from "../../capability/extension-module";
import { loadSync } from "../../discovery";
import { getExtensionNameFromPath } from "../../discovery/helpers";
import * as piCodingAgent from "../../index";
import { theme } from "../../modes/interactive/theme/theme";
import { createEventBus, type EventBus } from "../event-bus";
import type { ExecOptions } from "../exec";
import { execCommand } from "../exec";
import { logger } from "../logger";
import type {
	AppendEntryHandler,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ExtensionFlag,
	ExtensionShortcut,
	ExtensionUIContext,
	GetActiveToolsHandler,
	GetAllToolsHandler,
	LoadExtensionsResult,
	LoadedExtension,
	MessageRenderer,
	RegisteredCommand,
	RegisteredTool,
	SendMessageHandler,
	SetActiveToolsHandler,
	ToolDefinition,
} from "./types";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizeUnicodeSpaces(str: string): string {
	return str.replace(UNICODE_SPACES, " ");
}

function expandPath(p: string): string {
	const normalized = normalizeUnicodeSpaces(p);
	if (normalized.startsWith("~/")) {
		return path.join(homedir(), normalized.slice(2));
	}
	if (normalized.startsWith("~")) {
		return path.join(homedir(), normalized.slice(1));
	}
	return normalized;
}

function resolvePath(extPath: string, cwd: string): string {
	const expanded = expandPath(extPath);
	if (path.isAbsolute(expanded)) {
		return expanded;
	}
	return path.resolve(cwd, expanded);
}

function createNoOpUIContext(): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: () => {},
		setStatus: () => {},
		setWidget: () => {},
		setTitle: () => {},
		custom: async () => undefined as never,
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		get theme() {
			return theme;
		},
	};
}

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

function createExtensionAPI(
	handlers: Map<string, HandlerFn[]>,
	tools: Map<string, RegisteredTool>,
	cwd: string,
	extensionPath: string,
	eventBus: EventBus,
	_sharedUI: { ui: ExtensionUIContext; hasUI: boolean },
): {
	api: ExtensionAPI;
	messageRenderers: Map<string, MessageRenderer>;
	commands: Map<string, RegisteredCommand>;
	flags: Map<string, ExtensionFlag>;
	flagValues: Map<string, boolean | string>;
	shortcuts: Map<KeyId, ExtensionShortcut>;
	setSendMessageHandler: (handler: SendMessageHandler) => void;
	setAppendEntryHandler: (handler: AppendEntryHandler) => void;
	setGetActiveToolsHandler: (handler: GetActiveToolsHandler) => void;
	setGetAllToolsHandler: (handler: GetAllToolsHandler) => void;
	setSetActiveToolsHandler: (handler: SetActiveToolsHandler) => void;
	setFlagValue: (name: string, value: boolean | string) => void;
} {
	let sendMessageHandler: SendMessageHandler = () => {};
	let appendEntryHandler: AppendEntryHandler = () => {};
	let getActiveToolsHandler: GetActiveToolsHandler = () => [];
	let getAllToolsHandler: GetAllToolsHandler = () => [];
	let setActiveToolsHandler: SetActiveToolsHandler = () => {};

	const messageRenderers = new Map<string, MessageRenderer>();
	const commands = new Map<string, RegisteredCommand>();
	const flags = new Map<string, ExtensionFlag>();
	const flagValues = new Map<string, boolean | string>();
	const shortcuts = new Map<KeyId, ExtensionShortcut>();

	const api = {
		logger,
		typebox: TypeBox,
		pi: piCodingAgent,

		on(event: string, handler: HandlerFn): void {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},

		registerTool(tool: ToolDefinition): void {
			tools.set(tool.name, {
				definition: tool,
				extensionPath,
			});
		},

		registerCommand(name: string, options: { description?: string; handler: RegisteredCommand["handler"] }): void {
			commands.set(name, { name, ...options });
		},

		registerShortcut(
			shortcut: KeyId,
			options: {
				description?: string;
				handler: (ctx: ExtensionContext) => Promise<void> | void;
			},
		): void {
			shortcuts.set(shortcut, { shortcut, extensionPath, ...options });
		},

		registerFlag(
			name: string,
			options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
		): void {
			flags.set(name, { name, extensionPath, ...options });
			if (options.default !== undefined) {
				flagValues.set(name, options.default);
			}
		},

		getFlag(name: string): boolean | string | undefined {
			return flagValues.get(name);
		},

		registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
			messageRenderers.set(customType, renderer as MessageRenderer);
		},

		sendMessage(message, options): void {
			sendMessageHandler(message, options);
		},

		appendEntry(customType: string, data?: unknown): void {
			appendEntryHandler(customType, data);
		},

		exec(command: string, args: string[], options?: ExecOptions) {
			return execCommand(command, args, options?.cwd ?? cwd, options);
		},

		getActiveTools(): string[] {
			return getActiveToolsHandler();
		},

		getAllTools(): string[] {
			return getAllToolsHandler();
		},

		setActiveTools(toolNames: string[]): void {
			setActiveToolsHandler(toolNames);
		},

		events: eventBus,
	} as ExtensionAPI;

	return {
		api,
		messageRenderers,
		commands,
		flags,
		flagValues,
		shortcuts,
		setSendMessageHandler: (handler: SendMessageHandler) => {
			sendMessageHandler = handler;
		},
		setAppendEntryHandler: (handler: AppendEntryHandler) => {
			appendEntryHandler = handler;
		},
		setGetActiveToolsHandler: (handler: GetActiveToolsHandler) => {
			getActiveToolsHandler = handler;
		},
		setGetAllToolsHandler: (handler: GetAllToolsHandler) => {
			getAllToolsHandler = handler;
		},
		setSetActiveToolsHandler: (handler: SetActiveToolsHandler) => {
			setActiveToolsHandler = handler;
		},
		setFlagValue: (name: string, value: boolean | string) => {
			flagValues.set(name, value);
		},
	};
}

async function loadExtension(
	extensionPath: string,
	cwd: string,
	eventBus: EventBus,
	sharedUI: { ui: ExtensionUIContext; hasUI: boolean },
): Promise<{ extension: LoadedExtension | null; error: string | null }> {
	const resolvedPath = resolvePath(extensionPath, cwd);

	try {
		const module = await import(resolvedPath);
		const factory = (module.default ?? module) as ExtensionFactory;

		if (typeof factory !== "function") {
			return { extension: null, error: "Extension must export a default function" };
		}

		const handlers = new Map<string, HandlerFn[]>();
		const tools = new Map<string, RegisteredTool>();
		const {
			api,
			messageRenderers,
			commands,
			flags,
			flagValues,
			shortcuts,
			setSendMessageHandler,
			setAppendEntryHandler,
			setGetActiveToolsHandler,
			setGetAllToolsHandler,
			setSetActiveToolsHandler,
			setFlagValue,
		} = createExtensionAPI(handlers, tools, cwd, extensionPath, eventBus, sharedUI);

		factory(api);

		return {
			extension: {
				path: extensionPath,
				resolvedPath,
				handlers,
				tools,
				messageRenderers,
				commands,
				flags,
				flagValues,
				shortcuts,
				setSendMessageHandler,
				setAppendEntryHandler,
				setGetActiveToolsHandler,
				setGetAllToolsHandler,
				setSetActiveToolsHandler,
				setFlagValue,
			},
			error: null,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { extension: null, error: `Failed to load extension: ${message}` };
	}
}

/**
 * Create a LoadedExtension from an inline factory function.
 */
export function loadExtensionFromFactory(
	factory: ExtensionFactory,
	cwd: string,
	eventBus: EventBus,
	sharedUI: { ui: ExtensionUIContext; hasUI: boolean },
	name = "<inline>",
): LoadedExtension {
	const handlers = new Map<string, HandlerFn[]>();
	const tools = new Map<string, RegisteredTool>();
	const {
		api,
		messageRenderers,
		commands,
		flags,
		flagValues,
		shortcuts,
		setSendMessageHandler,
		setAppendEntryHandler,
		setGetActiveToolsHandler,
		setGetAllToolsHandler,
		setSetActiveToolsHandler,
		setFlagValue,
	} = createExtensionAPI(handlers, tools, cwd, name, eventBus, sharedUI);

	factory(api);

	return {
		path: name,
		resolvedPath: name,
		handlers,
		tools,
		messageRenderers,
		commands,
		flags,
		flagValues,
		shortcuts,
		setSendMessageHandler,
		setAppendEntryHandler,
		setGetActiveToolsHandler,
		setGetAllToolsHandler,
		setSetActiveToolsHandler,
		setFlagValue,
	};
}

/**
 * Load extensions from paths.
 */
export async function loadExtensions(paths: string[], cwd: string, eventBus?: EventBus): Promise<LoadExtensionsResult> {
	const extensions: LoadedExtension[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const resolvedEventBus = eventBus ?? createEventBus();
	const sharedUI = { ui: createNoOpUIContext(), hasUI: false };

	for (const extPath of paths) {
		const { extension, error } = await loadExtension(extPath, cwd, resolvedEventBus, sharedUI);

		if (error) {
			errors.push({ path: extPath, error });
			continue;
		}

		if (extension) {
			extensions.push(extension);
		}
	}

	return {
		extensions,
		errors,
		setUIContext(uiContext, hasUI) {
			sharedUI.ui = uiContext;
			sharedUI.hasUI = hasUI;
		},
	};
}

interface ExtensionManifest {
	extensions?: string[];
	themes?: string[];
	skills?: string[];
}

function readExtensionManifest(packageJsonPath: string): ExtensionManifest | null {
	try {
		const content = readFileSync(packageJsonPath, "utf-8");
		const pkg = JSON.parse(content) as { omp?: ExtensionManifest; pi?: ExtensionManifest };
		const manifest = pkg.omp ?? pkg.pi;
		if (manifest && typeof manifest === "object") {
			return manifest;
		}
		return null;
	} catch {
		return null;
	}
}

function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

/**
 * Discover extensions in a directory.
 *
 * Discovery rules:
 * 1. Direct files: `extensions/*.ts` or `*.js` → load
 * 2. Subdirectory with index: `extensions/<ext>/index.ts` or `index.js` → load
 * 3. Subdirectory with package.json: `extensions/<ext>/package.json` with "omp"/"pi" field → load declared paths
 *
 * No recursion beyond one level. Complex packages must use package.json manifest.
 */
function discoverExtensionsInDir(dir: string): string[] {
	if (!existsSync(dir)) {
		return [];
	}

	const discovered: string[] = [];

	try {
		const entries = readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			const entryPath = path.join(dir, entry.name);

			// 1. Direct files: *.ts or *.js
			if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
				discovered.push(entryPath);
				continue;
			}

			// 2 & 3. Subdirectories
			if (entry.isDirectory() || entry.isSymbolicLink()) {
				// Check for package.json with "omp"/"pi" field first
				const packageJsonPath = path.join(entryPath, "package.json");
				if (existsSync(packageJsonPath)) {
					const manifest = readExtensionManifest(packageJsonPath);
					if (manifest?.extensions) {
						// Load paths declared in manifest (relative to package.json dir)
						for (const extPath of manifest.extensions) {
							const resolvedExtPath = path.resolve(entryPath, extPath);
							if (existsSync(resolvedExtPath)) {
								discovered.push(resolvedExtPath);
							}
						}
						continue;
					}
				}

				// Check for index.ts or index.js
				const indexTs = path.join(entryPath, "index.ts");
				const indexJs = path.join(entryPath, "index.js");
				if (existsSync(indexTs)) {
					discovered.push(indexTs);
				} else if (existsSync(indexJs)) {
					discovered.push(indexJs);
				}
			}
		}
	} catch {
		return [];
	}

	return discovered;
}

/**
 * Discover and load extensions from standard locations.
 */
export async function discoverAndLoadExtensions(
	configuredPaths: string[],
	cwd: string,
	eventBus?: EventBus,
	disabledExtensionIds: string[] = [],
): Promise<LoadExtensionsResult> {
	const allPaths: string[] = [];
	const seen = new Set<string>();
	const disabled = new Set(disabledExtensionIds);

	const isDisabledName = (name: string): boolean => disabled.has(`extension-module:${name}`);

	const addPath = (extPath: string): void => {
		const resolved = path.resolve(extPath);
		if (!seen.has(resolved)) {
			seen.add(resolved);
			allPaths.push(extPath);
		}
	};

	const addPaths = (paths: string[]) => {
		for (const extPath of paths) {
			if (isDisabledName(getExtensionNameFromPath(extPath))) continue;
			addPath(extPath);
		}
	};

	// 1. Discover extension modules via capability API (native .omp/.pi only)
	const discovered = loadSync<ExtensionModule>(extensionModuleCapability.id, { cwd });
	for (const ext of discovered.items) {
		if (ext._source.provider !== "native") continue;
		if (isDisabledName(ext.name)) continue;
		addPath(ext.path);
	}

	// 2. Explicitly configured paths
	for (const configuredPath of configuredPaths) {
		const resolved = resolvePath(configuredPath, cwd);
		if (existsSync(resolved) && statSync(resolved).isDirectory()) {
			addPaths(discoverExtensionsInDir(resolved));
		} else {
			addPath(resolved);
		}
	}

	return loadExtensions(allPaths, cwd, eventBus);
}
