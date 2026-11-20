import type { CapturedHttpErrorResponse } from "../utils/http-inspector";

/** Structured HTTP errors thrown by provider clients. */
export interface ProviderHttpErrorOptions {
	/** Response headers; enables `retry-after`/rate-limit extraction downstream. */
	headers?: Headers;
	/** Machine-readable error code from the response body (`error.code` / `error.type`). */
	code?: string;
	cause?: unknown;
}

/** Non-2xx HTTP response from a provider. */
export class ProviderHttpError extends Error {
	readonly status: number;
	readonly headers: Headers | undefined;
	readonly code: string | undefined;

	constructor(message: string, status: number, options?: ProviderHttpErrorOptions) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ProviderHttpError";
		this.status = status;
		this.headers = options?.headers;
		this.code = options?.code;
	}
}

/** Non-2xx response from an OpenAI-wire endpoint, with the decoded body attached. */
export class OpenAIHttpError extends ProviderHttpError {
	readonly captured: CapturedHttpErrorResponse;

	constructor(message: string, captured: CapturedHttpErrorResponse, code?: string, cause?: unknown) {
		super(message, captured.status, { headers: captured.headers, code, cause });
		this.name = "OpenAIHttpError";
		this.captured = captured;
	}

	/**
	 * Pull a human-readable message and machine code out of an OpenAI-style error
	 * envelope (`{ error: { message, code, type } }`), tolerating the flat shapes
	 * compat hosts return (`{ error: "..." }`, `{ message: "..." }`) and falling
	 * back to the raw body text.
	 */
	static parseEnvelope(
		bodyJson: unknown,
		bodyText: string | undefined,
	): { detail: string | undefined; code: string | undefined } {
		if (typeof bodyJson === "object" && bodyJson !== null) {
			const envelope = bodyJson as { error?: unknown; message?: unknown };
			const error = envelope.error;
			if (typeof error === "object" && error !== null) {
				const { message, code, type } = error as { message?: unknown; code?: unknown; type?: unknown };
				return {
					detail: typeof message === "string" && message.length > 0 ? message : bodyText,
					code: typeof code === "string" ? code : typeof type === "string" ? type : undefined,
				};
			}
			if (typeof error === "string" && error.length > 0) {
				return { detail: error, code: undefined };
			}
			if (typeof envelope.message === "string" && envelope.message.length > 0) {
				return { detail: envelope.message, code: undefined };
			}
		}
		return { detail: bodyText, code: undefined };
	}
}
