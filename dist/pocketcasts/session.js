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
import { CastrecallSetupError } from "../config.js";
import { PocketCastsAuthError, fetchHistory, login, parseTokenExpiry, } from "./client.js";
import { deleteSecret, detectSecretBackend, readSecret, writeSecret, } from "./secret-store.js";
const TOKEN_ACCOUNT = "pocketcasts-token";
const EMAIL_ACCOUNT = "pocketcasts-email";
const PASSWORD_ACCOUNT = "pocketcasts-password";
/** Conservative TTL for tokens whose expiry can't be parsed (non-JWT / no `exp`). */
export const DEFAULT_TOKEN_TTL_MS = 12 * 60 * 60_000;
/** A token within this window of its expiry is treated as already expired. */
export const TOKEN_EXPIRY_SKEW_MS = 60_000;
let cache;
let inFlightLogin;
/** Test isolation: resets the in-memory token cache and any in-flight login. */
export function clearPocketCastsSessionCache() {
    cache = undefined;
    inFlightLogin = undefined;
}
function credentialHash(email, password) {
    return createHash("sha256").update(`${email}\n${password}`, "utf8").digest("hex");
}
/**
 * Resolve credentials with keychain precedence over env vars. Keychain reads
 * never throw (secret-store.ts degrades failures to "absent"), so a keychain
 * error here falls through to env, never to a hard failure.
 */
export async function resolvePocketCastsCredentials(config, deps = {}) {
    const detection = await detectSecretBackend(config, { env: deps.env, platform: deps.platform });
    if (detection.backend) {
        const [email, password] = await Promise.all([
            readSecret(detection.backend, config.secrets.service, EMAIL_ACCOUNT, { execImpl: deps.execImpl }),
            readSecret(detection.backend, config.secrets.service, PASSWORD_ACCOUNT, { execImpl: deps.execImpl }),
        ]);
        if (email && password)
            return { source: "keychain", email, password };
    }
    const { email, password } = config.pocketcasts;
    if (email && password)
        return { source: "env", email, password };
    return { source: "none" };
}
async function readCachedTokenFromKeychain(config, deps, hash, nowMs) {
    const detection = await detectSecretBackend(config, { env: deps.env, platform: deps.platform });
    if (!detection.backend)
        return undefined;
    const raw = await readSecret(detection.backend, config.secrets.service, TOKEN_ACCOUNT, {
        execImpl: deps.execImpl,
    });
    if (!raw)
        return undefined;
    let record;
    try {
        record = JSON.parse(raw);
    }
    catch {
        return undefined;
    }
    if (typeof record.token !== "string" ||
        typeof record.expiresAt !== "number" ||
        record.credentialHash !== hash) {
        return undefined;
    }
    if (nowMs + TOKEN_EXPIRY_SKEW_MS >= record.expiresAt)
        return undefined;
    cache = { service: config.secrets.service, credentialHash: hash, token: record.token, expiresAt: record.expiresAt };
    return record.token;
}
/** Best-effort durable persistence — a write failure never blocks the caller. */
async function persistTokenToKeychain(config, deps, hash, token, expiresAt) {
    const detection = await detectSecretBackend(config, { env: deps.env, platform: deps.platform });
    if (!detection.backend)
        return;
    const record = { token, expiresAt, credentialHash: hash };
    try {
        await writeSecret(detection.backend, config.secrets.service, TOKEN_ACCOUNT, JSON.stringify(record), {
            execImpl: deps.execImpl,
        });
    }
    catch {
        // Token survives in the in-memory cache; a keychain write failure never fails the sync.
    }
}
/** Best-effort: clears the in-memory cache and, if possible, the durable keychain token record. */
async function invalidateSession(config, deps) {
    cache = undefined;
    const detection = await detectSecretBackend(config, { env: deps.env, platform: deps.platform });
    if (!detection.backend)
        return;
    try {
        await deleteSecret(detection.backend, config.secrets.service, TOKEN_ACCOUNT, { execImpl: deps.execImpl });
    }
    catch {
        // Ignored: the in-memory invalidation above is the correctness-bearing step; a stale
        // keychain entry is harmless because the forced re-login below never reads the cache.
    }
}
async function loginAndCache(config, deps, email, password, hash, nowMs) {
    const token = await login(email, password, deps.fetchImpl);
    const expiresAt = parseTokenExpiry(token) ?? nowMs + DEFAULT_TOKEN_TTL_MS;
    cache = { service: config.secrets.service, credentialHash: hash, token, expiresAt };
    if (!deps.skipTokenPersist) {
        await persistTokenToKeychain(config, deps, hash, token, expiresAt);
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
export async function getPocketCastsToken(config, deps = {}, forceLogin = false) {
    const resolved = await resolvePocketCastsCredentials(config, deps);
    if (resolved.source === "none") {
        throw new CastrecallSetupError("Pocket Casts credentials are not configured. Set POCKETCASTS_EMAIL and POCKETCASTS_PASSWORD " +
            "in the environment OpenClaw runs in, or store them in the OS keychain (macOS Keychain / " +
            `libsecret) under service "${config.secrets.service}" as accounts "${EMAIL_ACCOUNT}" and ` +
            `"${PASSWORD_ACCOUNT}" — see the CastRecall README, 'First-run setup'.`);
    }
    const { email, password } = resolved;
    const hash = credentialHash(email, password);
    const nowMs = (deps.now ?? (() => new Date()))().getTime();
    if (!forceLogin) {
        if (cache &&
            cache.service === config.secrets.service &&
            cache.credentialHash === hash &&
            nowMs + TOKEN_EXPIRY_SKEW_MS < cache.expiresAt) {
            return cache.token;
        }
        const fromKeychain = await readCachedTokenFromKeychain(config, deps, hash, nowMs);
        if (fromKeychain)
            return fromKeychain;
    }
    if (!inFlightLogin ||
        inFlightLogin.service !== config.secrets.service ||
        inFlightLogin.credentialHash !== hash) {
        const promise = loginAndCache(config, deps, email, password, hash, nowMs).finally(() => {
            if (inFlightLogin?.promise === promise)
                inFlightLogin = undefined;
        });
        inFlightLogin = { service: config.secrets.service, credentialHash: hash, promise };
    }
    return inFlightLogin.promise;
}
/**
 * Whether a durable token record currently exists in the keychain — a cheap,
 * read-only presence check for status surfaces (never validates expiry or
 * returns the value, so it never needs to touch the in-memory cache).
 */
export async function hasCachedPocketCastsTokenRecord(config, deps = {}) {
    const detection = await detectSecretBackend(config, { env: deps.env, platform: deps.platform });
    if (!detection.backend)
        return false;
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
export async function fetchHistoryWithSession(config, deps = {}) {
    const token = await getPocketCastsToken(config, deps);
    try {
        return await fetchHistory(token, deps.fetchImpl);
    }
    catch (error) {
        if (!(error instanceof PocketCastsAuthError))
            throw error;
        await invalidateSession(config, deps);
        const freshToken = await getPocketCastsToken(config, deps, true);
        return fetchHistory(freshToken, deps.fetchImpl);
    }
}
