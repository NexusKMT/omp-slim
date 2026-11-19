import { APP_NAME } from "@oh-my-pi/pi-utils/dirs";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { card, col, keyed, node, row, span, text } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode } from "../native/node";
import { isNativeRendering } from "../native/state";
import { TERMINAL } from "../terminal-capabilities";
import { theme } from "../theme/theme";
import type { Component } from "../tui";
import { padding, visibleWidth } from "../utils";

/**
 * The session's welcome banner. In a terminal: the gradient logo beside the
 * `omp` wordmark with the version under it (the logo alone when the lockup does
 * not fit). Natively: a card with the same logo, wordmark, and version
 * ({@link WelcomeComponent.describe}).
 */
export class WelcomeComponent implements Component {
	#animStart: number | null = null;
	#animTimer: Timer | null = null;
	#requestRender: (() => void) | null = null;
	// Render cache: the welcome box is the first transcript-area component, so
	// returning a stable array reference keeps the whole frame prefix stable.
	// Bypassed while the intro animation runs (every frame differs).
	#cachedWidth = -1;
	#cachedLines: string[] | undefined;
	#native: NativeNode | undefined;

	constructor(private version: string) {}

	invalidate(): void {
		this.#cachedWidth = -1;
		this.#cachedLines = undefined;
		this.#native = undefined;
	}

	/**
	 * A `card` (`omp.welcome`) mirroring the terminal banner: the lockup
	 * (`omp.welcome.lockup`: the terminal's builtin `omp` mark, which it animates,
	 * beside the wordmark with the version under it).
	 */
	describe(_cx: DescribeContext): NativeNode {
		if (this.#native) return this.#native;
		const body: NativeChild[] = [lockupNode(this.version)];
		const described = card({ role: "omp.welcome" }, body);
		this.#native = described;
		return described;
	}

	/** The intro keeps the welcome block mutable; settling lets it retire to history. */
	isTranscriptBlockFinalized(): boolean {
		return this.#animTimer == null;
	}

	/**
	 * Play a one-shot intro that sweeps the gradient through every phase
	 * before settling on the resting frame. Safe to call multiple times —
	 * subsequent calls reset and replay.
	 */
	playIntro(requestRender: () => void): void {
		this.#stopAnimation();
		// The intro is a repaint-only gradient sweep; a TSP terminal shows the
		// settled card right away.
		if (isNativeRendering()) {
			requestRender();
			return;
		}
		this.#requestRender = requestRender;
		this.#animStart = performance.now();
		this.#requestRender();
		this.#animTimer = setInterval(() => {
			const elapsed = performance.now() - (this.#animStart ?? 0);
			const requestRender = this.#requestRender;
			if (elapsed >= INTRO_MS) {
				this.#stopAnimation();
			}
			// Stopping clears the callback, but the settled frame must still paint
			// so an oversized startup header can retire into native scrollback.
			requestRender?.();
		}, INTRO_TICK_MS);
	}

	#stopAnimation(): void {
		if (this.#animTimer != null) {
			clearInterval(this.#animTimer);
			this.#animTimer = null;
		}
		this.#animStart = null;
		this.#requestRender = null;
		// The settled (resting) frame differs from the last intro frame.
		this.invalidate();
	}

	/**
	 * Redirect a running intro's render callback to a new target when a host
	 * remounts this component mid-animation.
	 * Returns true while the intro is still animating; false = no-op (settled).
	 */
	retargetIntro(requestRender: () => void): boolean {
		if (this.#animTimer == null) return false;
		this.#requestRender = requestRender;
		return true;
	}

	/** Stop the intro immediately and settle on the resting frame. Safe when idle. */
	stopIntro(): void {
		this.#stopAnimation();
	}

	/** Update the version embedded in the welcome border title. */
	setVersion(version: string): void {
		this.version = version;
		this.invalidate();
	}

	render(termWidth: number): readonly string[] {
		const animating = this.#animStart != null;
		if (!animating && this.#cachedLines && this.#cachedWidth === termWidth) {
			return this.#cachedLines;
		}
		const lines = this.#renderLines(termWidth);
		if (animating) {
			this.#cachedLines = undefined;
			this.#cachedWidth = -1;
		} else {
			this.#cachedLines = lines;
			this.#cachedWidth = termWidth;
		}
		return lines;
	}

	#renderLines(termWidth: number): string[] {
		// Content keeps a column clear on each side; everything centers in the full width.
		const room = termWidth - 2;
		if (room < 4) return [];
		const logo = this.#currentLogoFrame();
		const version = theme.fg("dim", `v${this.version}`);
		const lockupWidth = LOGO_WIDTH + LOCKUP_GAP + Math.max(WORDMARK_WIDTH, visibleWidth(version));
		const hasLockup = room >= lockupWidth;
		const art = hasLockup ? lockup(logo, version) : room >= LOGO_WIDTH ? logo : [];
		return centerBlock(art, termWidth);
	}

