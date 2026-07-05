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
export const RETRY_BASE_MS = 250;
/** Upper bound on any single retry delay, in milliseconds. */
export const RETRY_CAP_MS = 2_000;
/** Total fetch invocations attempted, including the first — not "retries". */
export const RETRY_MAX_ATTEMPTS = 3;

export type RetryOptions = {
  /** Total fetch invocations including the first. `1` disables retrying. */
  maxAttempts?: number;
  baseMs?: number;
  capMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function backoffDelayMs(attempt: number, baseMs: number, capMs: number): number {
  return Math.min(baseMs * 2 ** (attempt - 1), capMs);
}

/** Parses a `Retry-After` header as whole seconds; anything else falls back to exponential backoff. */
function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  if (!/^\d+$/.test(header.trim())) return undefined;
  return Number(header.trim()) * 1000;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries `fetchImpl` on network errors or a retryable HTTP status
 * (429/5xx), with capped exponential backoff. Never retries and never
 * inspects any other status (incl. 401/403) — the `Response` is returned
 * untouched so callers' existing status branches (auth errors, etc.) run
 * unchanged. Never reads request/response bodies or auth headers; the only
 * header it reads is `Retry-After`, used solely as a delay.
 */
export async function fetchWithRetry(
  fetchImpl: FetchLike,
  url: string,
  init?: RequestInit,
  opts: RetryOptions = {},
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? RETRY_MAX_ATTEMPTS;
  const baseMs = opts.baseMs ?? RETRY_BASE_MS;
  const capMs = opts.capMs ?? RETRY_CAP_MS;
  const sleep = opts.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      if (attempt === maxAttempts) throw error;
      await sleep(backoffDelayMs(attempt, baseMs, capMs));
      continue;
    }
    if (!isRetryableStatus(response.status)) return response;
    if (attempt === maxAttempts) return response;
    const delay =
      response.status === 429
        ? Math.min(retryAfterMs(response) ?? backoffDelayMs(attempt, baseMs, capMs), capMs)
        : backoffDelayMs(attempt, baseMs, capMs);
    await sleep(delay);
  }
  // Unreachable: maxAttempts >= 1 guarantees the loop above returns or throws.
  throw new Error("fetchWithRetry: unreachable");
}
