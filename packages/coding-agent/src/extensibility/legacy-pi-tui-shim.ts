/**
 * Compatibility shim for legacy extensions importing the package root of
 * `@earendil-works/pi-tui` or `@mariozechner/pi-tui`.
 *
 * The historical root exported `decodeKittyPrintable`; the canonical TUI now
 * exposes the equivalent, broader `decodePrintableKey` helper. Keep the legacy
 * name available without reintroducing it into the canonical package surface.
 */
import { ImageProtocol, isInsideTmux, TERMINAL, wrapTmuxPassthrough } from "@oh-my-pi/pi-tui";

export * from "@oh-my-pi/pi-tui";
export {
	decodePrintableKey as decodeKittyPrintable,
	encodeKittyDeleteImage as deleteKittyImage,
} from "@oh-my-pi/pi-tui";

/** Report canonical terminal capabilities through the legacy Pi TUI shape. */
export function getCapabilities(): {
	images: "kitty" | "iterm2" | null;
	trueColor: boolean;
	hyperlinks: boolean;
} {
	const images =
		TERMINAL.imageProtocol === ImageProtocol.Kitty
			? "kitty"
			: TERMINAL.imageProtocol === ImageProtocol.Iterm2
				? "iterm2"
				: null;
	return { images, trueColor: TERMINAL.trueColor, hyperlinks: TERMINAL.hyperlinks };
}

/** Delete every Kitty graphics image using the legacy Pi TUI control sequence. */
export function deleteAllKittyImages(): string {
	const sequence = "\x1b_Ga=d,d=A,q=2\x1b\\";
	return isInsideTmux() ? wrapTmuxPassthrough(sequence) : sequence;
}