	/** Pick the logo frame for the current intro phase, or the resting frame. */
	#currentLogoFrame(): readonly string[] {
		if (this.#animStart == null) return REST_FRAME;
		const elapsed = performance.now() - this.#animStart;
		if (elapsed >= INTRO_MS) return REST_FRAME;
		return introLogoFrame(elapsed / INTRO_MS);
	}
}

/**
 * omp's native lockup (`omp.welcome.lockup`, keyed `lockup`): the terminal's
 * builtin `omp` mark, which it draws on, beside the `omp` wordmark with
 * `v<version>` under it. The welcome card and the setup splash show it.
 */
export function lockupNode(version: string): NativeNode {
	// Brand lines are short and fixed; never wrap or truncate them.
	const art = (spans: readonly TspSpan[], role: string): NativeNode =>
		keyed(text(spans, { wrap: "none", role }), role);
	return keyed(
		row(
			[
				node("image", { builtin: "omp", alt: APP_NAME, w: 128, role: "omp.welcome.logo" }, undefined, "logo"),
				keyed(
					col(
						[
							art([span(APP_NAME, "strong")], "omp.welcome.wordmark"),
							art([span(`v${version}`, "dim mono")], "omp.welcome.version"),
						],
						{ role: "omp.welcome.mark" },
					),
					"mark",
				),
			],
			{ align: "center", gap: "md", role: "omp.welcome.lockup" },
		),
		"lockup",
	);
}

/** Block-grid brand mark shared by the welcome and setup surfaces. */
export const PI_LOGO = ["████████████", "   ██  ██   ", "   ██  ██   ", "   ▒▒  ██   ", "       ██   "];

/** Columns of {@link PI_LOGO}. */
const LOGO_WIDTH = Math.max(...PI_LOGO.map(row => row.length));

/**
 * The `omp` wordmark in half-blocks, set beside {@link PI_LOGO} from its second
 * row: the `p` descends into the fourth, the version takes the fifth.
 */
const WORDMARK = ["▄▀▀▄ █▀▄▀▄ █▀▀▄", "▀▄▄▀ █ █ █ █▄▄▀", "           █"];

/** Columns of {@link WORDMARK}. */
const WORDMARK_WIDTH = Math.max(...WORDMARK.map(row => row.length));

/** Columns between the logo and the wordmark. */
const LOCKUP_GAP = 4;

/** Logo frame `logo` with the wordmark beside it and `version` (styled) under the wordmark. */
function lockup(logo: readonly string[], version: string): string[] {
	const beside = ["", ...WORDMARK.map(row => theme.bold(theme.fg("text", row))), version];
	return logo.map((row, index) => `${row}${padding(LOCKUP_GAP)}${beside[index] ?? ""}`);
}

/**
 * `lines` indented as one block whose widest line is centered in `width`
 * columns; pass a single line to center it on its own.
 */
function centerBlock(lines: readonly string[], width: number): string[] {
	const widest = lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
	const indent = padding(Math.max(0, Math.floor((width - widest) / 2)));
	return lines.map(line => indent + line);
}

/** Multi-stop palette for the diagonal gradient. */
const GRADIENT_STOPS: ReadonlyArray<readonly [number, number, number]> = [
	[248, 79, 204], // oklch(0.7 0.24 340)
	[147, 98, 244], // oklch(0.62 0.21 295)
	[0, 219, 228], // oklch(0.81 0.14 200)
];

/** 256-color ramp fallback when truecolor isn't available. */
const GRADIENT_RAMP_256 = [206, 170, 134, 99, 69, 74, 44];

/** Half-width of the shine highlight band, expressed in gradient-t units. */
const SHINE_HALF_WIDTH = 0.18;

export interface ShineConfig {
	/** Overall opacity of the shine overlay, in [0, 1]. */
	strength: number;
	/** Center of the shine band along the diagonal, in [0, 1]. */
	pos: number;
}

/**
 * Resolve the gradient SGR foreground escape for a normalized position `t`
 * (0..1) along the diagonal, compositing the optional sliding shine highlight.
 * Shared by {@link gradientLogo} and the setup splash so both stay
 * color-identical (truecolor when available, 256-color ramp otherwise).
 */
