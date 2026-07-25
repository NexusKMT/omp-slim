import { describe, expect, it } from "bun:test";
import { isCredential, SETTINGS_SCHEMA, type SettingPath } from "../src/config/settings-schema";
import { getSettingDef } from "../src/modes/components/settings-defs";

const paths = Object.keys(SETTINGS_SCHEMA) as SettingPath[];

describe("credential settings", () => {
	it("marks every known credential, including those with no settings panel entry", () => {
		for (const path of [
			"auth.broker.token",
			"searxng.token",
			"searxng.basicPassword",
			"dev.autoqaPush.token",
			"hindsight.apiToken",
		] as const) {
			expect(isCredential(path)).toBe(true);
		}
	});

	it("classifies UI-visible credentials through the same marker", () => {
		// One field, not two: there is no separate UI-only masking flag that could
		// drift away from this classification.
		for (const path of ["mnemopi.embeddingApiKey", "mnemopi.llmApiKey"] as const) {
			expect(isCredential(path)).toBe(true);
		}
	});

	it("does not sweep ordinary settings into the credential set", () => {
		// Token-budget settings read like credentials by name but are plain numbers.
		for (const path of ["compaction.thresholdTokens", "display.showTokenUsage", "autoResume"] as const) {
			expect(isCredential(path)).toBe(false);
		}
	});

	it("only marks string settings as credentials", () => {
		for (const path of paths) {
			if (!isCredential(path)) continue;
			expect(SETTINGS_SCHEMA[path].type).toBe("string");
		}
	});
});

describe("credential masking reaches every surface", () => {
	it("masks a UI-visible credential in the settings panel", () => {
		// The panel derives masking from the same classification the CLI uses, so
		// a credential cannot render as plain text on one surface and dots on the
		// other.
		for (const path of ["hindsight.apiToken", "mnemopi.embeddingApiKey", "mnemopi.llmApiKey"] as const) {
			const def = getSettingDef(path);
			expect(def?.type).toBe("text");
			expect(def && "secret" in def ? def.secret : undefined).toBe(true);
		}
	});

	it("keeps credentials with no panel entry out of the panel entirely", () => {
		for (const path of ["auth.broker.token", "searxng.token", "dev.autoqaPush.token"] as const) {
			expect(getSettingDef(path)).toBeUndefined();
		}
	});

	it("leaves ordinary text settings unmasked", () => {
		const def = getSettingDef("shellPath");
		if (def?.type === "text") expect(def.secret).toBe(false);
	});
});
