/**
 * Shared fetch retry primitive for transient failures (network errors, 5xx, 429).
 *
 * Deliberately self-contained (no import from ./pocketcasts/client.js) so
 * retry.ts and client.ts can never form an import cycle; FetchLike is
 * redefined locally rather than re-exported.
 *
 * These backoff constants are request-scale (worst case ~750ms across two
 * retries with the defaults below) and are intentionally independent of
 * storage.ts's BACKOFF_BASE_MS/BACKOFF_CAP_MS, which govern the cross-run
 * sync cooldown gate (5-60 minutes). Reusing the cooldown-scale constants
 * here would stall an in-progress sync for minutes on a single transient
 * blip; the two mechanisms are complementary, not shared.
 */
export type FetchLike = typeof fetch;
/** Base delay for the first retry, in milliseconds. */
export declare const RETRY_BASE_MS = 250;
/** Upper bound on any single retry delay, in milliseconds. */
export declare const RETRY_CAP_MS = 2000;
/** Total fetch invocations attempted, including the first — not "retries". */
export declare const RETRY_MAX_ATTEMPTS = 3;
export type RetryOptions = {
    /** Total fetch invocations including the first. `1` disables retrying. */
    maxAttempts?: number;
    baseMs?: number;
    capMs?: number;
    sleep?: (ms: number) => Promise<void>;
};
export declare function isRetryableStatus(status: number): boolean;
/**
 * Retries `fetchImpl` on network errors or a retryable HTTP status
 * (429/5xx), with capped exponential backoff. Never retries and never
 * inspects any other status (incl. 401/403) — the `Response` is returned
 * untouched so callers' existing status branches (auth errors, etc.) run
 * unchanged. Never reads request/response bodies or auth headers; the only
 * header it reads is `Retry-After`, used solely as a delay.
 */
export declare function fetchWithRetry(fetchImpl: FetchLike, url: string, init?: RequestInit, opts?: RetryOptions): Promise<Response>;