export function gradientEscape(t: number, shine?: ShineConfig): string {
	const shineStrength = shine && shine.strength > 0 ? shine.strength : 0;
	const shinePos = shine ? shine.pos : 0;
	if (TERMINAL.trueColor) {
		// 5-stop palette widens the visible color range and avoids the
		// deep-blue valley a naive HSL lerp falls into.
		const stops = GRADIENT_STOPS;
		const seg = t * (stops.length - 1);
		const i = Math.min(stops.length - 2, Math.floor(seg));
		const f = seg - i;
		const a = stops[i];
		const b = stops[i + 1];
		let r = a[0] + (b[0] - a[0]) * f;
		let g = a[1] + (b[1] - a[1]) * f;
		let bl = a[2] + (b[2] - a[2]) * f;
		if (shineStrength > 0) {
			const dist = Math.abs(t - shinePos);
			const intensity = Math.max(0, 1 - dist / SHINE_HALF_WIDTH) * shineStrength;
			if (intensity > 0) {
				r += (255 - r) * intensity;
				g += (255 - g) * intensity;
				bl += (255 - bl) * intensity;
			}
		}
		return `\x1b[38;2;${Math.round(r)};${Math.round(g)};${Math.round(bl)}m`;
	}
	const ramp = GRADIENT_RAMP_256;
	let idx = Math.min(ramp.length - 1, Math.max(0, Math.floor(t * (ramp.length - 1) + 0.5)));
	if (shineStrength > 0) {
		const dist = Math.abs(t - shinePos);
		const intensity = Math.max(0, 1 - dist / SHINE_HALF_WIDTH) * shineStrength;
		// Promote to the brightest ramp slot when the shine band peaks here.
		if (intensity > 0.5) idx = ramp.length - 1;
	}
	return `\x1b[38;5;${ramp[idx]}m`;
}

/**
 * Apply a multi-stop diagonal gradient (top-left → bottom-right) plus an
 * optional sliding shine band across multi-line art. `phase` (0..1) shifts the
 * gradient along the diagonal, wrapping at 1. When `shine` is provided, a soft
 * white highlight is composited on top, centered at `shine.pos`.
 */
export function gradientLogo(lines: readonly string[], phase = 0, shine?: ShineConfig): string[] {
	const reset = "\x1b[0m";
	const rows = lines.length;
	const cols = Math.max(...lines.map(l => l.length));
	const xSpan = Math.max(1, cols - 1);
	const ySpan = Math.max(1, rows - 1);
	const normalizedPhase = ((phase % 1) + 1) % 1;
	return lines.map((line, y) => {
		let result = "";
		for (let x = 0; x < line.length; x++) {
			const char = line[x];
			if (char === " ") {
				result += char;
				continue;
			}
			// SVG's (0,0) → (1,1) gradient projects both normalized axes
			// equally: top-right and bottom-left land on the purple midpoint.
			const base = (x / xSpan + y / ySpan) / 2;
			const t = normalizedPhase === 0 ? base : (base + normalizedPhase) % 1;
			result += gradientEscape(t, shine) + char + reset;
		}
		return result;
	});
}

/** Total length of the intro animation. */
const INTRO_MS = 3000;
/** Render cadence during the intro (~30fps). */
const INTRO_TICK_MS = 33;
/** Number of full gradient rotations the sweep performs before settling. */
const INTRO_SWEEPS = 2.5;
/** Number of times the shine highlight crosses the diagonal across the intro. */
const INTRO_SHINE_TRAVERSALS = 3;

/**
 * Logo frame for a normalized intro progress in [0, 1).
 *
 * Ease-out cubic so the spin decelerates into the resting state. The gradient
 * sweeps backward through INTRO_SWEEPS full rotations (`eased == 1` → phase =
 * 0 = resting frame) while the shine traverses the diagonal at a steady pace,
 * decoupled from the gradient phase so the two layers parallax; its strength
 * fades with the same ease-out curve so the highlight is gone by the resting
 * frame.
 */
function introLogoFrame(progress: number): string[] {
	const eased = 1 - (1 - progress) ** 3;
	const phase = ((((1 - eased) * INTRO_SWEEPS) % 1) + 1) % 1;
	const shinePos = (((progress * INTRO_SHINE_TRAVERSALS) % 1) + 1) % 1;
	const shineStrength = (1 - eased) ** 1.5;
	return gradientLogo(PI_LOGO, phase, {
		strength: shineStrength,
		pos: shinePos,
	});
}

/** Resting gradient frame, cached for re-renders outside of the intro. */
const REST_FRAME = gradientLogo(PI_LOGO, 0);
