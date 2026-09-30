/**
 * The plain-text step of inline lexing over one inline source: where text can end ({@link TextStops}, which also
 * tells the bare-URL rule where it can match) and how it is appended ({@link TextRun}).
 */
import type { Lexer, Token, TokenizerExtension, TokenizerStartFromFunction, Tokens } from "./core";

// Where plain text can end: the characters that start other inline tokens, and
// the scheme alternatives of the bare-URL rule. Global so a search can resume
// at `lastIndex`.
const TOKEN_START_CHAR = /[\\`<[!*_~\n]/g;
const BARE_URL_SCHEME = /https?:\/\/|ftp:\/\/|www\./gi;
// What the bare-URL rule's e-mail alternative requires after its "@", sticky to test one offset.
const DOTTED_DOMAIN = /[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+/iy;
/** A stop not searched for yet lies before every search offset. */
const UNSEARCHED = -1;

/** Whether `code` is in `[A-Za-z0-9._+-]`, the local part of a bare e-mail address. */
function isMailLocalChar(code: number): boolean {
	return (
		(code >= 0x61 && code <= 0x7a) ||
		(code >= 0x41 && code <= 0x5a) ||
		(code >= 0x30 && code <= 0x39) ||
		code === 0x2e ||
		code === 0x5f ||
		code === 0x2b ||
		code === 0x2d
	);
}

/**
 * The places where one inline source's plain text can end, as offsets into that source. Each stop is the first
 * offset at or after a search offset where a test passes, and each test reads the source only from its own offset
 * on, so a found stop stays the answer for every later search offset up to it. A stop is searched for again only
 * after lexing passes it, starting past it, so all the text steps of a paragraph read it a bounded number of times
 * instead of once per step. Search offsets never decrease: the lexer asks at its position for the bare-URL rule
 * and one past it for the text step, and its position only grows.
 */
export class TextStops {
	readonly #src: string;
	readonly #lexer: Lexer;
	// The next character in TOKEN_START_CHAR.
	#tokenChar = UNSEARCHED;
	// The next bare-URL scheme.
	#scheme = UNSEARCHED;
	// The next offset in a run of e-mail local characters that ends at "@", and that "@".
	#mail = UNSEARCHED;
	#mailAt = UNSEARCHED;
	// The last "@" whose domain was tested, and whether a dotted domain follows it.
	#domainAt = UNSEARCHED;
	#dottedDomain = false;
	// The next hard break: two or more spaces, or a backslash, before "\n".
	#hardBreak = UNSEARCHED;
	// Per inline extension, the offset its `startFrom` last returned. Keyed by the extension itself: `Marked.use`
	// can add extensions to the live registry during a lex, shifting every index.
	readonly #extensionStarts = new Map<TokenizerExtension, number>();

	constructor(src: string, lexer: Lexer) {
		this.#src = src;
		this.#lexer = lexer;
	}

	/**
	 * Whether the bare-URL rule can match at `pos`: its first alternative needs a scheme there, and its second a
	 * run of e-mail local characters from `pos` to an "@" (the only "@" such a run can reach) with a dotted domain
	 * right after that "@", which is the same test for every offset of the run.
	 */
	bareUrlCanStart(pos: number): boolean {
		if (this.#schemeFrom(pos) === pos) return true;
		if (this.#mailFrom(pos) !== pos) return false;
		if (this.#domainAt !== this.#mailAt) {
			this.#domainAt = this.#mailAt;
			DOTTED_DOMAIN.lastIndex = this.#mailAt + 1;
			this.#dottedDomain = DOTTED_DOMAIN.test(this.#src);
		}
		return this.#dottedDomain;
	}

	/**
	 * Length of the plain text at the start of `rest`, a suffix of the source: the distance to the nearest later
	 * offset where another token could start or an inline extension's start hint points.
	 */
	textLength(rest: string): number {
		const src = this.#src;
		const pos = src.length - rest.length;
		const from = pos + 1;
		if (this.#tokenChar < from) {
			TOKEN_START_CHAR.lastIndex = from;
			this.#tokenChar = TOKEN_START_CHAR.test(src) ? TOKEN_START_CHAR.lastIndex - 1 : Infinity;
		}
		// A text step never starts where a hard break still matches (the `br` rule takes it first), so a search
		// after passing a found break starts at or past its "\n".
		if (this.#hardBreak < from) this.#hardBreak = this.#seekHardBreak(from);
		let next =
			Math.min(src.length, this.#tokenChar, this.#schemeFrom(from), this.#mailFrom(from), this.#hardBreak) - pos;
		const lexer = this.#lexer;
		for (const extension of lexer.extensions.inline) {
			// A hint at `pos` itself yields 0, which is ignored exactly like `start` returning 0.
			const at = extension.startFrom
				? this.#startFrom(extension, extension.startFrom, pos) - pos
				: extension.start?.call({ lexer }, rest);
			if (typeof at === "number" && at > 0 && at < next) next = at;
		}
		// `slice` reads a fractional hint from `start` as its integer part.
		return Math.trunc(next);
	}

	/** Where `extension`'s `startFrom` hint points at or after `pos`, asked again only once lexing passes it. */
	#startFrom(extension: TokenizerExtension, startFrom: TokenizerStartFromFunction, pos: number): number {
		const cached = this.#extensionStarts.get(extension) ?? UNSEARCHED;
		if (cached >= pos) return cached;
		const found = startFrom.call({ lexer: this.#lexer }, this.#src, pos);
		// Only undefined or a number at or past `pos` answers: a -1 or NaN "none" would be searched for again at
		// every text step, and `null >= 0` holds only at offset 0.
		if (found !== undefined && !(typeof found === "number" && found >= pos)) {
			throw new Error(`inline extension "${extension.name}": startFrom returned ${found} for offset ${pos}`);
		}
		const start = found ?? Infinity;
		this.#extensionStarts.set(extension, start);
		return start;
	}

	/** The first bare-URL scheme at or after `from`. */
	#schemeFrom(from: number): number {
		if (this.#scheme < from) {
			BARE_URL_SCHEME.lastIndex = from;
			this.#scheme = BARE_URL_SCHEME.exec(this.#src)?.index ?? Infinity;
		}
		return this.#scheme;
	}

	/** The first offset at or after `from` that starts a match of `/[A-Za-z0-9._+-]+@/`. */
	#mailFrom(from: number): number {
		// Every offset in the run before the found "@" starts a match of its own.
		if (this.#mail < from) this.#mail = from < this.#mailAt ? from : this.#seekMail(from);
		return this.#mail;
	}

	/** The first offset at or after `from` that starts a match of `/[A-Za-z0-9._+-]+@/`, recording its "@". */
	#seekMail(from: number): number {
		const src = this.#src;
		for (let at = src.indexOf("@", from + 1); at !== -1; at = src.indexOf("@", at + 1)) {
			let start = at;
			while (start > from && isMailLocalChar(src.charCodeAt(start - 1))) start--;
			if (start < at) {
				this.#mailAt = at;
				return start;
			}
		}
		return Infinity;
	}

	/** The first offset at or after `from` that starts a match of `/(?: {2,}|\\)\n/`. */
	#seekHardBreak(from: number): number {
		const src = this.#src;
		for (let end = src.indexOf("\n", from + 1); end !== -1; end = src.indexOf("\n", end + 1)) {
			let start = end;
			while (start > from && src.charCodeAt(start - 1) === 0x20 /* space */) start--;
			if (end - start >= 2) return start;
			if (src.charCodeAt(end - 1) === 0x5c /* \ */) return end - 1;
		}
		return Infinity;
	}
}

/**
 * Appends plain text to one inline source's token list, merging into a text token before it as marked does. A text
 * token this run created grows by taking a longer slice of the source instead of by concatenation, so its raw stays
 * a flat string: reading its last character (the emphasis rule's look-behind) does not copy the whole token.
 */
export class TextRun {
	readonly #src: string;
	// The text token this run created, the source range it covers, and the one string held as its raw and text.
	#token: Tokens.Text | undefined;
	#start = 0;
	#end = 0;
	#value = "";

	constructor(src: string) {
		this.#src = src;
	}

	/** Appends the source text from `start` to `end`. */
	append(tokens: Token[], start: number, end: number): void {
		if (end <= start) return;
		const previous = tokens.at(-1);
		if (previous?.type === "text" && previous.tokens === undefined && previous.escaped === false) {
			if (
				previous === this.#token &&
				start === this.#end &&
				previous.raw === this.#value &&
				previous.text === this.#value
			) {
				this.#end = end;
				this.#value = this.#src.slice(this.#start, end);
				previous.raw = this.#value;
				previous.text = this.#value;
				return;
			}
			const raw = this.#src.slice(start, end);
			previous.raw += raw;
			previous.text += raw;
			return;
		}
		const raw = this.#src.slice(start, end);
		this.#token = { type: "text", raw, text: raw, escaped: false };
		this.#start = start;
		this.#end = end;
		this.#value = raw;
		tokens.push(this.#token);
	}
}
