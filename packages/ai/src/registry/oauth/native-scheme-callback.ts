import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { CONFIG_DIR_NAME, isEnoent } from "@oh-my-pi/pi-utils";

const LAUNCH_SERVICES_REGISTER =
	"/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const BUNDLE_PREFIX = "dev.omp.oauth-callback.";
const APP_PREFIX = "omp OAuth Callback ";
const RECOVERY_FILE = "darwin-url-callback.json";
const DEFAULT_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 100;

const CURRENT_HANDLER_SCRIPT = String.raw`
ObjC.import("AppKit");
function run(argv) {
  const url = $.NSURL.URLWithString(argv[0] + "://");
  const appUrl = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL(url);
  if (!appUrl || appUrl.isNil()) return "";
  const bundle = $.NSBundle.bundleWithURL(appUrl);
  return !bundle || bundle.isNil() ? "" : ObjC.unwrap(bundle.bundleIdentifier);
}
`;

const SET_HANDLER_SCRIPT = String.raw`
ObjC.import("CoreServices");
function run(argv) {
  return String(Number($.LSSetDefaultHandlerForURLScheme($(argv[0]), $(argv[1]))));
}
`;

interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Executes one macOS callback-registration command. */
export type NativeSchemeCommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

/** Receives one custom-scheme callback and restores the user's prior URL handler. */
export interface NativeSchemeCallbackReceiver {
	dispose(): Promise<void>;
	waitForCallback(signal?: AbortSignal, timeoutMs?: number): Promise<string>;
}

/** Dependency overrides used by platform tests and embedders. */
export interface NativeSchemeCallbackOptions {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	runCommand?: NativeSchemeCommandRunner;
}

interface RecoveryRecord {
	appPath: string;
	bundleId: string;
	pid: number;
	previousHandler: string;
	scheme: string;
}

let receiverActive = false;

async function runCommand(command: string, args: string[]): Promise<CommandResult> {
	const result = await $`${command} ${args}`.quiet().nothrow();
	return {
		exitCode: result.exitCode,
		stdout: result.text(),
		stderr: result.stderr.toString(),
	};
}

async function checkedRun(runner: NativeSchemeCommandRunner, command: string, args: string[]): Promise<string> {
	const result = await runner(command, args);
	if (result.exitCode !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `status ${result.exitCode}`;
		throw new Error(`${path.basename(command)} failed: ${detail}`);
	}
	return result.stdout.trim();
}

async function withStep<T>(step: string, action: () => Promise<T>): Promise<T> {
	try {
		return await action();
	} catch (cause) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		throw new Error(`${step}: ${detail}`, { cause });
	}
}

async function currentHandler(runner: NativeSchemeCommandRunner, scheme: string, step: string): Promise<string> {
	return withStep(step, () =>
		checkedRun(runner, "/usr/bin/osascript", ["-l", "JavaScript", "-e", CURRENT_HANDLER_SCRIPT, scheme]),
	);
}

async function setHandler(
	runner: NativeSchemeCommandRunner,
	scheme: string,
	bundleId: string,
	step: string,
): Promise<void> {
	await withStep(step, async () => {
		const status = await checkedRun(runner, "/usr/bin/osascript", [
			"-l",
			"JavaScript",
			"-e",
			SET_HANDLER_SCRIPT,
			scheme,
			bundleId,
		]);
		if (status !== "0") throw new Error(`LaunchServices returned status ${status}`);
	});
}

