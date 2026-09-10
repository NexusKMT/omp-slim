/**
 * Framing for a session-store failure on a headless surface.
 *
 * Outside the TUI there is no banner and `logger.error` never touches stdio by
 * design, so a store that stops accepting entries used to fail silently for a
 * scripted run. Print mode reports this on stderr and RPC mode on the `notice`
 * channel; both use the same one-line rendering (issue #11493).
 */
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "../tools/render-utils";

/**
 * Collapse an error message into one control-free line, matching the
 * interactive warning's sanitizing idiom (`sanitizeText` leaves tabs and
 * newlines intact, so both are normalized afterwards).
 */
export function formatPersistenceFailure(message: string): string {
	const detail = truncateToWidth(replaceTabs(sanitizeText(message)).replace(/[\r\n]+/g, " "), TRUNCATE_LENGTHS.LINE);
	return `Session persistence failed: ${detail}. Unsaved entries remain in memory; the session transcript is not durable.`;
}
