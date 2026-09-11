import { describe, expect, it } from "bun:test";
import { hudSlotForChord } from "../../../src/modes/controllers/input-controller";

describe("hudSlotForChord", () => {
	it("maps trailing digits to jump-list slots", () => {
		expect(hudSlotForChord("alt+1")).toBe(1);
		expect(hudSlotForChord("Alt+8")).toBe(8);
		expect(hudSlotForChord("ctrl+alt+3")).toBe(3);
	});

	it("rejects chords without a positive trailing slot", () => {
		expect(hudSlotForChord("alt+a")).toBeUndefined();
		expect(hudSlotForChord("alt+0")).toBeUndefined();
		expect(hudSlotForChord("escape")).toBeUndefined();
		expect(hudSlotForChord("")).toBeUndefined();
	});
});
