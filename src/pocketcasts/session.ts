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

import { createHash } from "node:crypto";
import { CastrecallSetupError, type ResolvedConfig } from "../config.js";
import {
  PocketCastsAuthError,
  fetchHistory,
  login,
  parseTokenExpiry,
  type FetchLike,
  type PocketCastsEpisode,
} from "./client.js";
import {
  deleteSecret,
  detectSecretBackend,
  readSecret,
  writeSecret,
  type ExecImpl,
} from "./secret-store.js";

const TOKEN_ACCOUNT = "pocketcasts-token";
const EMAIL_ACCOUNT = "pocketcasts-email";
const PASSWORD_ACCOUNT = "pocketcasts-password";

/** Conservative TTL for tokens whose expiry can't be parsed (non-JWT / no `exp`). */
export const DEFAULT_TOKEN_TTL_MS = 12 * 60 * 60_000;
/** A token within this window of its expiry is treated as already expired. */
export const TOKEN_EXPIRY_SKEW_MS = 60_000;

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

export type ResolvedCredentials =
  | { source: "keychain" | "env"; email: string; password: string }
  | { source: "none" };

type CachedToken = {
  service: string;
  credentialHash: string;
  token: string;
  expiresAt: number;
  /** Whether a durable keychain write was attempted for this token — a
   * verification login (skipTokenPersist) seeds the cache unpersisted, and
   * the next non-skip caller must persist it before returning. */
  persisted: boolean;
};

type TokenRecord = { token: string; expiresAt: number; credentialHash: string };

let cache: CachedToken | undefined;
const inFlightLogins = new Map<string, Promise<string>>();
/**
 * Serializes durable token writes/deletes per service so a delayed persist
 * can never run after (and undo) a 401 invalidation's keychain delete: the
 * write re-checks that its entry is still the active cache INSIDE the
 * critical section, and an invalidation queued behind an in-flight write
 * simply deletes afterwards — either order converges to the correct state.
 */
const tokenWriteLocks = new Map<string, Promise<unknown>>();

async function withTokenWriteLock<T>(service: string, fn: () => Promise<T>): Promise<T> {
  const prev = tokenWriteLocks.get(service) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  tokenWriteLocks.set(service, run.then(
    () => undefined,
    () => undefined,
  ));
  return run;
}

/** Test isolation: resets the in-memory token cache and any in-flight login. */
export function clearPocketCastsSessionCache(): void {
  cache = undefined;
  inFlightLogins.clear();
  tokenWriteLocks.clear();
}

function credentialHash(email: string, password: string): string {
  return createHash("sha256").update(`${email}\n${password}`, "utf8").digest("hex");
}

/**
 * Resolve credentials with keychain precedence over env vars. Keychain reads
 * never throw (secret-store.ts degrades failures to "absent"), so a keychain
 * error here falls through to env, never to a hard failure.
 */
export async function resolvePocketCastsCredentials(
  config: ResolvedConfig,
  deps: SessionDeps = {},
): Promise<ResolvedCredentials> {
  const detection = await detectSecretBackend(config, { env: deps.env, platform: deps.platform });
  if (detection.backend) {
    const [email, password] = await Promise.all([
      readSecret(detection.backend, config.secrets.service, EMAIL_ACCOUNT, { execImpl: deps.execImpl }),
      readSecret(detection.backend, config.secrets.service, PASSWORD_ACCOUNT, { execImpl: deps.execImpl }),
    ]);
    if (email && password) return { source: "keychain", email, password };
  }
  const { email, password } = config.pocketcasts;
  if (email && password) return { source: "env", email, password };
  return { source: "none" };
}

