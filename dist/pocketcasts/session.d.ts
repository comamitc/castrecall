/**
 * Auth seam: the ONLY module that resolves Pocket Casts credentials, obtains
 * a session token, and re-authenticates on expiry — nothing outside this
 * file ever calls login()/fetchHistory() directly, keeping v0's "auth
 * confined to one module" invariant.
 *
 * Credential precedence: OS keychain (macOS Keychain / libsecret) when a
 * backend is available and both entries are present, else POCKETCASTS_EMAIL /
 * POCKETCASTS_PASSWORD env vars, else "none". Token precedence: in-memory
 * (process-lifetime) cache -> keychain token record -> fresh login. The
 * keychain is the only DURABLE sink; with no backend, or when
 * CASTRECALL_DISABLE_KEYCHAIN=1, the token still lives in the in-memory
 * cache for the process lifetime but is never written to disk.
 */
import { type ResolvedConfig } from "../config.js";
import { type FetchLike, type PocketCastsEpisode } from "./client.js";
import { type ExecImpl } from "./secret-store.js";
/** Conservative TTL for tokens whose expiry can't be parsed (non-JWT / no `exp`). */
export declare const DEFAULT_TOKEN_TTL_MS: number;
/** A token within this window of its expiry is treated as already expired. */
export declare const TOKEN_EXPIRY_SKEW_MS = 60000;
export type SessionDeps = {
    fetchImpl?: FetchLike;
    execImpl?: ExecImpl;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    now?: () => Date;
    /** Skip the durable keychain write on login — the token still lives in the in-memory cache. */
    skipTokenPersist?: boolean;
};
export type CredentialSource = "keychain" | "env" | "none";
export type ResolvedCredentials = {
    source: "keychain" | "env";
    email: string;
    password: string;
} | {
    source: "none";
};
/** Test isolation: resets the in-memory token cache and any in-flight login. */
export declare function clearPocketCastsSessionCache(): void;
/**
 * Resolve credentials with keychain precedence over env vars. Keychain reads
 * never throw (secret-store.ts degrades failures to "absent"), so a keychain
 * error here falls through to env, never to a hard failure.
 */
export declare function resolvePocketCastsCredentials(config: ResolvedConfig, deps?: SessionDeps): Promise<ResolvedCredentials>;
/**
 * Resolve credentials and return a valid session token, reusing the
 * in-memory cache or a durable keychain token record before logging in
 * fresh. Concurrent callers for the same service + credentialHash share one
 * in-flight login (single-flight); a different service or rotated
 * credentials starts a separate login rather than reusing another
 * context's in-flight promise.
 * `forceLogin` skips both cache lookups — used only by fetchHistoryWithSession's
 * post-401 retry, so a stale keychain record can never absorb that retry.
 */
export declare function getPocketCastsToken(config: ResolvedConfig, deps?: SessionDeps, forceLogin?: boolean): Promise<string>;
/**
 * Whether a durable token record currently exists in the keychain — a cheap,
 * read-only presence check for status surfaces (never validates expiry or
 * returns the value, so it never needs to touch the in-memory cache).
 */
export declare function hasCachedPocketCastsTokenRecord(config: ResolvedConfig, deps?: SessionDeps): Promise<boolean>;
/**
 * Fetch listening history with automatic re-authentication: on a 401/403
 * from the history endpoint, invalidates the cached token and retries with
 * exactly one fresh login. A second consecutive auth failure propagates
 * unchanged (so the pipeline's failure cooldown still engages).
 */
export declare function fetchHistoryWithSession(config: ResolvedConfig, deps?: SessionDeps): Promise<PocketCastsEpisode[]>;
