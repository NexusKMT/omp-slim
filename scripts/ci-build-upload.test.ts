import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ASSETS } from "./ci-build-upload";

const repoRoot = path.join(import.meta.dir, "..");
const cleanups: (() => Promise<void> | void)[] = [];
interface BuildFile {
	name: string;
	platform: string;
	arch: string;
	kind: string;
	size: number;
	sha256: string;
}

interface BuildPayload {
	version: string;
	channel: string;
	notes?: string;
	files: BuildFile[];
}

interface UploadFixture {
	dir: string;
	files: string[];
	bytes: Map<string, Buffer>;
}

interface LocalService {
	url: string;
	requests: {
		method: string;
		pathname: string;
		authorization: string | null;
		audience: string | null;
	}[];
	creates: BuildPayload[];
	uploads: Map<string, Buffer>;
	readonly publishes: number;
}

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function sha256(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

async function fixture(): Promise<UploadFixture> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-build-upload-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	// Copy the real entry and its real imports, keeping relative repository paths.
	// This isolates generated metadata without test-only production overrides.
	for (const file of ["scripts/ci-build-upload.ts", "scripts/ci-release-notes.ts", "packages/utils/src/version.ts"]) {
		await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
		await fs.copyFile(path.join(repoRoot, file), path.join(dir, file));
	}
	const codingAgent = path.join(dir, "packages", "coding-agent");
	await Bun.write(path.join(codingAgent, "CHANGELOG.md"), "## [1.2.3]\n\n### Added\n\n- Release binaries.\n");
	const files: string[] = [];
	const bytes = new Map<string, Buffer>();
	for (const name in ASSETS) {
		const file = path.join(codingAgent, "binaries", name);
		const content = Buffer.concat([Buffer.from(name), Buffer.from([0, 255, 13, 10])]);
		await Bun.write(file, content);
		files.push(file);
		bytes.set(name, content);
	}
	return { dir, files, bytes };
}

function startService(
	options: { retryPublish?: boolean; rejectUpload?: boolean; rejectCreate?: boolean } = {},
): LocalService {
	const requests: LocalService["requests"] = [];
	const creates: BuildPayload[] = [];
	const uploads = new Map<string, Buffer>();
	let publishes = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			requests.push({
				method: request.method,
				pathname: url.pathname,
				authorization: request.headers.get("Authorization"),
				audience: url.searchParams.get("audience"),
			});
			if (url.pathname === "/oidc") return Response.json({ value: "local-oidc-token" });
			if (url.pathname === "/api/products/omp/builds") {
				const body = (await request.json()) as BuildPayload;
				creates.push(body);
				if (options.rejectCreate) return new Response("create rejected", { status: 400 });
				return Response.json({
					build: { id: "test-build" },
					uploads: body.files.map(file => ({
						name: file.name,
						url: new URL(`/put/${file.name}`, request.url).href,
					})),
				});
			}
			if (url.pathname.startsWith("/put/")) {
				uploads.set(url.pathname.slice("/put/".length), Buffer.from(await request.arrayBuffer()));
				if (options.rejectUpload) return new Response("upload rejected", { status: 400 });
				return new Response(null, { status: 204 });
			}
			if (url.pathname === "/api/products/omp/builds/test-build/publish") {
				publishes++;
				if (options.retryPublish && publishes === 1) return new Response("retry publication", { status: 503 });
				return Response.json({ published: true });
			}
			return new Response("unexpected request", { status: 404 });
		},
	});
	cleanups.push(() => server.stop(true));
	return {
		url: server.url.origin,
		requests,
		creates,
		uploads,
		get publishes() {
			return publishes;
		},
	};
}

async function runUpload(f: UploadFixture, service: LocalService, tag = "v1.2.3") {
	const proc = Bun.spawn([process.execPath, "scripts/ci-build-upload.ts", tag, ...f.files], {
		cwd: f.dir,
		env: {
			...process.env,
			BUILD_URL: `${service.url}/`,
			ACTIONS_ID_TOKEN_REQUEST_URL: `${service.url}/oidc?existing=value`,
			ACTIONS_ID_TOKEN_REQUEST_TOKEN: "local-actions-token",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

describe("build-service release upload", () => {
	for (const [tag, channel] of [
		["v1.2.3", "stable"],
		["v1.2.3-canary.4", "canary"],
	]) {
		test(`publishes all required binaries for ${tag}`, async () => {
			const f = await fixture();
			const service = startService({ retryPublish: channel === "canary" });
			const result = await runUpload(f, service, tag);
			expect(result.exitCode, result.stdout + result.stderr).toBe(0);
			expect(service.creates).toHaveLength(1);
			const created = service.creates[0];
			expect(created.version).toBe(tag.slice(1));
			expect(created.channel).toBe(channel);
			expect(created.files).toHaveLength(8);
			if (channel === "stable") expect(created.notes).toBe("### Added\n\n- Release binaries.");
			const expected: BuildFile[] = [];
			for (const name in ASSETS) {
				const bytes = f.bytes.get(name)!;
				expected.push({ name, ...ASSETS[name], kind: "archive", size: bytes.byteLength, sha256: sha256(bytes) });
			}

			expect(created.files).toEqual(expected);
			expect(service.uploads).toEqual(f.bytes);
			expect(service.requests[0]).toEqual({
				method: "GET",
				pathname: "/oidc",
				authorization: "bearer local-actions-token",
				audience: "build.stencil.so",
			});
			expect(service.requests[1]).toMatchObject({
				method: "POST",
				pathname: "/api/products/omp/builds",
				authorization: "Bearer local-oidc-token",
			});
			expect(service.requests.slice(2, 10).map(request => request.method)).toEqual(Array(8).fill("PUT"));
			expect(service.requests[10]).toMatchObject({
				method: "POST",
				pathname: "/api/products/omp/builds/test-build/publish",
				authorization: "Bearer local-oidc-token",
			});
			expect(service.publishes).toBe(channel === "canary" ? 2 : 1);
		});
	}

	const invalid: { name: string; change: (f: UploadFixture) => Promise<unknown>; error: string }[] = [
		{
			name: "missing binary",
			change: async f => {
				f.files.pop();
			},
			error: "missing release binaries",
		},
		{
			name: "duplicate binary",
			change: async f => {
				f.files.push(f.files[0]);
			},
			error: "given twice",
		},
		{
			name: "extra artifact",
			change: async f => {
				const file = path.join(f.dir, "unexpected.js");
				await Bun.write(file, "unrelated");
				f.files.push(file);
			},
			error: "not an uploaded release asset",
		},
	];
	for (const { name, change, error } of invalid) {
		test(`rejects ${name} before any network request`, async () => {
			const f = await fixture();
			await change(f);
			const service = startService();
			const result = await runUpload(f, service);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain(error);
			expect(service.requests).toEqual([]);
		});
	}

	test("does not publish after a rejected PUT", async () => {
		const f = await fixture();
		const service = startService({ rejectUpload: true });
		const result = await runUpload(f, service);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("upload rejected");
		expect(service.creates).toHaveLength(1);
		expect(service.uploads.size).toBe(1);
		expect(service.publishes).toBe(0);
	});

	test("does not upload or publish after a rejected create", async () => {
		const f = await fixture();
		const service = startService({ rejectCreate: true });
		const result = await runUpload(f, service);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("create build: HTTP 400 create rejected");
		expect(service.creates).toHaveLength(1);
		expect(service.uploads.size).toBe(0);
		expect(service.publishes).toBe(0);
	});
});
