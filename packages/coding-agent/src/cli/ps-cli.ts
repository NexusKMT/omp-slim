/**
 * CLI handler for `omp ps` — inspect and control processes supervised by the
 * daemon broker from outside the harness.
 *
 * Listing never spawns a broker: live scopes are queried over the broker
 * socket, dead scopes are read from the persisted per-daemon `meta.json`
 * snapshots. Actions (`stop`, `kill`, `restart`, `logs`, `info`) connect
 * through the regular client, which revives a dead broker so it can re-adopt
 * detached daemons before acting on them.
 */
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	formatDuration,
	getDaemonRuntimeRoot,
	getGlobalDaemonRuntimeDir,
	getGlobalDaemonRuntimeRoot,
	getProjectDir,
	isEnoent,
} from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import {
	closeDaemonClients,
	createDaemonBrokerClient,
	type DaemonBrokerClient,
	daemonClientForGlobal,
	daemonClientForProject,
} from "../launch/client";
import { canonicalProjectDir, daemonRuntimeDir, readDaemonScopeMeta } from "../launch/paths";
import { readLiveDaemonBrokerPid } from "../launch/presence";
import {
	type DaemonSnapshot,
	type DaemonSpec,
	type DaemonState,
	parseDaemonSnapshot,
	parseDaemonSpec,
} from "../launch/protocol";

export type PsAction = "list" | "info" | "logs" | "stop" | "kill" | "restart";

export interface PsCommandArgs {
	action: PsAction;
	/** Daemon name; required for every action except `list`. */
	name?: string;
	flags: {
		/** list: include every project and global service scope on this machine. */
		all: boolean;
		json: boolean;
		/** Target another project directory instead of the current one. */
		dir?: string;
		/** Target a machine-global service scope (e.g. browser-relay). */
		global?: string;
		/** logs: keep streaming new output. */
		follow: boolean;
		/** logs: read from the beginning instead of the tail. */
		head: boolean;
		/** logs: number of lines. */
		lines?: number;
		/** logs: regex filter. */
		grep?: string;
		/** stop: grace period in seconds before hard kill. */
		timeout?: number;
	};
}

/** One broker scope: a project runtime dir or a machine-global service dir. */
interface PsScope {
	kind: "project" | "global";
	runtimeDir: string;
	/** Canonical project dir when known; used to connect and displayed as the scope label. */
	projectDir?: string;
	/** Global service name (`kind === "global"`). */
	service?: string;
	/** Live broker PID; undefined when no broker owns the scope. */
	brokerPid?: number;
}

interface PsDaemonRow {
	snapshot: DaemonSnapshot;
	/** Launch command from the persisted spec, when readable. */
	command?: string;
	cwd?: string;
	/** False when the snapshot came from disk with no live broker supervising it. */
	supervised: boolean;
}

interface PsScopeReport {
	scope: PsScope;
	daemons: PsDaemonRow[];
}

const PROJECT_SCOPE_KEY = /^[0-9a-f]{16}$/;
/** Hard SIGTERM->SIGKILL grace used by `kill`; effectively immediate. */
const KILL_GRACE_MS = 100;
const TERMINAL_STATES: Partial<Record<DaemonState, true>> = { exited: true, failed: true };

export async function runPsCommand(cmd: PsCommandArgs): Promise<void> {
	try {
		if (cmd.action === "list") {
			await runList(cmd);
			return;
		}
		if (!cmd.name) {
			console.error(chalk.red(`${cmd.action} requires a process name. Run \`omp ps\` to list processes.`));
			process.exitCode = 1;
			return;
		}
		await runAction(cmd, cmd.name);
	} finally {
		await closeDaemonClients();
	}
}

// ---------------------------------------------------------------------------
// Scope discovery
// ---------------------------------------------------------------------------

