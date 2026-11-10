import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $which, formatBytes } from "@oh-my-pi/pi-utils";
import {
	queryBlobBrokerDoctor,
	queryBlobBrokerProbe,
	queryBlobBrokerPurge,
	queryBlobBrokerStatus,
} from "../blob-broker/daemon";
import {
	type BlobDestinationId,
	type BlobDestinationMetadata,
	BUILTIN_BLOB_DESTINATIONS,
} from "../blob-broker/destinations";
import type {
	BlobBrokerDoctorRequest,
	BlobBrokerDoctorResponse,
	BlobBrokerProbeRequest,
	BlobBrokerProbeResponse,
	BlobBrokerPurgeRequest,
	BlobBrokerPurgeResponse,
	BlobBrokerStatus,
	BlobBrokerWorkerConfig,
} from "../blob-broker/protocol";
import {
	type BlobBrokerSavingsStatus,
	blobBrokerSavingsJournalPath,
	readBlobBrokerSavingsStatus,
} from "../blob-broker/savings";
import { resolveBlobBrokerConfigs } from "../blob-broker/service";
import { createConfiguredUploader } from "../blob-broker/uploaders";
import { Settings } from "../config/settings";

import { cfgImagesUrlsBackends, cfgImagesUrlsEnabled } from "../blob-broker/settings";

export const IMAGES_ACTIONS = ["status", "doctor", "probe", "purge"] as const;
export type ImagesAction = (typeof IMAGES_ACTIONS)[number];

export interface ImagesCommandArgs {
	readonly action: ImagesAction;
	readonly flags: {
		readonly json?: boolean;
		readonly apply?: boolean;
		readonly all?: boolean;
		readonly dir?: string;
		/** Positive request timeout in seconds. */
		readonly timeout?: number;
	};
}

export interface ImagesResolvedConfig {
	readonly enabled: boolean;
	readonly orderedBackends: readonly BlobDestinationId[];
	readonly configs: readonly BlobBrokerWorkerConfig[];
	readonly savingsJournalPath: string;
}

export type ImagesDoctorSeverity = "ok" | "warn" | "error";

export interface ImagesDoctorCheck {
	readonly name: string;
	readonly severity: ImagesDoctorSeverity;
	readonly detail: string;
}

export interface ImagesCliDependencies {
	readonly loadSettings: (projectDir: string) => Promise<Settings>;
	readonly resolveConfig: (settings: Settings, projectDir: string) => ImagesResolvedConfig;
	readonly readSavings: (journalPath: string) => Promise<BlobBrokerSavingsStatus>;
	readonly queryStatus: (projectDir: string) => Promise<BlobBrokerStatus | null>;
	readonly queryDoctor: (
		projectDir: string,
		request?: BlobBrokerDoctorRequest,
	) => Promise<BlobBrokerDoctorResponse | null>;
	readonly queryProbe: (
		projectDir: string,
		config: BlobBrokerWorkerConfig,
		request?: BlobBrokerProbeRequest,
	) => Promise<BlobBrokerProbeResponse | null>;
	readonly queryPurge: (
		projectDir: string,
		request: BlobBrokerPurgeRequest,
	) => Promise<BlobBrokerPurgeResponse | null>;
	readonly which: (binary: string) => string | null;
	readonly writeStdout: (text: string) => void;
	readonly writeStderr: (text: string) => void;
}

export interface SafeDaemonStatus {
	readonly state: "running" | "stopped";
	readonly baseUrl?: string;
	readonly lazy?: boolean;
	readonly metrics?: BlobBrokerStatus["metrics"];
	readonly recentFetches?: BlobBrokerStatus["recentFetches"];
}

export interface ImagesStatusResult {
	readonly action: "status";
	readonly exitCode: 0;
	readonly projectDir: string;
	readonly enabled: boolean;
	readonly backends: readonly BlobDestinationId[];
	readonly daemon: SafeDaemonStatus;
	readonly savings: BlobBrokerSavingsStatus;
}

