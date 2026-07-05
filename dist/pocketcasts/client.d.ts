/**
 * Read-only Pocket Casts adapter.
 *
 * Pocket Casts has NO official public API. These endpoints are the same
 * reverse-engineered web-player endpoints used by community tools
 * (e.g. essoen/PocketCasts-mcp) and may break or be blocked at any time.
 * CastRecall only ever calls read endpoints; no playback mutation exists here.
 */
import { CastrecallSetupError } from "../config.js";
export type FetchLike = typeof fetch;
export type PocketCastsEpisode = {
    uuid: string;
    title: string;
    /** Direct audio URL for the episode. */
    url: string;
    published?: string;
    duration?: number;
    playedUpTo?: number;
    /** 1 = unplayed, 2 = in progress, 3 = played (web player convention). */
    playingStatus?: number;
    podcastUuid: string;
    podcastTitle: string;
    author?: string;
};
export declare class PocketCastsAuthError extends CastrecallSetupError {
    constructor(message: string);
}
export declare class PocketCastsApiError extends Error {
    readonly status?: number | undefined;
    constructor(message: string, status?: number | undefined);
}
/**
 * Exchange email/password for a short-lived bearer token.
 * The token is held in memory by the caller only; CastRecall never writes
 * credentials or tokens to disk and never includes them in errors or logs.
 */
export declare function login(email: string, password: string, fetchImpl?: FetchLike): Promise<string>;
/** Fetch the account's listening history (read-only). Newest first. */
export declare function fetchHistory(token: string, fetchImpl?: FetchLike): Promise<PocketCastsEpisode[]>;