function appleScriptString(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function callbackScript(callbackPath: string): string[] {
	return [
		"on open location theURL",
		`set outputFile to POSIX file ${appleScriptString(callbackPath)}`,
		"try",
		"set fileHandle to open for access outputFile with write permission",
		"set eof fileHandle to 0",
		"write theURL to fileHandle as «class utf8»",
		"close access fileHandle",
		"on error",
		"try",
		"close access outputFile",
		"end try",
		"end try",
		"quit",
		"end open location",
	];
}

function configRoot(home: string, env: NodeJS.ProcessEnv): string {
	return path.resolve(home, env.PI_CONFIG_DIR?.trim() || CONFIG_DIR_NAME);
}

function recoveryPath(home: string, env: NodeJS.ProcessEnv): string {
	return path.join(configRoot(home, env), "oauth", RECOVERY_FILE);
}

function applicationsDir(home: string): string {
	return path.join(home, "Applications");
}

function isManagedRecovery(value: unknown, home: string): value is RecoveryRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<RecoveryRecord>;
	if (
		typeof record.appPath !== "string" ||
		typeof record.bundleId !== "string" ||
		typeof record.pid !== "number" ||
		typeof record.previousHandler !== "string" ||
		typeof record.scheme !== "string"
	) {
		return false;
	}
	const appRoot = `${path.resolve(applicationsDir(home))}${path.sep}`;
	return (
		path.resolve(record.appPath).startsWith(appRoot) &&
		path.basename(record.appPath).startsWith(APP_PREFIX) &&
		record.bundleId.startsWith(BUNDLE_PREFIX) &&
		/^[a-z][a-z0-9+.-]*$/u.test(record.scheme)
	);
}

function processIsAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function readRecovery(filePath: string, home: string): Promise<RecoveryRecord | undefined> {
	try {
		const parsed: unknown = JSON.parse(await Bun.file(filePath).text());
		if (!isManagedRecovery(parsed, home)) {
			throw new Error(`Invalid OAuth callback recovery record at ${filePath}; remove it and retry login.`);
		}
		return parsed;
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

async function unregisterApp(runner: NativeSchemeCommandRunner, appPath: string): Promise<void> {
	await runner(LAUNCH_SERVICES_REGISTER, ["-u", appPath]).catch(() => ({
		exitCode: 1,
		stdout: "",
		stderr: "",
	}));
}

async function recoverStaleHandler(
	runner: NativeSchemeCommandRunner,
	home: string,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	const filePath = recoveryPath(home, env);
	const record = await readRecovery(filePath, home);
	if (!record) return;
	if (record.pid !== process.pid && processIsAlive(record.pid)) {
		throw new Error("Another OAuth login is already waiting for a custom-scheme callback.");
	}
	const activeHandler = await currentHandler(runner, record.scheme, "reading stale OAuth callback handler");
	if (activeHandler === record.bundleId) {
		await setHandler(
			runner,
			record.scheme,
			record.previousHandler || "none",
			"restoring stale OAuth callback handler",
		);
	}
	await unregisterApp(runner, record.appPath);
	await fs.rm(record.appPath, { recursive: true, force: true });
	await fs.rm(filePath, { force: true });
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("OAuth login cancelled.");
}

/**
 * Temporarily registers a hidden macOS application for `scheme` callbacks.
 * Other platforms return `undefined` and retain the manual paste flow.
 */
export async function createNativeSchemeCallbackReceiver(
	scheme: string,
	options: NativeSchemeCallbackOptions = {},
): Promise<NativeSchemeCallbackReceiver | undefined> {
	if ((options.platform ?? process.platform) !== "darwin") return undefined;
	if (!/^[a-z][a-z0-9+.-]*$/u.test(scheme)) throw new Error(`Invalid OAuth callback scheme: ${scheme}`);
	if (receiverActive) throw new Error("Another OAuth login is already waiting for a custom-scheme callback.");
	receiverActive = true;

	const env = options.env ?? process.env;
	const home = env.HOME || os.homedir();
	const runner = options.runCommand ?? runCommand;
	const nonce = crypto.randomUUID().replaceAll("-", "");
	const bundleId = `${BUNDLE_PREFIX}${nonce}`;
	const appPath = path.join(applicationsDir(home), `${APP_PREFIX}${nonce.slice(0, 10)}.app`);
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-oauth-"));
	const callbackPath = path.join(tempDir, "callback.url");
	const recovery = recoveryPath(home, env);
	let previousHandler = "";
	let handlerChanged = false;
	let disposePromise: Promise<void> | undefined;

	const cleanup = async (): Promise<void> => {
		try {
			const activeHandler = await currentHandler(runner, scheme, "reading active OAuth callback handler").catch(
				() => "",
			);
			if (handlerChanged && activeHandler === bundleId) {
				await setHandler(runner, scheme, previousHandler || "none", "restoring OAuth callback handler");
			}
			await unregisterApp(runner, appPath);
			await fs.rm(appPath, { recursive: true, force: true });
			await fs.rm(tempDir, { recursive: true, force: true });
			const record = await readRecovery(recovery, home).catch(() => undefined);
			if (record?.bundleId === bundleId) await fs.rm(recovery, { force: true });
		} finally {
			receiverActive = false;
		}
	};

	try {
		await recoverStaleHandler(runner, home, env);
		previousHandler = await currentHandler(runner, scheme, "reading current OAuth callback handler");
		if (previousHandler.startsWith(BUNDLE_PREFIX)) {
			throw new Error(
				`A stale omp callback handler (${previousHandler}) has no recovery record; remove its app from ~/Applications and retry login.`,
			);
		}
		await fs.mkdir(applicationsDir(home), { recursive: true });
		await fs.mkdir(path.dirname(recovery), { recursive: true });
		await fs.writeFile(callbackPath, "", { mode: 0o600 });

		const compileArgs = ["-o", appPath];
		for (const line of callbackScript(callbackPath)) compileArgs.push("-e", line);
		await withStep("compiling OAuth callback app", () => checkedRun(runner, "/usr/bin/osacompile", compileArgs));

		const infoPlist = path.join(appPath, "Contents", "Info.plist");
		await withStep("setting OAuth callback bundle identifier", () =>
			checkedRun(runner, "/usr/bin/plutil", ["-insert", "CFBundleIdentifier", "-string", bundleId, infoPlist]),
		);
		await withStep("hiding OAuth callback app", () =>
			checkedRun(runner, "/usr/bin/plutil", ["-insert", "LSUIElement", "-bool", "true", infoPlist]),
		);
		await withStep("registering OAuth callback scheme", () =>
			checkedRun(runner, "/usr/bin/plutil", [
				"-insert",
				"CFBundleURLTypes",
				"-json",
				JSON.stringify([
					{
						CFBundleTypeRole: "Viewer",
						CFBundleURLName: "omp OAuth Callback",
						CFBundleURLSchemes: [scheme],
					},
				]),
				infoPlist,
			]),
		);
		await withStep("signing OAuth callback app", () =>
			checkedRun(runner, "/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appPath]),
		);
		await withStep("registering OAuth callback app with LaunchServices", () =>
			checkedRun(runner, LAUNCH_SERVICES_REGISTER, ["-f", appPath]),
		);

		const record: RecoveryRecord = {
			appPath,
			bundleId,
			pid: process.pid,
			previousHandler,
			scheme,
		};
		await fs.writeFile(recovery, `${JSON.stringify(record, null, "\t")}\n`, { mode: 0o600 });
		await fs.chmod(recovery, 0o600);
		await setHandler(runner, scheme, bundleId, "activating OAuth callback handler");
		handlerChanged = true;
		const registered = await currentHandler(runner, scheme, "verifying OAuth callback handler");
		if (registered !== bundleId) {
			throw new Error(`macOS did not activate the temporary ${scheme}:// callback handler.`);
		}
	} catch (error) {
		try {
			await cleanup();
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "OAuth callback setup and cleanup both failed");
		}
		throw error;
	}

	return {
		dispose() {
			return (disposePromise ??= cleanup());
		},
		async waitForCallback(signal, timeoutMs = DEFAULT_TIMEOUT_MS) {
			const deadline = Date.now() + timeoutMs;
			const callbackFile = Bun.file(callbackPath);
			for (;;) {
				if (signal?.aborted) throw abortError(signal);
				if (Date.now() >= deadline) {
					throw new Error(`Timed out waiting for the ${scheme}:// OAuth callback.`);
				}
				const callback = await callbackFile.text();
				if (callback.trim()) return callback.trim();
				await Bun.sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
			}
		},
	};
}
