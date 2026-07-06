/**
 * Rung 2 of the transcript ladder: the Taddy podcast API (https://taddy.org).
 * Optional; only used when TADDY_API_KEY and TADDY_USER_ID are set.
 * Transcript access requires a paid Taddy plan; free keys return no transcript.
 */
import { type ResolvedConfig } from "../config.js";
import type { FetchLike } from "../pocketcasts/client.js";
import { type RetryOptions } from "../retry.js";
export type TaddyTranscript = {
    text: string;
    episodeUuid?: string;
};
/**
 * `hit` — a transcript was returned. `pending` — Taddy knows the episode and
 * `taddyTranscribeStatus` says it's actively transcribing, so a later look
 * may find a transcript. `miss` — Taddy has nothing and isn't transcribing.
 */
export type TaddyLookup = {
    status: "hit";
    transcript: TaddyTranscript;
} | {
    status: "pending";
} | {
    status: "miss";
};
/**
 * Whether a raw `taddyTranscribeStatus` value means Taddy is actively
 * transcribing the episode. Case-insensitive. `NOT_TRANSCRIBING` contains the
 * substring "TRANSCRIBING" but is the terminal not-transcribing state, so the
 * fallback substring match explicitly excludes it.
 */
export declare function isTranscribingStatus(raw: unknown): boolean;
export declare function taddyConfigured(config: ResolvedConfig): boolean;
/**
 * Look an episode up by RSS GUID first (exact), then by name, and return its
 * transcript lookup outcome — a transcript, a pending-transcription signal,
 * or a definitive miss.
 */
export declare function fetchTaddyTranscript(config: ResolvedConfig, episode: {
    guid?: string;
    title: string;
}, fetchImpl?: FetchLike, retry?: RetryOptions): Promise<TaddyLookup>;