export interface ImagesDoctorResult {
	readonly action: "doctor";
	readonly exitCode: 0 | 1;
	readonly projectDir: string;
	readonly healthy: boolean;
	readonly checks: readonly ImagesDoctorCheck[];
}

export interface ImagesProbeResult {
	readonly action: "probe";
	readonly exitCode: 0 | 1;
	readonly projectDir: string;
	readonly backend?: BlobDestinationId;
	readonly daemonState: "running" | "stopped";
	readonly ok: boolean;
	readonly durationMs?: number;
	readonly detail: string;
}

export interface ImagesDaemonPurgeResult {
	readonly applied: boolean;
	readonly purgedBlobs: number;
	readonly reclaimedBytes: number;
	readonly attempted: number;
	readonly deleted: number;
	readonly errors: readonly string[];
}

export interface ImagesPurgeResult {
	readonly action: "purge";
	readonly exitCode: 0 | 1;
	readonly projectDir: string;
	readonly applied: boolean;
	readonly all: boolean;
	readonly daemon: ImagesDaemonPurgeResult | null;
}

export interface ImagesErrorResult {
	readonly action: ImagesAction;
	readonly exitCode: 1 | 2;
	readonly error: string;
}

export type ImagesCommandResult =
	| ImagesStatusResult
	| ImagesDoctorResult
	| ImagesProbeResult
	| ImagesPurgeResult
	| ImagesErrorResult;

const BINARY_BY_DESTINATION: Readonly<Partial<Record<BlobDestinationId, string>>> = {
	cloudflared: "cloudflared",
	"named-cloudflared": "cloudflared",
	ngrok: "ngrok",
	tailscale: "tailscale",
	"localhost-run": "ssh",
	pinggy: "ssh",
	ssh: "ssh",
	devtunnel: "devtunnel",
	zrok: "zrok",
	bore: "bore",
};

function defaultResolveConfig(settings: Settings, projectDir: string): ImagesResolvedConfig {
	return {
		enabled: cfgImagesUrlsEnabled.get(settings),
		orderedBackends: cfgImagesUrlsBackends.get(settings),
		configs: resolveBlobBrokerConfigs(settings, projectDir),
		savingsJournalPath: blobBrokerSavingsJournalPath(settings, projectDir),
	};
}

const DEFAULT_DEPENDENCIES: ImagesCliDependencies = {
	loadSettings: projectDir => Settings.loadReadOnly({ cwd: projectDir }),
	resolveConfig: defaultResolveConfig,
	readSavings: readBlobBrokerSavingsStatus,
	queryStatus: queryBlobBrokerStatus,
	queryDoctor: queryBlobBrokerDoctor,
	queryProbe: queryBlobBrokerProbe,
	queryPurge: queryBlobBrokerPurge,
	which: binary => $which(binary) ?? null,
	writeStdout: text => {
		process.stdout.write(text);
	},
	writeStderr: text => {
		process.stderr.write(text);
	},
};

function dependencies(overrides: Partial<ImagesCliDependencies> | undefined): ImagesCliDependencies {
	return { ...DEFAULT_DEPENDENCIES, ...overrides };
}

