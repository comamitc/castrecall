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
export declare function taddyConfigured(config: ResolvedConfig): boolean;
/**
 * Look an episode up by RSS GUID first (exact), then by name, and return its transcript.
 * Returns undefined when Taddy knows the episode but has no transcript.
 */
export declare function fetchTaddyTranscript(config: ResolvedConfig, episode: {
    guid?: string;
    title: string;
}, fetchImpl?: FetchLike, retry?: RetryOptions): Promise<TaddyTranscript | undefined>;
