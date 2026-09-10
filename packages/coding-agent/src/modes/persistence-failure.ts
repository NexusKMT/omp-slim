import { sanitizeText } from "@oh-my-pi/pi-utils";
import { replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "../tools/render-utils";

/**
 * `sanitizeText` leaves tabs and newlines intact, so both are normalized here
 * to keep the result on one line.
 */
export function formatPersistenceFailure(message: string): string {
	const detail = truncateToWidth(replaceTabs(sanitizeText(message)).replace(/[\r\n]+/g, " "), TRUNCATE_LENGTHS.LINE);
	return `Session persistence failed: ${detail}. Unsaved entries remain in memory; the session transcript is not durable.`;
}
