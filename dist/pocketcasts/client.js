/**
 * Read-only Pocket Casts adapter.
 *
 * Pocket Casts has NO official public API. These endpoints are the same
 * reverse-engineered web-player endpoints used by community tools
 * (e.g. essoen/PocketCasts-mcp) and may break or be blocked at any time.
 * CastRecall only ever calls read endpoints; no playback mutation exists here.
 */
import { CastrecallSetupError } from "../config.js";
const API_BASE = "https://api.pocketcasts.com";
export class PocketCastsAuthError extends CastrecallSetupError {
    constructor(message) {
        super(message);
        this.name = "PocketCastsAuthError";
    }
}
export class PocketCastsApiError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
        this.name = "PocketCastsApiError";
    }
}
/**
 * Exchange email/password for a short-lived bearer token.
 * The token is held in memory by the caller only; CastRecall never writes
 * credentials or tokens to disk and never includes them in errors or logs.
 */
export async function login(email, password, fetchImpl = fetch) {
    let response;
    try {
        response = await fetchImpl(`${API_BASE}/user/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email, password, scope: "webplayer" }),
        });
    }
    catch (error) {
        throw new PocketCastsApiError(`Could not reach the Pocket Casts API (${describeNetworkError(error)}). ` +
            "The unofficial API may be down or blocked.");
    }
    if (response.status === 401 || response.status === 403) {
        throw new PocketCastsAuthError("Pocket Casts rejected the configured credentials. Check POCKETCASTS_EMAIL and " +
            "POCKETCASTS_PASSWORD. Note: accounts created via 'Sign in with Google/Apple' " +
            "have no password and cannot use this integration until Pocket Casts ships an official API.");
    }
    if (!response.ok) {
        throw new PocketCastsApiError(`Pocket Casts login failed with HTTP ${response.status}. The unofficial API may have changed.`, response.status);
    }
    const body = (await response.json());
    if (!body.token) {
        throw new PocketCastsApiError("Pocket Casts login succeeded but returned no token; the unofficial API shape may have changed.");
    }
    return body.token;
}
/** Fetch the account's listening history (read-only). Newest first. */
export async function fetchHistory(token, fetchImpl = fetch) {
    let response;
    try {
        response = await fetchImpl(`${API_BASE}/user/history`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({}),
        });
    }
    catch (error) {
        throw new PocketCastsApiError(`Could not reach the Pocket Casts history endpoint (${describeNetworkError(error)}).`);
    }
    if (response.status === 401 || response.status === 403) {
        throw new PocketCastsAuthError("Pocket Casts session expired or was rejected; try again.");
    }
    if (!response.ok) {
        throw new PocketCastsApiError(`Pocket Casts history request failed with HTTP ${response.status}.`, response.status);
    }
    const body = (await response.json());
    if (!Array.isArray(body.episodes)) {
        throw new PocketCastsApiError("Pocket Casts history response had no 'episodes' array; the unofficial API shape may have changed.");
    }
    return body.episodes
        .filter((raw) => typeof raw === "object" && raw !== null)
        .filter((raw) => typeof raw.uuid === "string" && typeof raw.title === "string")
        .map((raw) => ({
        uuid: raw.uuid,
        title: raw.title,
        url: typeof raw.url === "string" ? raw.url : "",
        published: typeof raw.published === "string" ? raw.published : undefined,
        duration: typeof raw.duration === "number" ? raw.duration : undefined,
        playedUpTo: typeof raw.playedUpTo === "number" ? raw.playedUpTo : undefined,
        playingStatus: typeof raw.playingStatus === "number" ? raw.playingStatus : undefined,
        podcastUuid: typeof raw.podcastUuid === "string" ? raw.podcastUuid : "",
        podcastTitle: typeof raw.podcastTitle === "string" ? raw.podcastTitle : "",
        author: typeof raw.author === "string" ? raw.author : undefined,
    }));
}
function describeNetworkError(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
