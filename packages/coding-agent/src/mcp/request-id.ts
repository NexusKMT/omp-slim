import { Snowflake } from "@oh-my-pi/pi-utils";
import type { MCPRequestIdFormat } from "./types";

/**
 * Per-transport allocator for outgoing JSON-RPC request ids.
 *
 * JSON-RPC 2.0 permits String and Number ids equally. The default snowflake
 * string is collision-resistant across reconnects and process restarts, so it
 * stays the default. `"number"` exists for servers whose decoder accepts
 * integers only — Apple's `xcrun mcpbridge` logs `mcpbridge.DecodeError Code=1`
 * and never answers a string id, hanging every request until it times out.
 *
 * The counter is per instance and never reset, so ids stay unique for the life
 * of the transport even though a reconnect rejects and clears every pending
 * request.
 */
export class RequestIdAllocator {
	#previousNumeric = 0;

	next(format: MCPRequestIdFormat | undefined): string | number {
		return format === "number" ? ++this.#previousNumeric : Snowflake.next();
	}
}
