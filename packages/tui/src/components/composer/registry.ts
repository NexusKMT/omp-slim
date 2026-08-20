import { borderlessComposerStyle } from "./borderless";
import { boxComposerStyle } from "./box";
import { claudeComposerStyle } from "./claude";
import { piComposerStyle } from "./pi";
import type { ComposerStyle, EditorBorderStyle } from "./types";

const COMPOSER_STYLES: Record<EditorBorderStyle, ComposerStyle> = {
	box: boxComposerStyle,
	claude: claudeComposerStyle,
	pi: piComposerStyle,
	borderless: borderlessComposerStyle,
};

/** Style object for a composer shape; unknown ids fall back to `box`. */
export function getComposerStyle(id: EditorBorderStyle): ComposerStyle {
	return COMPOSER_STYLES[id] ?? boxComposerStyle;
}
