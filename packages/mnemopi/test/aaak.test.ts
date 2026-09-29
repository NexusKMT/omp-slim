import { describe, expect, it } from "bun:test";
import { encode } from "@oh-my-pi/pi-mnemopi/core/aaak";

describe("AAAK encoding", () => {
	it("compresses category prefixes, phrases, structure, and parentheses like Python", () => {
		expect(encode("PREFERENCE: Imperial units for GPS, 12-hour time format ( 5:30 PM )")).toBe(
			"PREF|Imperial units→GPS | 12-hour time format (5:30 PM)",
		);
		expect(encode("User asked for real-time transcription and translation using self-hosted automation")).toBe(
			"ASK RT transc+transl→selfhost auto",
		);
		expect(encode("User email is alice@example.com, GitHub: alice")).toBe("@alice@example.com | GH:alice");
	});

	it("leaves compact AAAK text unchanged and uses Python completion compaction order", () => {
		expect(encode("PREF|dark-mode")).toBe("PREF|dark-mode");
		expect(encode("TASK: backup working correctly, migration completed")).toBe("TASK: backup OK | migration DONE");
	});

	it("compacts status words and bare phrases only as whole words", () => {
		expect(encode("The migration is incomplete; the tests completed.")).toBe(
			"The migration is incomplete; the tests DONE.",
		);
		expect(encode("Networking needs a completeness check")).toBe("Networking needs a completeness check");
		expect(encode("Nightly automations cover transcriptions")).toBe("Nightly automations cover transcriptions");
	});
});
