import { describe, expect, it } from "bun:test";
import type { Message } from "@oh-my-pi/pi-ai";
import { obfuscateMessages } from "@oh-my-pi/pi-coding-agent/secrets/message-transform";
import { type SecretEntry, SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import {
	SecretValueSet,
	sanitizedLabelCollidesWithSecret,
	sanitizeForCollisionCheck,
} from "@oh-my-pi/pi-coding-agent/secrets/placeholder";

// "TOKABC123" is both OTHERSECRET's friendly label and the normalized form of
// `tok_abc123`, which the regex protects: once that value is known, the label
// would expose it and must be stripped from every placeholder carrying it.
const COLLIDING_ENTRIES: SecretEntry[] = [
	{ type: "plain", content: "OTHERSECRET", friendlyName: "TOKABC123" },
	{ type: "regex", content: "tok_[a-z0-9]+" },
];
const KEY = "batch-reuse-test-key";

function userText(messages: Message[]): string {
	const content = messages[0]?.content;
	if (typeof content !== "string") throw new Error("expected string user content");
	return content;
}

describe("SecretObfuscator batch reuse", () => {
	it("re-redacts a reused fixed point once a later mint makes its friendly prefix unsafe", () => {
		const obfuscator = new SecretObfuscator(COLLIDING_ENTRIES, KEY);
		const history = obfuscateMessages(obfuscator, [{ role: "user", content: "use OTHERSECRET now", timestamp: 1 }]);
		expect(userText(history)).toMatch(/^use \$\$TOKABC123_[A-Z0-9]+:U\$\$ now$/);

		// The redacted history comes back unchanged, so later batches may reuse it.
		expect(userText(obfuscateMessages(obfuscator, history))).toBe(userText(history));
		expect(userText(obfuscateMessages(obfuscator, history))).toBe(userText(history));

		// Minting tok_abc123 elsewhere changes the registry, so the reused result is stale.
		expect(obfuscator.obfuscate("tok_abc123")).not.toContain("tok_abc123");

		const after = userText(obfuscateMessages(obfuscator, history));
		expect(after).not.toContain("TOKABC123_");
		expect(after).toMatch(/^use \$\$[A-Z0-9]+:U\$\$ now$/);
		expect(obfuscator.deobfuscate(after)).toBe("use OTHERSECRET now");
	});

	it("does not reuse fixed points across batches whose shared collision values differ", () => {
		const historical = "see $$TOKABC123_OLDHASH:L$$ here";
		const colliding = new SecretValueSet(["tok_abc123"]);
		const expected = new SecretObfuscator(COLLIDING_ENTRIES, KEY).obfuscate(historical, colliding);
		expect(expected).toBe("see $$OLDHASH:L$$ here");

		const obfuscator = new SecretObfuscator(COLLIDING_ENTRIES, KEY);
		for (let i = 0; i < 2; i++) {
			expect(obfuscator.batch(() => obfuscator.obfuscate(historical, new SecretValueSet()))).toBe(historical);
		}
		expect(obfuscator.batch(() => obfuscator.obfuscate(historical, colliding))).toBe(expected);
		for (let i = 0; i < 2; i++) {
			const empty = new SecretValueSet();
			expect(obfuscator.batch(() => obfuscator.stripUnsafeFriendlyPlaceholderPrefixes(historical, empty))).toBe(
				historical,
			);
		}
		expect(obfuscator.batch(() => obfuscator.stripUnsafeFriendlyPlaceholderPrefixes(historical, colliding))).toBe(
			expected,
		);
	});
});

describe("SecretValueSet.collidesWithLabel", () => {
	function naive(values: ReadonlySet<string>, label: string): boolean {
		for (const value of values) {
			if (sanitizedLabelCollidesWithSecret(label, sanitizeForCollisionCheck(value))) return true;
		}
		return false;
	}

	it("tracks values sharing one normalized form across delete", () => {
		const values = new SecretValueSet(["ab-c", "ABC"]);
		expect(values.collidesWithLabel("XABCX")).toBe(true);
		values.delete("ab-c");
		expect(values.collidesWithLabel("XABCX")).toBe(true);
		values.delete("ABC");
		expect(values.collidesWithLabel("XABCX")).toBe(false);
	});

	it("never matches values that normalize to nothing", () => {
		const values = new SecretValueSet(["---", "__"]);
		expect(values.collidesWithLabel("ANYLABEL")).toBe(false);
		expect(values.collidesWithLabel("")).toBe(false);
	});

	it("flags a display-capped label that is a prefix of a longer secret", () => {
		const secret = "A".repeat(20) + "B".repeat(20);
		const values = new SecretValueSet([secret]);
		expect(values.collidesWithLabel(secret.slice(0, 31))).toBe(false);
		expect(values.collidesWithLabel(secret.slice(0, 32))).toBe(true);
		expect(values.collidesWithLabel(secret.slice(0, 33))).toBe(true);
		expect(values.collidesWithLabel(`${secret.slice(0, 32)}Z`)).toBe(false);
	});

	it("matches the per-member check across random add, delete and clear", () => {
		let seed = 0x5eed;
		const random = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		const alphabet = ["A", "B", "1", "_", "-", "a", "b"];
		const word = (length: number) =>
			Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");

		for (let round = 0; round < 500; round++) {
			const values = new SecretValueSet();
			const plain = new Set<string>();
			for (let step = 0; step < 12; step++) {
				const action = random();
				if (action < 0.6) {
					const value = word(Math.floor(random() * 45));
					values.add(value);
					plain.add(value);
				} else if (action < 0.9 && plain.size > 0) {
					const value = [...plain][Math.floor(random() * plain.size)]!;
					values.delete(value);
					plain.delete(value);
				} else if (action >= 0.97) {
					values.clear();
					plain.clear();
				}
				// Labels straddle the 32-char display cap where the prefix rule applies.
				const label = sanitizeForCollisionCheck(word(28 + Math.floor(random() * 10)));
				expect(values.collidesWithLabel(label)).toBe(naive(plain, label));
				const short = sanitizeForCollisionCheck(word(Math.floor(random() * 8)));
				expect(values.collidesWithLabel(short)).toBe(naive(plain, short));
			}
		}
	});
});
