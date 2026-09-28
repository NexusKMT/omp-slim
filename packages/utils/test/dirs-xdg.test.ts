import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	__resetProfileSnapshotForTests,
	getAgentDir,
	getGlobalDaemonRuntimeDir,
	getPredictStateDir,
	getSkillDescriptionsDbPath,
	setAgentDir,
	setProfile,
} from "@oh-my-pi/pi-utils/dirs";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";

describe("XDG-aware runtime paths", () => {
	let tempRoot = "";
	let configDir = "";
	let originalAgentDir = "";
	let originalProfile: string | undefined;
	let originalConfigDir: string | undefined;
	let originalXdgDataHome: string | undefined;
	let originalXdgStateHome: string | undefined;

	beforeEach(async () => {
		originalAgentDir = getAgentDir();
		originalProfile = process.env.OMP_PROFILE ?? process.env.PI_PROFILE;
		originalConfigDir = process.env.PI_CONFIG_DIR;
		originalXdgDataHome = process.env.XDG_DATA_HOME;
		originalXdgStateHome = process.env.XDG_STATE_HOME;
		tempRoot = path.join(os.tmpdir(), "pi-utils-dirs-xdg", Snowflake.next());
		configDir = `.omp-dirs-xdg-${Snowflake.next()}`;
		await fs.mkdir(tempRoot, { recursive: true });
		process.env.PI_CONFIG_DIR = configDir;
		delete process.env.PI_CODING_AGENT_DIR;
		__resetProfileSnapshotForTests();
		delete process.env.XDG_DATA_HOME;
		delete process.env.XDG_STATE_HOME;
		delete process.env.XDG_CACHE_HOME;
	});

	afterEach(async () => {
		setProfile(undefined);
		if (originalProfile) setProfile(originalProfile);
		setAgentDir(originalAgentDir);
		if (originalConfigDir === undefined) {
			delete process.env.PI_CONFIG_DIR;
		} else {
			process.env.PI_CONFIG_DIR = originalConfigDir;
		}
		if (originalXdgDataHome === undefined) {
			delete process.env.XDG_DATA_HOME;
		} else {
			process.env.XDG_DATA_HOME = originalXdgDataHome;
		}
		if (originalXdgStateHome === undefined) {
			delete process.env.XDG_STATE_HOME;
		} else {
			process.env.XDG_STATE_HOME = originalXdgStateHome;
		}
		await fs.rm(tempRoot, { recursive: true, force: true });
		await fs.rm(path.join(os.homedir(), configDir), { recursive: true, force: true });
	});

	it("routes skill descriptions db and predict state under an initialized $XDG_DATA_HOME/omp", async () => {
		const xdgData = path.join(tempRoot, "data");
		await fs.mkdir(path.join(xdgData, "omp"), { recursive: true });
		process.env.XDG_DATA_HOME = xdgData;

		setAgentDir(path.join(os.homedir(), configDir, "agent"));

		if (process.platform !== "linux" && process.platform !== "darwin") return;

		const dbPath = getSkillDescriptionsDbPath();
		expect(dbPath).toBe(path.join(xdgData, "omp", "skill-descriptions.db"));

		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		await Bun.write(dbPath, "");
		expect(await Bun.file(dbPath).exists()).toBe(true);

		const stateDir = getPredictStateDir(undefined, "ngram");
		expect(stateDir).toBe(path.join(xdgData, "omp", "predict", "ngram"));

		await fs.mkdir(stateDir, { recursive: true });
		await Bun.write(path.join(stateDir, "cursor.json"), JSON.stringify({ historyId: 42 }));
		expect(getPredictStateDir(undefined, "ngram")).toBe(stateDir);
		expect(await Bun.file(path.join(stateDir, "cursor.json")).json()).toEqual({ historyId: 42 });
	});

	it("shares the global daemon runtime dir across profiles under an initialized $XDG_STATE_HOME/omp", async () => {
		const xdgState = path.join(tempRoot, "state");
		await fs.mkdir(path.join(xdgState, "omp"), { recursive: true });
		process.env.XDG_STATE_HOME = xdgState;
		setAgentDir(path.join(os.homedir(), configDir, "agent"));

		if (process.platform !== "linux" && process.platform !== "darwin") return;

		const shared = path.join(xdgState, "omp", "run", "daemons", "global", "text-predict");
		expect(getGlobalDaemonRuntimeDir("text-predict")).toBe(shared);
		setProfile("profile-a");
		expect(getGlobalDaemonRuntimeDir("text-predict")).toBe(shared);
	});

	it("keeps paths under an explicit custom agent dir, ignoring XDG", async () => {
		const custom = path.join(tempRoot, "custom-agent");
		await fs.mkdir(custom, { recursive: true });
		const xdgData = path.join(tempRoot, "data");
		await fs.mkdir(path.join(xdgData, "omp"), { recursive: true });
		process.env.XDG_DATA_HOME = xdgData;
		setAgentDir(custom);

		expect(getSkillDescriptionsDbPath()).toBe(path.join(custom, "skill-descriptions.db"));
		expect(getPredictStateDir(custom, "ngram")).toBe(path.join(custom, "predict", "ngram"));
	});
});
