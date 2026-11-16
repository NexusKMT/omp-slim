import * as fs from "node:fs";

function runCommand(command: string, args: string[]): string | null {
	try {
		const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) return null;
		return result.stdout.toString("utf-8").trim();
	} catch {
		return null;
	}
}
/** Local N-API addon identity derived from a host platform and ISA. */
export interface LocalHostAddon {
	readonly filename: string;
	readonly x64Variant: "modern" | "baseline" | null;
}

/** Resolve the exact filename and x86-64 ISA emitted by the local N-API build. */
export function resolveLocalHostAddon(host: {
	readonly platform: string;
	readonly arch: string;
	readonly avx2: boolean;
}): LocalHostAddon {
	const x64Variant = host.arch === "x64" ? (host.avx2 ? "modern" : "baseline") : null;
	const variantSuffix = x64Variant ? `-${x64Variant}` : "";
	return {
		filename: `pi_natives.${host.platform}-${host.arch}${variantSuffix}.node`,
		x64Variant,
	};
}

const ELF_MAGIC = 0x7f454c46;
const PT_INTERP = 3;

/**
 * Whether the running Bun links musl, read from its ELF interpreter
 * (`/lib/ld-musl-*.so.1`). This is the libc every addon it dlopens must match;
 * OS markers like /etc/alpine-release or an installed musl loader describe the
 * machine, not this process.
 */
export function detectHostMusl(): boolean {
	if (process.platform !== "linux") return false;
	let fd: number | undefined;
	try {
		fd = fs.openSync(process.execPath, "r");
		const header = Buffer.alloc(64);
		fs.readSync(fd, header, 0, header.length, 0);
		// ELFCLASS64 + little-endian: every Bun linux build (x64, arm64).
		if (header.readUInt32BE(0) !== ELF_MAGIC || header[4] !== 2 || header[5] !== 1) return false;
		const tableOffset = Number(header.readBigUInt64LE(0x20));
		const entrySize = header.readUInt16LE(0x36);
		const entryCount = header.readUInt16LE(0x38);
		const table = Buffer.alloc(entrySize * entryCount);
		fs.readSync(fd, table, 0, table.length, tableOffset);
		for (let entry = 0; entry < table.length; entry += entrySize) {
			if (table.readUInt32LE(entry) !== PT_INTERP) continue;
			const interp = Buffer.alloc(Number(table.readBigUInt64LE(entry + 32)));
			fs.readSync(fd, interp, 0, interp.length, Number(table.readBigUInt64LE(entry + 8)));
			return interp.toString("latin1").includes("/ld-musl-");
		}
		return false;
	} catch {
		return false;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

/** Detect whether this x86-64 host can run the modern AVX2 addon. */
export function detectHostAvx2Support(): boolean {
	if (process.arch !== "x64") return false;

	if (process.platform === "linux") {
		try {
			const cpuInfo = fs.readFileSync("/proc/cpuinfo", "utf8");
			return /\bavx2\b/i.test(cpuInfo);
		} catch {
			return false;
		}
	}

	if (process.platform === "darwin") {
		const leaf7 = runCommand("sysctl", ["-n", "machdep.cpu.leaf7_features"]);
		if (leaf7 && /\bAVX2\b/i.test(leaf7)) return true;
		const features = runCommand("sysctl", ["-n", "machdep.cpu.features"]);
		return Boolean(features && /\bAVX2\b/i.test(features));
	}

	return false;
}