function safeDetail(value: unknown): string {
	const message = value instanceof Error ? value.message : String(value);
	return message
		.replace(/\bBearer\s+[^\s]+/gi, "Bearer [redacted]")
		.replace(/([?&](?:access_token|api[_-]?key|key|token)=)[^&#\s]+/gi, "$1[redacted]")
		.replace(/https?:\/\/[^\s)]+/gi, raw => {
			try {
				return new URL(raw).origin;
			} catch {
				return "[redacted URL]";
			}
		})
		.slice(0, 500);
}

function safeBaseUrl(value: string): string | undefined {
	try {
		const url = new URL(value);
		return url.origin;
	} catch {
		return undefined;
	}
}

function publicStatus(status: BlobBrokerStatus | null): SafeDaemonStatus {
	if (!status) return { state: "stopped" };
	return {
		state: "running",
		...(safeBaseUrl(status.baseUrl) ? { baseUrl: safeBaseUrl(status.baseUrl) } : {}),
		lazy: status.lazy,
		metrics: status.metrics,
		recentFetches: status.recentFetches.map(event => ({
			timestamp: event.timestamp,
			method: event.method,
			found: event.found,
			tokenSuffix: event.tokenSuffix,
		})),
	};
}

async function collectStatus(
	projectDir: string,
	config: ImagesResolvedConfig,
	deps: ImagesCliDependencies,
): Promise<ImagesStatusResult> {
	const [daemon, journalSavings] = await Promise.all([
		deps.queryStatus(projectDir),
		deps.readSavings(config.savingsJournalPath),
	]);
	const savings = daemon?.savings ?? journalSavings;
	return {
		action: "status",
		exitCode: 0,
		projectDir,
		enabled: config.enabled,
		backends: config.orderedBackends,
		daemon: publicStatus(daemon),
		savings,
	};
}

function configuredValue(value: unknown): boolean {
	return typeof value === "string" ? value.trim().length > 0 : value !== undefined;
}

function configChecks(config: ImagesResolvedConfig, deps: ImagesCliDependencies): ImagesDoctorCheck[] {
	const checks: ImagesDoctorCheck[] = [];
	checks.push({
		name: "enabled",
		severity: config.enabled ? "ok" : "error",
		detail: config.enabled ? "Image publication is enabled" : "images.urls.enabled is false",
	});
	if (config.orderedBackends.length === 0) {
		checks.push({ name: "backends", severity: "error", detail: "No image publication backends are configured" });
	}
	const configByKind = new Map(config.configs.map(item => [item.kind, item]));
	for (const backend of config.orderedBackends) {
		const metadata: BlobDestinationMetadata = BUILTIN_BLOB_DESTINATIONS[backend];
		const unavailable = metadata.status === "defunct" || metadata.status === "incompatible";
		checks.push({
			name: `registry:${backend}`,
			severity: unavailable ? "error" : metadata.status === "requires-account" ? "warn" : "ok",
			detail: unavailable
				? `${metadata.label}: ${metadata.reason ?? metadata.status}`
				: `${metadata.label}: ${metadata.status}`,
		});
		const runtime = configByKind.get(backend);
		if (runtime) {
			// Serving kinds carry their exposure settings as top-level worker-config fields, while
			// the registry describes them as option keys; a value in either place is configured.
			const serveFields: Record<string, string | number | undefined> = {
				publicBaseUrl: runtime.publicBaseUrl,
				bindHost: runtime.bindHost,
				sshTarget: runtime.sshTarget,
				sshRemotePort: runtime.sshRemotePort,
			};
			const missingOptions = metadata.options
				.filter(field => field.required && !configuredValue(runtime.options[field.key] ?? serveFields[field.key]))
				.map(field => field.key);
			const missingCredentials = metadata.credentials
				.filter(field => field.required && !configuredValue(runtime.credentials[field.key]))
				.map(field => field.key);
			const missing = [...missingOptions, ...missingCredentials];
			let runtimeError: string | undefined;
			if (missing.length === 0) {
				try {
					createConfiguredUploader(backend, runtime);
				} catch (error) {
					runtimeError = safeDetail(error);
				}
			}
			checks.push({
				name: `config:${backend}`,
				severity: missing.length === 0 && runtimeError === undefined ? "ok" : "error",
				detail:
					missing.length > 0
						? `Missing required fields: ${missing.join(", ")}`
						: (runtimeError ?? "Required configuration is present"),
			});
		}
		const binary = BINARY_BY_DESTINATION[backend];
		if (binary) {
			const found = deps.which(binary);
			checks.push({
				name: `binary:${backend}`,
				severity: found ? "ok" : "error",
				detail: found ? `${binary} is available` : `${binary} is not on PATH`,
			});
		}
	}
	return checks;
}

async function diskChecks(config: ImagesResolvedConfig): Promise<ImagesDoctorCheck[]> {
	const directories = new Set<string>([
		path.dirname(config.savingsJournalPath),
		...config.configs.flatMap(item =>
			item.persist ? [item.persist.blobsDir, path.dirname(item.persist.indexPath)] : [],
		),
	]);
	const checks: ImagesDoctorCheck[] = [];
	for (const directory of directories) {
		try {
			await fs.access(directory, fsConstants.R_OK | fsConstants.W_OK);
			checks.push({
				name: "disk",
				severity: "ok",
				detail: `Cache directory is readable and writable: ${directory}`,
			});
		} catch {
			checks.push({
				name: "disk",
				severity: "warn",
				detail: `Cache directory is absent or not writable: ${directory}`,
			});
		}
	}
	return checks;
}

async function collectDoctor(
	projectDir: string,
	config: ImagesResolvedConfig,
	deps: ImagesCliDependencies,
): Promise<ImagesDoctorResult> {
	const checks = [...configChecks(config, deps), ...(await diskChecks(config))];
	const daemon = await deps.queryDoctor(projectDir, { probe: true });
	if (!daemon) {
		checks.push({ name: "daemon", severity: "warn", detail: "Image daemon is stopped or unreachable" });
	} else {
		for (const check of daemon.checks) {
			checks.push({
				name: `daemon:${check.name}`,
				severity: check.status === "pass" ? "ok" : check.status === "warn" ? "warn" : "error",
				detail: safeDetail(check.detail),
			});
		}
	}
	const healthy = !checks.some(check => check.severity === "error");
	return { action: "doctor", exitCode: healthy ? 0 : 1, projectDir, healthy, checks };
}

async function collectProbe(
	projectDir: string,
	config: ImagesResolvedConfig,
	timeoutMs: number | undefined,
	deps: ImagesCliDependencies,
): Promise<ImagesProbeResult> {
	const first = config.configs[0];
	if (!config.enabled || !first) {
		return {
			action: "probe",
			exitCode: 1,
			projectDir,
			daemonState: "stopped",
			ok: false,
			detail: config.enabled ? "No URL backend is configured" : "Image publication is disabled",
		};
	}
	const response = await deps.queryProbe(projectDir, first, { timeoutMs });
	if (!response) {
		return {
			action: "probe",
			exitCode: 1,
			projectDir,
			backend: first.kind,
			daemonState: "stopped",
			ok: false,
			detail: "Image daemon could not be started or reached",
		};
	}
	return {
		action: "probe",
		exitCode: response.ok ? 0 : 1,
		projectDir,
		backend: first.kind,
		daemonState: "running",
		ok: response.ok,
		durationMs: response.durationMs,
		detail: safeDetail(response.detail),
	};
}

function publicPurgeResponse(response: BlobBrokerPurgeResponse | null): ImagesDaemonPurgeResult | null {
	if (!response) return null;
	return {
		applied: response.applied,
		purgedBlobs: response.purgedBlobs,
		reclaimedBytes: response.reclaimedBytes,
		attempted: response.attempted,
		deleted: response.deleted,
		errors: response.errors.map(safeDetail),
	};
}

async function collectPurge(
	projectDir: string,
	apply: boolean,
	all: boolean,
	deps: ImagesCliDependencies,
): Promise<ImagesPurgeResult> {
	const daemon = publicPurgeResponse(await deps.queryPurge(projectDir, { apply, all, expiredOnly: !all }));
	const failed = (daemon?.errors.length ?? 0) > 0;
	return {
		action: "purge",
		exitCode: failed ? 1 : 0,
		projectDir,
		applied: apply,
		all,
		daemon,
	};
}

function renderStatus(result: ImagesStatusResult): string {
	const lines = [
		`Image backends: ${result.backends.length > 0 ? result.backends.join(" → ") : "none"}`,
		`Enabled: ${result.enabled ? "yes" : "no"}`,
		`Daemon: ${result.daemon.state}${result.daemon.baseUrl ? ` (${result.daemon.baseUrl})` : ""}`,
	];
	const metrics = result.daemon.metrics;
	if (metrics) {
		lines.push(
			`Blobs: ${metrics.activeBlobs} active (${metrics.eagerBlobs} eager, ${metrics.lazyBlobs} lazy)`,
			`Storage: ${formatBytes(metrics.residentBytes)} resident, ${formatBytes(metrics.diskBytes)} disk`,
			`Fetch: ${metrics.hits} hits, ${metrics.misses} misses, ${metrics.duplicateTokenGets} duplicate GETs`,
			`Bytes served: ${formatBytes(metrics.bytesServed)}`,
		);
	}
	lines.push(
		`Bytes saved: ${formatBytes(result.savings.savedBytes)} (${formatBytes(result.savings.inlineBytes)} inline → ${formatBytes(result.savings.referenceBytes)} references)`,
	);
	for (const event of result.daemon.recentFetches ?? []) {
		lines.push(`Recent fetch: ${event.method} ${event.found ? "hit" : "miss"}`);
	}
	return `${lines.join("\n")}\n`;
}

function renderDoctor(result: ImagesDoctorResult): string {
	const lines = result.checks.map(check => `[${check.severity.toUpperCase()}] ${check.name}: ${check.detail}`);
	lines.push(result.healthy ? "Image diagnostics passed." : "Image diagnostics found errors.");
	return `${lines.join("\n")}\n`;
}

function renderProbe(result: ImagesProbeResult): string {
	const duration = result.durationMs === undefined ? "" : ` in ${result.durationMs} ms`;
	return `Image probe ${result.ok ? "passed" : "failed"}${duration}: ${result.detail}\n`;
}

function renderPurge(result: ImagesPurgeResult): string {
	const daemonSelected = result.daemon?.purgedBlobs ?? 0;
	const daemonBytes = result.daemon?.reclaimedBytes ?? 0;
	const lines = [
		result.applied ? "Image purge applied." : "Image purge dry-run; pass --apply to delete.",
		`Daemon blobs: ${daemonSelected}, ${formatBytes(daemonBytes)}`,
	];
	for (const error of result.daemon?.errors ?? []) lines.push(`Daemon error: ${error}`);
	return `${lines.join("\n")}\n`;
}

function renderHuman(result: ImagesCommandResult): string {
	if ("error" in result) return `images ${result.action}: ${result.error}\n`;
	switch (result.action) {
		case "status":
			return renderStatus(result);
		case "doctor":
			return renderDoctor(result);
		case "probe":
			return renderProbe(result);
		case "purge":
			return renderPurge(result);
	}
}

/** Execute one standalone images command with injectable, leak-free runtime seams. */
export async function runImagesCommand(
	args: ImagesCommandArgs,
	overrides?: Partial<ImagesCliDependencies>,
): Promise<ImagesCommandResult> {
	const deps = dependencies(overrides);
	let result: ImagesCommandResult;
	const projectDir = path.resolve(args.flags.dir ?? process.cwd());
	const timeout = args.flags.timeout;
	if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout <= 0)) {
		result = { action: args.action, exitCode: 2, error: "--timeout must be a positive integer" };
	} else {
		try {
			const settings = await deps.loadSettings(projectDir);
			const config = deps.resolveConfig(settings, projectDir);
			switch (args.action) {
				case "status":
					result = await collectStatus(projectDir, config, deps);
					break;
				case "doctor":
					result = await collectDoctor(projectDir, config, deps);
					break;
				case "probe":
					result = await collectProbe(
						projectDir,
						config,
						timeout === undefined ? undefined : timeout * 1000,
						deps,
					);
					break;
				case "purge":
					result = await collectPurge(projectDir, args.flags.apply === true, args.flags.all === true, deps);
					break;
			}
		} catch (error) {
			result = { action: args.action, exitCode: 1, error: safeDetail(error) };
		}
	}
	if (args.flags.json) deps.writeStdout(`${JSON.stringify(result)}\n`);
	else if ("error" in result) deps.writeStderr(renderHuman(result));
	else deps.writeStdout(renderHuman(result));
	return result;
}
