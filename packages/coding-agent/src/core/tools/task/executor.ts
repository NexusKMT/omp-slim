/**
 * Subprocess execution for subagents.
 *
 * Spawns `omp` in JSON mode to execute tasks with isolated context.
 * Parses JSON events for progress tracking.
 */

import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ensureArtifactsDir, getArtifactPaths } from "./artifacts";
import { resolveModelPattern } from "./model-resolver";
import { resolveOmpCommand } from "./omp-command";
import { subprocessToolRegistry } from "./subprocess-tool-registry";
import {
	type AgentDefinition,
	type AgentProgress,
	MAX_OUTPUT_BYTES,
	MAX_OUTPUT_LINES,
	OMP_BLOCKED_AGENT_ENV,
	OMP_SPAWNS_ENV,
	type SingleResult,
} from "./types";

/** Options for subprocess execution */
export interface ExecutorOptions {
	cwd: string;
	agent: AgentDefinition;
	task: string;
	description?: string;
	index: number;
	context?: string;
	modelOverride?: string;
	signal?: AbortSignal;
	onProgress?: (progress: AgentProgress) => void;
	sessionFile?: string | null;
	persistArtifacts?: boolean;
	artifactsDir?: string;
}

/**
 * Truncate output to byte and line limits.
 */
function truncateOutput(output: string): { text: string; truncated: boolean } {
	let truncated = false;
	let byteBudget = MAX_OUTPUT_BYTES;
	let lineBudget = MAX_OUTPUT_LINES;

	let i = 0;
	let lastNewlineIndex = -1;
	while (i < output.length && byteBudget > 0) {
		const ch = output.charCodeAt(i);
		byteBudget--;

		if (ch === 10 /* \n */) {
			lineBudget--;
			lastNewlineIndex = i;
			if (lineBudget <= 0) {
				truncated = true;
				break;
			}
		}

		i++;
	}

	if (i < output.length) {
		truncated = true;
	}

	if (truncated && lineBudget <= 0 && lastNewlineIndex >= 0) {
		output = output.slice(0, lastNewlineIndex);
	} else {
		output = output.slice(0, i);
	}

	return { text: output, truncated };
}

/**
 * Extract a short preview from tool args for display.
 */
function extractToolArgsPreview(args: Record<string, unknown>): string {
	// Priority order for preview
	const previewKeys = ["command", "file_path", "path", "pattern", "query", "url", "task", "prompt"];

	for (const key of previewKeys) {
		if (args[key] && typeof args[key] === "string") {
			const value = args[key] as string;
			return value.length > 60 ? `${value.slice(0, 57)}...` : value;
		}
	}

	return "";
}

function getNumberField(record: Record<string, unknown>, key: string): number | undefined {
	if (!Object.hasOwn(record, key)) return undefined;
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function firstNumberField(record: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = getNumberField(record, key);
		if (value !== undefined) return value;
	}
	return undefined;
}

/**
 * Normalize usage objects from different event formats.
 */
function getUsageTokens(usage: unknown): number {
	if (!usage || typeof usage !== "object") return 0;
	const record = usage as Record<string, unknown>;

	const totalTokens = firstNumberField(record, ["totalTokens", "total_tokens"]);
	if (totalTokens !== undefined && totalTokens > 0) return totalTokens;

	const input = firstNumberField(record, ["input", "input_tokens", "inputTokens"]) ?? 0;
	const output = firstNumberField(record, ["output", "output_tokens", "outputTokens"]) ?? 0;
	const cacheRead = firstNumberField(record, ["cacheRead", "cache_read", "cacheReadTokens"]) ?? 0;
	const cacheWrite = firstNumberField(record, ["cacheWrite", "cache_write", "cacheWriteTokens"]) ?? 0;

	return input + output + cacheRead + cacheWrite;
}

/**
 * Run a single agent as a subprocess.
 */
