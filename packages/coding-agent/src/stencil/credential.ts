const STENCIL_AUTH_ENV = "STENCIL_API_KEY";
const STENCIL_AUTH_PROVIDER = "stencil";
import { discoverAuthStorage } from "../sdk";
import type { AuthStorage } from "../session/auth-storage";

/**
 * Bearer credential presented to Stencil services (`omp skill`).
 *
 * `STENCIL_API_KEY` wins outright (debug and CI: `STENCIL_API_KEY=test omp
 * stream …`); otherwise the stencil.so credential stored as an API key is used
 * and re-resolved on every call so a refreshed access token is sent after a
 * reconnect. `resolve()` returns null when neither exists.
 */
export class StencilCredential {
	#storage?: AuthStorage;

	async resolve(): Promise<string | null> {
		const fromEnv = process.env[STENCIL_AUTH_ENV]?.trim();
		if (fromEnv) return fromEnv;
		this.#storage ??= await discoverAuthStorage();
		const token = await this.#storage.keys.get(STENCIL_AUTH_PROVIDER);
		return token?.trim() || null;
	}

	/** Human guidance for a missing credential. */
	static get missingMessage(): string {
		return `a stencil.so account is required: run omp and configure a stencil API key, or set ${STENCIL_AUTH_ENV}`;
	}

	close(): void {
		this.#storage?.close();
		this.#storage = undefined;
	}
}