async function readCachedTokenFromKeychain(
  config: ResolvedConfig,
  deps: SessionDeps,
  hash: string,
  nowMs: number,
): Promise<string | undefined> {
  const detection = await detectSecretBackend(config, { env: deps.env, platform: deps.platform });
  if (!detection.backend) return undefined;
  const raw = await readSecret(detection.backend, config.secrets.service, TOKEN_ACCOUNT, {
    execImpl: deps.execImpl,
  });
  if (!raw) return undefined;
  let record: Partial<TokenRecord>;
  try {
    record = JSON.parse(raw) as Partial<TokenRecord>;
  } catch {
    return undefined;
  }
  if (
    typeof record.token !== "string" ||
    typeof record.expiresAt !== "number" ||
    record.credentialHash !== hash
  ) {
    return undefined;
  }
  if (nowMs + TOKEN_EXPIRY_SKEW_MS >= record.expiresAt) return undefined;
  cache = { service: config.secrets.service, credentialHash: hash, token: record.token, expiresAt: record.expiresAt, persisted: true };
  return record.token;
}

/** Best-effort durable persistence — a write failure never blocks the caller. */
async function persistTokenToKeychain(
  config: ResolvedConfig,
  deps: SessionDeps,
  hash: string,
  token: string,
  expiresAt: number,
): Promise<void> {
  const detection = await detectSecretBackend(config, { env: deps.env, platform: deps.platform });
  if (!detection.backend) return;
  const record: TokenRecord = { token, expiresAt, credentialHash: hash };
  try {
    await writeSecret(detection.backend, config.secrets.service, TOKEN_ACCOUNT, JSON.stringify(record), {
      execImpl: deps.execImpl,
    });
  } catch {
    // Token survives in the in-memory cache; a keychain write failure never fails the sync.
  }
}

/** Best-effort: clears the in-memory cache and, if possible, the durable keychain token record. */
async function invalidateSession(config: ResolvedConfig, deps: SessionDeps): Promise<void> {
  cache = undefined;
  const detection = await detectSecretBackend(config, { env: deps.env, platform: deps.platform });
  if (!detection.backend) return;
  try {
    await withTokenWriteLock(config.secrets.service, () =>
      deleteSecret(detection.backend!, config.secrets.service, TOKEN_ACCOUNT, { execImpl: deps.execImpl }),
    );
  } catch {
    // Ignored: the in-memory invalidation above is the correctness-bearing step; a stale
    // keychain entry is harmless because the forced re-login below never reads the cache.
  }
}

async function loginAndCache(
  config: ResolvedConfig,
  deps: SessionDeps,
  email: string,
  password: string,
  hash: string,
  nowMs: number,
): Promise<string> {
  const token = await login(email, password, deps.fetchImpl);
  const expiresAt = parseTokenExpiry(token) ?? nowMs + DEFAULT_TOKEN_TTL_MS;
  const entry: CachedToken = {
    service: config.secrets.service,
    credentialHash: hash,
    token,
    expiresAt,
    persisted: !deps.skipTokenPersist,
  };
  cache = entry;
  if (entry.persisted) {
    await withTokenWriteLock(config.secrets.service, async () => {
      // Skip the write if an invalidation raced in after this login: a
      // stale persist must never durably resurrect a deleted token.
      if (cache !== entry) return;
      await persistTokenToKeychain(config, deps, hash, token, expiresAt);
    });
  }
  return token;
}

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
export async function getPocketCastsToken(
  config: ResolvedConfig,
  deps: SessionDeps = {},
  forceLogin = false,
): Promise<string> {
  const resolved = await resolvePocketCastsCredentials(config, deps);
  if (resolved.source === "none") {
    throw new CastrecallSetupError(
      "Pocket Casts credentials are not configured. Set POCKETCASTS_EMAIL and POCKETCASTS_PASSWORD " +
        "in the environment OpenClaw runs in, or store them in the OS keychain (macOS Keychain / " +
        `libsecret) under service "${config.secrets.service}" as accounts "${EMAIL_ACCOUNT}" and ` +
        `"${PASSWORD_ACCOUNT}" — see the CastRecall README, 'First-run setup'.`,
    );
  }
  const { email, password } = resolved;
  const hash = credentialHash(email, password);
  const nowMs = (deps.now ?? (() => new Date()))().getTime();

  if (!forceLogin) {
    const entry = cache;
    if (
      entry &&
      entry.service === config.secrets.service &&
      entry.credentialHash === hash &&
      nowMs + TOKEN_EXPIRY_SKEW_MS < entry.expiresAt
    ) {
      // A verification login may have seeded this token without a durable
      // write; the first non-skip caller persists it so a process restart
      // does not force a fresh password login. Everything below operates on
      // the CAPTURED entry, never the module global: during the persist
      // await, a 401 invalidation or another credential context may replace
      // `cache`, and re-reading it here could throw or return a token for
      // credentials other than the ones this caller resolved.
      await upgradeToPersisted(config, deps, entry);
      return entry.token;
    }
    const fromKeychain = await readCachedTokenFromKeychain(config, deps, hash, nowMs);
    if (fromKeychain) return fromKeychain;
  }

  const flightKey = `${config.secrets.service}\n${hash}`;
  let flight = inFlightLogins.get(flightKey);
  if (!flight) {
    flight = loginAndCache(config, deps, email, password, hash, nowMs).finally(() => {
      if (inFlightLogins.get(flightKey) === flight) inFlightLogins.delete(flightKey);
    });
    inFlightLogins.set(flightKey, flight);
  }
  const token = await flight;
  // A non-skip caller that joined a flight started by setup verification
  // (skipTokenPersist) would otherwise return a token that was never written
  // durably — the shared login used the FIRST caller's deps. Upgrade the
  // cached entry to persisted if it is the one this flight produced.
  const settled = cache;
  if (
    settled &&
    settled.service === config.secrets.service &&
    settled.credentialHash === hash &&
    settled.token === token
  ) {
    await upgradeToPersisted(config, deps, settled);
  }
  return token;
}

