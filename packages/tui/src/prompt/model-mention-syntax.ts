/** Historical model tags retained for session replay and message display. */
import type { Effort } from "@oh-my-pi/pi-catalog/effort";

/** Submitted historical mention; groups are agent pseudonym and display name. */
export const MODEL_MENTION_TAG_RE = /<model agent="(m\d+)" name="([^"]*)"\/>/g;

/** A model pseudonym recorded by an older session. */
export interface ModelMention {
	agent: string;
	/** Canonical selector: `provider/id`, plus `:<effort>` when the tag names one. */
	selector: string;
	name: string;
	/** Initial effort from the tag's `:<level>` suffix; absent keeps the agent's default policy. */
	thinkingLevel?: Effort;
}
