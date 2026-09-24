import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgIdaAvailable, cfgIdaInstall } from "@oh-my-pi/pi-coding-agent/ida/install";
import { isExecutableHeader } from "@oh-my-pi/pi-coding-agent/ida/store";
import { type BinaryView, parseBinaryView } from "@oh-my-pi/pi-coding-agent/tools/read-binary";

describe("isExecutableHeader", () => {
	const cases: Array<[string, number[], boolean]> = [
		["ELF", [0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00], true],
		[
			"PE (DOS header, e_lfanew=0x80)",
			[0x4d, 0x5a, ...Array.from({ length: 58 }, () => 0), 0x80, 0x00, 0x00, 0x00],
			true,
		],
		["8-byte MZ blob", [0x4d, 0x5a, 0xff, 0xfe, 0xc0, 0xc0, 0x90, 0x91], false],
		["Mach-O 32 BE", [0xfe, 0xed, 0xfa, 0xce, 0, 0, 0, 0], true],
		["Mach-O 32 LE", [0xce, 0xfa, 0xed, 0xfe, 0, 0, 0, 0], true],
		["Mach-O 64 BE", [0xfe, 0xed, 0xfa, 0xcf, 0, 0, 0, 0], true],
		["Mach-O 64 LE", [0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0], true],
		["fat Mach-O, nfat_arch=2", [0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x02], true],
		["Java 8 class", [0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x34], false],
		["PNG", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], false],
		["shorter than 4 bytes", [0x7f, 0x45, 0x4c], false],
	];
	for (const [name, bytes, expected] of cases) {
		it(`${name} → ${expected}`, () => {
			expect(isExecutableHeader(new Uint8Array(bytes))).toBe(expected);
		});
	}
});

describe("parseBinaryView", () => {
	const cases: Array<[string, BinaryView]> = [
		["", { kind: "overview" }],
		["imports", { kind: "imports" }],
		["main:asm", { kind: "asm", target: "main" }],
		["xrefs:0x401000", { kind: "xrefs", target: "0x401000" }],
		["sub_1000", { kind: "pseudocode", target: "sub_1000" }],
	];
	for (const [view, expected] of cases) {
		it(`${JSON.stringify(view)} → ${expected.kind}`, () => {
			expect(parseBinaryView(view)).toEqual(expected);
		});
	}

	it("rejects xrefs without a target", () => {
		expect(() => parseBinaryView("xrefs:")).toThrow("xrefs needs a target");
	});
});

describe("IDA availability", () => {
	let withIdalib: string;
	let withoutIdalib: string;

	beforeAll(async () => {
		withIdalib = await fs.mkdtemp(path.join(os.tmpdir(), "ida-install-"));
		withoutIdalib = await fs.mkdtemp(path.join(os.tmpdir(), "ida-empty-"));
		for (const lib of ["libidalib.dylib", "libidalib.so", "idalib.dll"]) {
			await Bun.write(path.join(withIdalib, lib), "");
		}
	});

	afterAll(async () => {
		await fs.rm(withIdalib, { recursive: true, force: true });
		await fs.rm(withoutIdalib, { recursive: true, force: true });
	});

	it("exposes IDA when the configured install ships idalib", () => {
		const settings = Settings.isolated({ "ida.installDir": withIdalib });
		expect(cfgIdaInstall.get(settings)).toBe(withIdalib);
		expect(cfgIdaAvailable.get(settings)).toBe(true);
	});

	it("hides IDA when the configured install lacks idalib, without falling back", () => {
		expect(cfgIdaAvailable.get(Settings.isolated({ "ida.installDir": withoutIdalib }))).toBe(false);
	});

	it("hides IDA when disabled even with a valid install", () => {
		expect(cfgIdaAvailable.get(Settings.isolated({ "ida.enabled": false, "ida.installDir": withIdalib }))).toBe(
			false,
		);
	});
});