/** The single scope explicitly targeted by `--global`/`--dir` (or the current project). */
async function targetScope(flags: PsCommandArgs["flags"]): Promise<PsScope> {
	if (flags.global) {
		const runtimeDir = await canonicalRuntimeDir(getGlobalDaemonRuntimeDir(flags.global));
		return {
			kind: "global",
			runtimeDir,
			service: flags.global,
			brokerPid: await readLiveDaemonBrokerPid(runtimeDir),
		};
	}
	const projectDir = await canonicalProjectDir(flags.dir ?? getProjectDir());
	const runtimeDir = daemonRuntimeDir(projectDir);
	return { kind: "project", runtimeDir, projectDir, brokerPid: await readLiveDaemonBrokerPid(runtimeDir) };
}

async function canonicalRuntimeDir(dir: string): Promise<string> {
	try {
		return await fs.realpath(dir);
	} catch {
		return path.resolve(dir);
	}
}

/** Every scope on this machine: hash-keyed project scopes plus global service scopes. */
async function discoverScopes(): Promise<PsScope[]> {
	const scopes: PsScope[] = [];
	for (const entry of await readdirQuiet(getDaemonRuntimeRoot())) {
		if (!entry.isDirectory() || !PROJECT_SCOPE_KEY.test(entry.name)) continue;
		const runtimeDir = path.join(getDaemonRuntimeRoot(), entry.name);
		scopes.push({
			kind: "project",
			runtimeDir,
			projectDir: await resolveScopeProjectDir(runtimeDir),
			brokerPid: await readLiveDaemonBrokerPid(runtimeDir),
		});
	}
	for (const entry of await readdirQuiet(getGlobalDaemonRuntimeRoot())) {
		if (!entry.isDirectory()) continue;
		const runtimeDir = await canonicalRuntimeDir(path.join(getGlobalDaemonRuntimeRoot(), entry.name));
		scopes.push({
			kind: "global",
			runtimeDir,
			service: entry.name,
			brokerPid: await readLiveDaemonBrokerPid(runtimeDir),
		});
	}
	return scopes;
}

