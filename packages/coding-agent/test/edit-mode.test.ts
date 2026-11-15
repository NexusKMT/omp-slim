import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgEditFuzzyMatch, cfgEditMode, cfgEditModelVariants } from "@oh-my-pi/pi-coding-agent/edit/settings";
import { type EditMode } from "@oh-my-pi/pi-tui/tools/edit";
import { type EditModeSessionLike, resolveEditMode } from "@oh-my-pi/pi-coding-agent/utils/edit-mode";

const originalEditVariant = Bun.env.PI_EDIT_VARIANT;
const originalStrictEditMode = Bun.env.PI_STRICT_EDIT_MODE;

function restoreEnv(): void {
	if (originalEditVariant === undefined) {
		delete Bun.env.PI_EDIT_VARIANT;
	} else {
		Bun.env.PI_EDIT_VARIANT = originalEditVariant;
	}
	if (originalStrictEditMode === undefined) {
		delete Bun.env.PI_STRICT_EDIT_MODE;
	} else {
		Bun.env.PI_STRICT_EDIT_MODE = originalStrictEditMode;
	}
}

function createSession(args: {
	activeModel?: string;
	/** Configured `edit.modelVariants` entry keyed by the whole active model selector. */
	modelVariant?: EditMode;
	settingsMode?: EditMode;
}): EditModeSessionLike {
	// Persisted (global-layer) values: a runtime override would outrank `PI_EDIT_VARIANT`.
	const settings = Settings.isolated();
	cfgEditMode.set(settings, args.settingsMode ?? "hashline");
	if (args.modelVariant && args.activeModel) {
		cfgEditModelVariants.set(settings, { [args.activeModel]: args.modelVariant });
	}
	return { getActiveModelString: () => args.activeModel, settings };
}

describe("resolveEditMode", () => {
	beforeEach(() => {
		delete Bun.env.PI_EDIT_VARIANT;
		delete Bun.env.PI_STRICT_EDIT_MODE;
	});

	afterEach(() => {
		restoreEnv();
	});

	test("keeps explicit K3 edit-mode overrides ahead of the fallback", () => {
		for (const activeModel of ["kimi-code/k3", "kimi-coding/K3-256K"]) {
			expect(resolveEditMode(createSession({ activeModel, modelVariant: "hashline" }))).toBe("hashline");
			expect(resolveEditMode(createSession({ activeModel, settingsMode: "apply_patch" }))).toBe("apply_patch");

			Bun.env.PI_EDIT_VARIANT = "hashline";
			expect(resolveEditMode(createSession({ activeModel }))).toBe("hashline");
			delete Bun.env.PI_EDIT_VARIANT;

			Bun.env.PI_STRICT_EDIT_MODE = "1";
			expect(resolveEditMode(createSession({ activeModel }))).toBe("hashline");
			delete Bun.env.PI_STRICT_EDIT_MODE;
		}
	});

	test("does not exclude non-Kimi Moonshot models", () => {
		delete Bun.env.PI_EDIT_VARIANT;

		expect(resolveEditMode(createSession({ activeModel: "moonshot/moonshot-v1-128k" }))).toBe("hashline");
	});

	test("keeps explicit model variants ahead of the Kimi fallback", () => {
		delete Bun.env.PI_EDIT_VARIANT;

		expect(
			resolveEditMode(
				createSession({ activeModel: "openrouter/moonshotai/Kimi-K2-Instruct", modelVariant: "hashline" }),
			),
		).toBe("hashline");
	});

	test("keeps PI_EDIT_VARIANT ahead of the Kimi fallback", () => {
		Bun.env.PI_EDIT_VARIANT = "hashline";

		expect(resolveEditMode(createSession({ activeModel: "openrouter/moonshotai/Kimi-K2-Instruct" }))).toBe(
			"hashline",
		);
	});

	test("only falls back when the resolved mode is hashline", () => {
		delete Bun.env.PI_EDIT_VARIANT;

		expect(
			resolveEditMode(
				createSession({ activeModel: "openrouter/moonshotai/Kimi-K2-Instruct", settingsMode: "apply_patch" }),
			),
		).toBe("apply_patch");
	});

	test("keeps strict edit mode ahead of the Kimi fallback", () => {
		delete Bun.env.PI_EDIT_VARIANT;
		Bun.env.PI_STRICT_EDIT_MODE = "1";

		expect(resolveEditMode(createSession({ activeModel: "openrouter/moonshotai/Kimi-K2-Instruct" }))).toBe(
			"hashline",
		);
	});
});

describe("PI_EDIT_FUZZY", () => {
	const originalEditFuzzy = Bun.env.PI_EDIT_FUZZY;

	afterEach(() => {
		if (originalEditFuzzy === undefined) delete Bun.env.PI_EDIT_FUZZY;
		else Bun.env.PI_EDIT_FUZZY = originalEditFuzzy;
	});

	test("forces fuzzy matching with 1/true and 0/false, deferring to edit.fuzzyMatch for auto or other text", () => {
		const fuzzyWith = (raw: string, configured: boolean) => {
			Bun.env.PI_EDIT_FUZZY = raw;
			const settings = Settings.isolated();
			cfgEditFuzzyMatch.set(settings, configured);
			return cfgEditFuzzyMatch.get(settings);
		};
		expect(fuzzyWith("1", false)).toBe(true);
		expect(fuzzyWith("true", false)).toBe(true);
		expect(fuzzyWith("0", true)).toBe(false);
		expect(fuzzyWith("false", true)).toBe(false);
		expect(fuzzyWith("auto", true)).toBe(true);
		expect(fuzzyWith("auto", false)).toBe(false);
		expect(fuzzyWith("bogus", true)).toBe(true);
	});
});
