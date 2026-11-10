import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ConfigFile } from "@oh-my-pi/pi-coding-agent/config/config-file";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ModelsConfigSchema } from "@oh-my-pi/pi-coding-agent/config/models-config-schema";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("manual model config legacy JSON migration", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@model-registry-create-");
	});

	afterEach(async () => {
		await tempDir.remove();
	});

	test("migrates legacy models.json → models.yml ahead of the sync constructor", async () => {
		const yml = path.join(tempDir.path(), "models.yml");
		const json = path.join(tempDir.path(), "models.json");

		await Bun.write(json, JSON.stringify({ providers: {} }));
		expect(fs.existsSync(yml)).toBe(false);

		const authStorage = await AuthStorage.create(":memory:");
		try {
			new ModelRegistry(authStorage, yml);
			expect(fs.existsSync(yml)).toBe(true);
		} finally {
			authStorage.close();
		}
	});

	test("ConfigFile migration is idempotent — second load is a no-op", async () => {
		const yml = path.join(tempDir.path(), "models.yml");
		const json = path.join(tempDir.path(), "models.json");
		await Bun.write(json, JSON.stringify({ providers: {} }));

		const cf = new ConfigFile("models", ModelsConfigSchema, yml);
		cf.tryLoad();
		expect(fs.existsSync(yml)).toBe(true);
		const mtime1 = fs.statSync(yml).mtimeMs;

		// Second load should not rewrite the file (idempotent migration path).
		cf.invalidate();
		cf.tryLoad();
		const mtime2 = fs.statSync(yml).mtimeMs;
		expect(mtime2).toBe(mtime1);
	});

	test("ConfigFile migrates legacy models.json containing comments", async () => {
		const yml = path.join(tempDir.path(), "models.yml");
		const json = path.join(tempDir.path(), "models.json");
		await Bun.write(
			json,
			`{
				// Custom models comment
				"providers": {
					/* Block comment */
				}
			}`,
		);

		const cf = new ConfigFile("models", ModelsConfigSchema, yml);
		const result = cf.tryLoad();
		expect(result.status).toBe("ok");
		expect(fs.existsSync(yml)).toBe(true);
	});
});