async function readdirQuiet(dir: string): Promise<Dirent[]> {
	try {
		return await fs.readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
}

/**
 * Map a hash-keyed project runtime dir back to its project directory:
 * broker-written `scope.json` first, then any registered client presence file
 * (covers brokers started before scope metadata existed).
 */
async function resolveScopeProjectDir(runtimeDir: string): Promise<string | undefined> {
	const recorded = await readDaemonScopeMeta(runtimeDir);
	if (recorded) return recorded;
	for (const entry of await readdirQuiet(path.join(runtimeDir, "clients"))) {
		try {
			const decoded: unknown = await Bun.file(path.join(runtimeDir, "clients", entry.name)).json();
			if (
				typeof decoded === "object" &&
				decoded !== null &&
				"projectDir" in decoded &&
				typeof decoded.projectDir === "string"
			) {
				return decoded.projectDir;
			}
		} catch {
			// Unreadable presence files are skipped; the scope stays unlabeled.
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Snapshot collection
// ---------------------------------------------------------------------------

/** Persisted `{snapshot, spec}` pairs from `<runtimeDir>/daemons/<name>/meta.json`. */
async function readPersistedDaemons(
	runtimeDir: string,
): Promise<Map<string, { snapshot: DaemonSnapshot; spec: DaemonSpec }>> {
	const persisted = new Map<string, { snapshot: DaemonSnapshot; spec: DaemonSpec }>();
	const root = path.join(runtimeDir, "daemons");
	for (const entry of await readdirQuiet(root)) {
		if (!entry.isDirectory()) continue;
		try {
			const decoded: unknown = await Bun.file(path.join(root, entry.name, "meta.json")).json();
			if (typeof decoded !== "object" || decoded === null || !("daemon" in decoded) || !("spec" in decoded))
				continue;
			const snapshot = parseDaemonSnapshot(decoded.daemon);
			persisted.set(snapshot.name, { snapshot, spec: parseDaemonSpec(decoded.spec) });
		} catch {
			// Malformed or torn metadata is skipped; the broker rewrites it on next start.
		}
	}
	return persisted;
}

function processAlive(pid: number | undefined): boolean {
	if (pid === undefined) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Collect daemons for one scope. Live brokers are authoritative; dead scopes
 * fall back to persisted snapshots, downgrading non-detached "running" records
 * to exited (their broker took them down with it) and flagging detached
 * survivors as unsupervised.
 */
async function collectScope(scope: PsScope): Promise<PsScopeReport> {
	const persisted = await readPersistedDaemons(scope.runtimeDir);
	if (scope.brokerPid !== undefined) {
		const connectDir = scope.projectDir ?? (process.platform === "win32" ? undefined : scope.runtimeDir);
		if (connectDir !== undefined) {
			try {
				const client = await createDaemonBrokerClient(connectDir, { runtimeDir: scope.runtimeDir });
				try {
					if (scope.projectDir === undefined) {
						const ping = await client.request({ op: "ping" });
						if (ping.op === "ping") scope.projectDir = ping.projectDir;
					}
					const result = await client.request({ op: "list" });
					if (result.op !== "list") throw new Error(`Unexpected broker response ${result.op}`);
					return {
						scope,
						daemons: result.daemons.map(snapshot => ({
							snapshot,
							command: formatCommand(persisted.get(snapshot.name)?.spec),
							cwd: persisted.get(snapshot.name)?.spec.cwd,
							supervised: true,
						})),
					};
				} finally {
					client.close();
				}
			} catch {
				// Broker died or refused mid-query; fall through to the offline view.
			}
		}
	}
	const daemons: PsDaemonRow[] = [];
	for (const { snapshot, spec } of persisted.values()) {
		const row: PsDaemonRow = { snapshot, command: formatCommand(spec), cwd: spec.cwd, supervised: false };
		if (!TERMINAL_STATES[snapshot.state]) {
			const survivor = spec.detached && snapshot.state !== "stopping" && processAlive(snapshot.pid);
			if (!survivor) {
				// The broker died and took its non-detached children with it.
				row.snapshot = { ...snapshot, state: "exited", exitReason: snapshot.exitReason ?? "broker exited" };
			}
		}
		daemons.push(row);
	}
	daemons.sort(compareRows);
	return { scope, daemons };
}

function compareRows(a: PsDaemonRow, b: PsDaemonRow): number {
	const aTerminal = TERMINAL_STATES[a.snapshot.state] === true;
	const bTerminal = TERMINAL_STATES[b.snapshot.state] === true;
	if (aTerminal !== bTerminal) return aTerminal ? 1 : -1;
	return a.snapshot.name.localeCompare(b.snapshot.name);
}

function formatCommand(spec: DaemonSpec | undefined): string | undefined {
	return spec ? [spec.application, ...spec.args].join(" ") : undefined;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function runList(cmd: PsCommandArgs): Promise<void> {
	const scopes = cmd.flags.all ? await discoverScopes() : [await targetScope(cmd.flags)];
	const reports = (await Promise.all(scopes.map(collectScope))).filter(
		report => !cmd.flags.all || report.daemons.length > 0 || report.scope.brokerPid !== undefined,
	);
	if (cmd.flags.json) {
		console.log(
			JSON.stringify(
				reports.map(({ scope, daemons }) => ({
					kind: scope.kind,
					projectDir: scope.projectDir,
					service: scope.service,
					runtimeDir: scope.runtimeDir,
					brokerPid: scope.brokerPid,
					daemons: daemons.map(row => ({
						...row.snapshot,
						command: row.command,
						cwd: row.cwd,
						supervised: row.supervised,
					})),
				})),
				null,
				2,
			),
		);
		return;
	}
	if (reports.length === 0) {
		console.log(chalk.dim("No daemon broker scopes found."));
		return;
	}
	let first = true;
	for (const report of reports) {
		if (!first) console.log("");
		first = false;
		console.log(scopeHeader(report.scope));
		if (report.daemons.length === 0) {
			console.log(chalk.dim("  no processes"));
			continue;
		}
		printTable(report.daemons);
	}
	if (!cmd.flags.all) {
		console.log(chalk.dim("\nUse --all to include other projects and global services."));
	}
}

function scopeHeader(scope: PsScope): string {
	const label =
		scope.kind === "global"
			? `global ${chalk.bold(scope.service ?? path.basename(scope.runtimeDir))}`
			: `project ${chalk.bold(scope.projectDir ?? path.basename(scope.runtimeDir))}`;
	const broker =
		scope.brokerPid !== undefined ? chalk.green(`broker pid ${scope.brokerPid}`) : chalk.dim("broker not running");
	return `${label} ${chalk.dim("—")} ${broker}`;
}

function stateCell(row: PsDaemonRow): string {
	const { snapshot } = row;
	let text: string = snapshot.state;
	if (TERMINAL_STATES[snapshot.state] && snapshot.exitCode !== undefined) text += `(${snapshot.exitCode})`;
	const paint =
		snapshot.state === "ready" || snapshot.state === "running"
			? chalk.green
			: snapshot.state === "failed"
				? chalk.red
				: TERMINAL_STATES[snapshot.state]
					? chalk.dim
					: chalk.yellow;
	return paint(text);
}

function flagsCell(row: PsDaemonRow): string {
	const parts: string[] = [];
	if (row.snapshot.detached) parts.push("detached");
	else if (row.snapshot.persist) parts.push("persist");
	if (!row.supervised && !TERMINAL_STATES[row.snapshot.state]) parts.push("unsupervised");
	return parts.join(",");
}

function uptimeCell(snapshot: DaemonSnapshot): string {
	if (TERMINAL_STATES[snapshot.state]) return "-";
	return formatDuration(Date.now() - snapshot.startedAt);
}

function printTable(rows: PsDaemonRow[]): void {
	const header = ["NAME", "STATE", "PID", "UPTIME", "RESTARTS", "FLAGS", "COMMAND"];
	const cells = rows.map(row => [
		row.snapshot.name,
		stateCell(row),
		row.snapshot.pid !== undefined && !TERMINAL_STATES[row.snapshot.state] ? String(row.snapshot.pid) : "-",
		uptimeCell(row.snapshot),
		String(row.snapshot.restartCount),
		flagsCell(row),
		row.command ?? "",
	]);
	const widths = header.map((title, column) =>
		Math.max(title.length, ...cells.map(row => Bun.stringWidth(row[column]))),
	);
	const render = (row: string[]): string =>
		`  ${row.map((cell, column) => cell + " ".repeat(Math.max(0, widths[column] - Bun.stringWidth(cell)))).join("  ")}`.trimEnd();
	console.log(chalk.dim(render(header)));
	for (const [index, row] of cells.entries()) {
		const line = render(row);
		console.log(TERMINAL_STATES[rows[index].snapshot.state] ? chalk.dim(line) : line);
	}
}

// ---------------------------------------------------------------------------
// Named actions
// ---------------------------------------------------------------------------

async function actionClient(flags: PsCommandArgs["flags"]): Promise<DaemonBrokerClient> {
	if (flags.global) return daemonClientForGlobal(flags.global);
	return daemonClientForProject(flags.dir ?? getProjectDir());
}

function daemonLabel(daemon: DaemonSnapshot): string {
	const pid = daemon.pid === undefined ? "" : ` pid=${daemon.pid}`;
	const exit = daemon.exitCode === undefined ? "" : ` exit=${daemon.exitCode}`;
	return `${daemon.name}: ${daemon.state}${pid}${exit}`;
}

async function runAction(cmd: PsCommandArgs, name: string): Promise<void> {
	const client = await actionClient(cmd.flags);
	try {
		switch (cmd.action) {
			case "info": {
				const result = await client.request({ op: "describe", name });
				if (result.op !== "describe") throw new Error(`Unexpected broker response ${result.op}`);
				if (cmd.flags.json) {
					console.log(JSON.stringify({ ...result.daemon, spec: result.spec }, null, 2));
					return;
				}
				const daemon = result.daemon;
				console.log(daemonLabel(daemon));
				console.log(`  command:  ${formatCommand(result.spec)}`);
				console.log(`  cwd:      ${result.spec.cwd}`);
				if (!TERMINAL_STATES[daemon.state])
					console.log(`  uptime:   ${formatDuration(Date.now() - daemon.startedAt)}`);
				if (daemon.exitReason) console.log(`  exit:     ${daemon.exitReason}`);
				console.log(`  restarts: ${daemon.restartCount} (policy: ${result.spec.restart})`);
				console.log(
					`  pty: ${result.spec.pty}  persist: ${result.spec.persist}  detached: ${result.spec.detached}  owner: ${daemon.owner ?? "-"}`,
				);
				return;
			}
			case "logs":
				await runLogs(cmd, client, name);
				return;
			case "stop":
			case "kill": {
				const timeoutMs = cmd.action === "kill" ? KILL_GRACE_MS : Math.round((cmd.flags.timeout ?? 5) * 1000);
				const result = await client.request({ op: "stop", name, timeoutMs });
				if (result.op !== "stop") throw new Error(`Unexpected broker response ${result.op}`);
				printDaemonResult(cmd, cmd.action === "kill" ? "Killed" : "Stopped", result.daemon);
				return;
			}
			case "restart": {
				const result = await client.request({ op: "restart", name });
				if (result.op !== "restart") throw new Error(`Unexpected broker response ${result.op}`);
				printDaemonResult(cmd, "Restarted", result.daemon);
				return;
			}
			default:
				throw new Error(`Unhandled action ${cmd.action}`);
		}
	} catch (error) {
		console.error(chalk.red(error instanceof Error ? error.message : String(error)));
		process.exitCode = 1;
	}
}

function printDaemonResult(cmd: PsCommandArgs, verb: string, daemon: DaemonSnapshot): void {
	if (cmd.flags.json) console.log(JSON.stringify(daemon, null, 2));
	else console.log(`${verb} ${daemonLabel(daemon)}`);
}

async function runLogs(cmd: PsCommandArgs, client: DaemonBrokerClient, name: string): Promise<void> {
	const lines = Math.max(1, Math.min(1_000, Math.floor(cmd.flags.lines ?? 100)));
	// Follow mode reads the full 1000-line window on every request so overlap
	// trimming sees a stable, sliding tail; the initial print is cut to `lines`.
	const first = await client.request({
		op: "logs",
		name,
		lines: cmd.flags.follow ? 1_000 : lines,
		head: cmd.flags.head,
		grep: cmd.flags.grep,
		follow: false,
		renderTerminalRows: !cmd.flags.follow,
		timeoutMs: 30_000,
	});
	if (first.op !== "logs") throw new Error(`Unexpected broker response ${first.op}`);
	if (!cmd.flags.follow) {
		const text = first.terminalRows !== undefined ? first.terminalRows.join("\n") : first.text.replace(/\n$/, "");
		if (text) console.log(text);
		console.log(chalk.dim(`[${name}: ${first.state}]`));
		return;
	}
	const initial = first.text.replace(/\n$/, "").split("\n").slice(-lines).join("\n");
	if (initial) process.stdout.write(`${initial}\n`);
	let previous = first.text;
	let cursor = first.cursor;
	let state = first.state;
	while (!TERMINAL_STATES[state]) {
		const next = await client.request({
			op: "logs",
			name,
			lines: 1_000,
			head: false,
			grep: cmd.flags.grep,
			follow: true,
			cursor,
			renderTerminalRows: false,
			timeoutMs: 30_000,
		});
		if (next.op !== "logs") throw new Error(`Unexpected broker response ${next.op}`);
		// The broker always returns the tail window (cursor is only a wait
		// watermark), so trim the part we already printed.
		const fresh = next.text.slice(overlapLength(previous, next.text));
		if (fresh) process.stdout.write(fresh.endsWith("\n") ? fresh : `${fresh}\n`);
		previous = next.text;
		cursor = next.cursor;
		state = next.state;
	}
	console.log(chalk.dim(`[${name}: ${state}]`));
}

/** Longest suffix of `previous` that is a prefix of `next` — the already-printed portion of a tail window. */
function overlapLength(previous: string, next: string): number {
	for (let k = Math.min(previous.length, next.length); k > 0; k--) {
		const offset = previous.length - k;
		let match = true;
		for (let i = 0; i < k; i++) {
			if (previous.charCodeAt(offset + i) !== next.charCodeAt(i)) {
				match = false;
				break;
			}
		}
		if (match) return k;
	}
	return 0;
}
