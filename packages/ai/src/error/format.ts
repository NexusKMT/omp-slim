import { type CapturedHttpErrorResponse, finalizeErrorMessage, type RawHttpRequestDump } from "../utils/http-inspector";
import { formatErrorMessageWithRetryAfter } from "../utils/retry-after";

export interface FormatMessageOptions {
	rawRequestDump?: RawHttpRequestDump;
	capturedErrorResponse?: CapturedHttpErrorResponse;
}

/** Include captured HTTP diagnostics and retry hints when available. */
export async function formatMessage(error: unknown, opts: FormatMessageOptions = {}): Promise<string> {
	return opts.rawRequestDump
		? finalizeErrorMessage(error, opts.rawRequestDump, opts.capturedErrorResponse)
		: formatErrorMessageWithRetryAfter(error);
}