export async function runSubprocess(options: ExecutorOptions): Promise<SingleResult> {
	const { cwd, agent, task, index, context, modelOverride, signal, onProgress } = options;
	const startTime = Date.now();

	// Initialize progress
	const progress: AgentProgress = {
		index,
		agent: agent.name,
		agentSource: agent.source,
		status: "running",
		task,
		description: options.description,
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		tokens: 0,
		durationMs: 0,
		modelOverride,
	};

	// Check if already aborted
	if (signal?.aborted) {
		return {
			index,
			agent: agent.name,
			agentSource: agent.source,
			task,
			description: options.description,
			exitCode: 1,
			output: "",
			stderr: "Aborted before start",
			truncated: false,
			durationMs: 0,
			tokens: 0,
			modelOverride,
			error: "Aborted",
		};
	}

	// Write system prompt to temp file
	const tempDir = tmpdir();
	const promptFile = path.join(
		tempDir,
		`omp-agent-${agent.name}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`,
	);

	try {
		writeFileSync(promptFile, agent.systemPrompt, "utf-8");
	} catch (err) {
		return {
			index,
			agent: agent.name,
			agentSource: agent.source,
			task,
			description: options.description,
			exitCode: 1,
			output: "",
			stderr: `Failed to write prompt file: ${err}`,
			truncated: false,
			durationMs: Date.now() - startTime,
			tokens: 0,
			modelOverride,
			error: `Failed to write prompt file: ${err}`,
		};
	}

	// Build full task with context
	const fullTask = context ? `${context}\n\n${task}` : task;

	// Set up artifact paths and write input file upfront if artifacts dir provided
	let artifactPaths: { inputPath: string; outputPath: string; jsonlPath: string } | undefined;
	let subtaskSessionFile: string | undefined;

	if (options.artifactsDir) {
		ensureArtifactsDir(options.artifactsDir);
		artifactPaths = getArtifactPaths(options.artifactsDir, agent.name, index);
		subtaskSessionFile = artifactPaths.jsonlPath;

		// Write input file immediately (real-time visibility)
		try {
			writeFileSync(artifactPaths.inputPath, fullTask, "utf-8");
		} catch {
			// Non-fatal, continue without input artifact
		}
	}

	// Build args
	const args: string[] = ["--mode", "json", "--non-interactive"];

	// Add system prompt
	args.push("--append-system-prompt", promptFile);

	// Add tools if specified
	if (agent.tools && agent.tools.length > 0) {
		let toolList = agent.tools;
		// Auto-include task tool if spawns defined but task not in tools
		if (agent.spawns !== undefined && !toolList.includes("task")) {
			toolList = [...toolList, "task"];
		}
		args.push("--tools", toolList.join(","));
	}

	// Resolve and add model
	const resolvedModel = resolveModelPattern(modelOverride || agent.model);
	if (resolvedModel) {
		args.push("--model", resolvedModel);
	}

	// Add session options - use subtask-specific session file for real-time streaming
	if (subtaskSessionFile) {
		args.push("--session", subtaskSessionFile);
	} else if (options.sessionFile) {
		args.push("--session", options.sessionFile);
	} else {
		args.push("--no-session");
	}

	// Add task as prompt
	args.push("--prompt", fullTask);

	// Set up environment - block same-agent recursion unless explicitly recursive
	const env = { ...process.env };
	if (!agent.recursive) {
		env[OMP_BLOCKED_AGENT_ENV] = agent.name;
	}

	// Propagate spawn restrictions to subprocess
	if (agent.spawns === undefined) {
		env[OMP_SPAWNS_ENV] = ""; // No spawns = deny all
	} else if (agent.spawns === "*") {
		env[OMP_SPAWNS_ENV] = "*";
	} else {
		env[OMP_SPAWNS_ENV] = agent.spawns.join(",");
	}

	// Spawn subprocess
	const ompCommand = resolveOmpCommand();
	const proc = Bun.spawn([ompCommand.cmd, ...ompCommand.args, ...args], {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env,
	});

	let output = "";
	let stderr = "";
	let finalOutput = "";
	let resolved = false;
	let pendingTermination = false; // Set when shouldTerminate fires, wait for message_end

	// Accumulate usage incrementally from message_end events (no memory for streaming events)
	const accumulatedUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	let hasUsage = false;

	// Handle abort signal
	const onAbort = () => {
		if (!resolved) {
			proc.kill(15); // SIGTERM
		}
	};
	if (signal) {
		signal.addEventListener("abort", onAbort, { once: true });
	}

	// Parse JSON events from stdout
	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	const processLine = (line: string) => {
		if (resolved) return;

		try {
			const event = JSON.parse(line);
			// Events are written to subtask session file by subprocess - no need to accumulate in memory
			const now = Date.now();

			switch (event.type) {
				case "tool_execution_start":
					progress.toolCount++;
					progress.currentTool = event.toolName;
					progress.currentToolArgs = extractToolArgsPreview(event.toolArgs || event.args || {});
					progress.currentToolStartMs = now;
					break;

				case "tool_execution_end": {
					if (progress.currentTool) {
						progress.recentTools.unshift({
							tool: progress.currentTool,
							args: progress.currentToolArgs || "",
							endMs: now,
						});
						// Keep only last 5
						if (progress.recentTools.length > 5) {
							progress.recentTools.pop();
						}
					}
					progress.currentTool = undefined;
					progress.currentToolArgs = undefined;
					progress.currentToolStartMs = undefined;

					// Check for registered subprocess tool handler
					const handler = subprocessToolRegistry.getHandler(event.toolName);
					if (handler) {
						// Extract data using handler
						if (handler.extractData) {
							const data = handler.extractData({
								toolName: event.toolName,
								toolCallId: event.toolCallId,
								args: event.args,
								result: event.result,
								isError: event.isError,
							});
							if (data !== undefined) {
								progress.extractedToolData = progress.extractedToolData || {};
								progress.extractedToolData[event.toolName] = progress.extractedToolData[event.toolName] || [];
								progress.extractedToolData[event.toolName].push(data);
							}
						}

						// Check if handler wants to terminate subprocess
						if (
							handler.shouldTerminate?.({
								toolName: event.toolName,
								toolCallId: event.toolCallId,
								args: event.args,
								result: event.result,
								isError: event.isError,
							})
						) {
							// Don't kill immediately - wait for message_end to get token counts
							pendingTermination = true;
							// Safety timeout in case message_end never arrives
							setTimeout(() => {
								if (!resolved) {
									resolved = true;
									proc.kill(15); // SIGTERM
								}
							}, 2000);
						}
					}
					break;
				}

				case "message_update": {
					// Extract text for progress display only (replace, don't accumulate)
					const updateContent = event.message?.content || event.content;
					if (updateContent && Array.isArray(updateContent)) {
						const allText: string[] = [];
						for (const block of updateContent) {
							if (block.type === "text" && block.text) {
								const lines = block.text.split("\n").filter((l: string) => l.trim());
								allText.push(...lines);
							}
						}
						// Show last 8 lines from current state (not accumulated)
						progress.recentOutput = allText.slice(-8).reverse();
					}
					break;
				}

				case "message_end": {
					// Extract text from assistant and toolResult messages (not user prompts)
					const role = event.message?.role;
					if (role === "assistant") {
						const messageContent = event.message?.content || event.content;
						if (messageContent && Array.isArray(messageContent)) {
							for (const block of messageContent) {
								if (block.type === "text" && block.text) {
									output += block.text;
								}
							}
						}
					}
					// Extract and accumulate usage (prefer message.usage, fallback to event.usage)
					const messageUsage = event.message?.usage || event.usage;
					if (messageUsage) {
						// Only count assistant messages (not tool results, etc.)
						const role = event.message?.role;
						if (
							role === "assistant" &&
							event.message?.stopReason !== "aborted" &&
							event.message?.stopReason !== "error"
						) {
							hasUsage = true;
							accumulatedUsage.input += messageUsage.input ?? 0;
							accumulatedUsage.output += messageUsage.output ?? 0;
							accumulatedUsage.cacheRead += messageUsage.cacheRead ?? 0;
							accumulatedUsage.cacheWrite += messageUsage.cacheWrite ?? 0;
							accumulatedUsage.totalTokens += messageUsage.totalTokens ?? 0;
							if (messageUsage.cost) {
								accumulatedUsage.cost.input += messageUsage.cost.input ?? 0;
								accumulatedUsage.cost.output += messageUsage.cost.output ?? 0;
								accumulatedUsage.cost.cacheRead += messageUsage.cost.cacheRead ?? 0;
								accumulatedUsage.cost.cacheWrite += messageUsage.cost.cacheWrite ?? 0;
								accumulatedUsage.cost.total += messageUsage.cost.total ?? 0;
							}
						}
						// Accumulate tokens for progress display
						progress.tokens += getUsageTokens(messageUsage);
					}
					// If pending termination, now we have tokens - terminate
					if (pendingTermination && !resolved) {
						resolved = true;
						proc.kill(15); // SIGTERM
					}
					break;
				}

				case "agent_end":
					// Extract final content from messages array
					if (event.messages && Array.isArray(event.messages)) {
						for (const msg of event.messages) {
							if (msg.content && Array.isArray(msg.content)) {
								for (const block of msg.content) {
									if (block.type === "text" && block.text) {
										finalOutput += block.text;
									}
								}
							}
						}
					}
					break;
			}

			progress.durationMs = now - startTime;
			// Clone progress object before passing to callback to prevent mutation during render
			onProgress?.({ ...progress });
		} catch {
			// Ignore non-JSON lines
		}
	};

	// Read stdout asynchronously
	const stdoutDone = (async () => {
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) {
					processLine(line);
				}
			}
			// Process remaining buffer
			if (buffer.trim()) {
				processLine(buffer);
			}
		} catch {
			// Ignore read errors
		}
	})();

	// Capture stderr - Bun.spawn returns ReadableStream, convert to text
	const stderrDone = (async () => {
		try {
			const stderrReader = proc.stderr.getReader();
			const stderrDecoder = new TextDecoder();
			while (true) {
				const { done, value } = await stderrReader.read();
				if (done) break;
				stderr += stderrDecoder.decode(value, { stream: true });
			}
		} catch {
			// Ignore stderr read errors
		}
	})();

	// Wait for process and stream readers to finish
	const exitCode = await proc.exited;
	await Promise.all([stdoutDone, stderrDone]);
	resolved = true;

	// Cleanup
	if (signal) {
		signal.removeEventListener("abort", onAbort);
	}

	try {
		if (existsSync(promptFile)) {
			unlinkSync(promptFile);
		}
	} catch {
		// Ignore cleanup errors
	}

	// Use final output if available, otherwise accumulated output
	const rawOutput = finalOutput || output;
	const { text: truncatedOutput, truncated } = truncateOutput(rawOutput);

	// Write output artifact (input and jsonl already written in real-time)
	// Compute output metadata for Output tool integration
	let outputMeta: { lineCount: number; charCount: number } | undefined;
	if (artifactPaths) {
		try {
			writeFileSync(artifactPaths.outputPath, rawOutput, "utf-8");
			outputMeta = {
				lineCount: rawOutput.split("\n").length,
				charCount: rawOutput.length,
			};
		} catch {
			// Non-fatal
		}
	}

	// Update final progress
	const wasAborted = signal?.aborted ?? false;
	progress.status = wasAborted ? "aborted" : exitCode === 0 ? "completed" : "failed";
	progress.durationMs = Date.now() - startTime;
	onProgress?.(progress);

	return {
		index,
		agent: agent.name,
		agentSource: agent.source,
		task,
		description: options.description,
		exitCode,
		output: truncatedOutput,
		stderr,
		truncated,
		durationMs: Date.now() - startTime,
		tokens: progress.tokens,
		modelOverride,
		error: exitCode !== 0 && stderr ? stderr : undefined,
		aborted: wasAborted,
		usage: hasUsage ? accumulatedUsage : undefined,
		artifactPaths,
		extractedToolData: progress.extractedToolData,
		outputMeta,
	};
}
