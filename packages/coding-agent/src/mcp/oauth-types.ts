import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

export interface OAuthCredentials {
	access: string;
	refresh: string;
	expires: number;
}

export interface OAuthAuthInfo {
	url: string;
	launchUrl?: string;
	instructions?: string;
}

export interface OAuthController {
	onAuth?(info: OAuthAuthInfo): void;
	onProgress?(message: string): void;
	onManualCodeInput?(signal?: AbortSignal): Promise<string>;
	signal?: AbortSignal;
	fetch?: FetchImpl;
}