/**
 * Persist a cached-but-unpersisted token for a non-skip caller. Operates on
 * a captured entry (never the module-global `cache`) so concurrent
 * invalidation/replacement can't misdirect the flag or the write; marking a
 * since-replaced entry is harmless because nothing reads it anymore.
 */
async function upgradeToPersisted(
  config: ResolvedConfig,
  deps: SessionDeps,
  entry: CachedToken,
): Promise<void> {
  if (entry.persisted || deps.skipTokenPersist) return;
  await withTokenWriteLock(config.secrets.service, async () => {
    // Re-check INSIDE the critical section: if a 401 invalidation (which
    // also serializes through this lock) cleared or replaced the entry, the
    // durable write must be skipped — persisting now would resurrect a
    // token the invalidation just deleted.
    if (cache !== entry || entry.persisted) return;
    await persistTokenToKeychain(config, deps, entry.credentialHash, entry.token, entry.expiresAt);
    entry.persisted = true;
  });
}

/**
 * Whether a durable token record currently exists in the keychain — a cheap,
 * read-only presence check for status surfaces (never validates expiry or
 * returns the value, so it never needs to touch the in-memory cache).
 */
export async function hasCachedPocketCastsTokenRecord(
  config: ResolvedConfig,
  deps: SessionDeps = {},
): Promise<boolean> {
  const detection = await detectSecretBackend(config, { env: deps.env, platform: deps.platform });
  if (!detection.backend) return false;
  const raw = await readSecret(detection.backend, config.secrets.service, TOKEN_ACCOUNT, {
    execImpl: deps.execImpl,
  });
  return Boolean(raw);
}

/**
 * Fetch listening history with automatic re-authentication: on a 401/403
 * from the history endpoint, invalidates the cached token and retries with
 * exactly one fresh login. A second consecutive auth failure propagates
 * unchanged (so the pipeline's failure cooldown still engages).
 */
export async function fetchHistoryWithSession(
  config: ResolvedConfig,
  deps: SessionDeps = {},
): Promise<PocketCastsEpisode[]> {
  const token = await getPocketCastsToken(config, deps);
  try {
    return await fetchHistory(token, deps.fetchImpl);
  } catch (error) {
    if (!(error instanceof PocketCastsAuthError)) throw error;
    await invalidateSession(config, deps);
    const freshToken = await getPocketCastsToken(config, deps, true);
    return fetchHistory(freshToken, deps.fetchImpl);
  }
}
