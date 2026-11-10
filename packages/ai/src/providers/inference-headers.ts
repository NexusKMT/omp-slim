import { USER_AGENT } from "@oh-my-pi/pi-utils";
export function setHeaderIfAbsent(headers: Record<string, string>, name: string, value: string): void {
	if (!Object.keys(headers).some(key => key.toLowerCase() === name.toLowerCase())) headers[name] = value;
}
export function withInferenceUserAgent(
	input: string | URL | Request,
	init: RequestInit | undefined,
): RequestInit | undefined {
	const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
	if (headers.has("User-Agent")) return init;
	headers.set("User-Agent", USER_AGENT);
	return { ...init, headers };
}
