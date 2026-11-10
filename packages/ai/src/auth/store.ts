import type { AuthCredential, StoredAuthCredential } from "./types";
/** API-key persistence only. Legacy OAuth rows are never returned or used. */
export interface AuthCredentialStore {
	close(): void;
	listAuthCredentials(provider?: string): StoredAuthCredential[];
	replaceAuthCredentials(provider: string, credentials: AuthCredential[]): Promise<StoredAuthCredential[]>;
	upsertAuthCredential(provider: string, credential: AuthCredential): Promise<StoredAuthCredential[]>;
	deleteAuthCredentials(provider: string, disabledCause: string): Promise<void>;
	deleteAuthCredential(id: number, disabledCause: string): Promise<boolean>;
	pollExternalChanges?(): boolean;
	acknowledgeLocalChanges?(): void;
}
