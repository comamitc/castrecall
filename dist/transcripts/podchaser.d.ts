/**
 * Rung 3 of the transcript ladder: the Podchaser podcast API (https://podchaser.com).
 * Optional; only used when PODCHASER_API_KEY is set. Podchaser's GraphQL API is normally
 * authenticated via an OAuth2 client-credentials exchange (`requestAccessToken`); v1 treats
 * PODCHASER_API_KEY as a pre-minted bearer access token from that exchange (valid ~1 year)
 * rather than performing the exchange itself — see docs/ARCHITECTURE.md.
 *
 * Two-hop lookup: a GraphQL query locates the episode and its declared transcript
 * references (`Episode.transcripts[]`); the chosen reference's `url` is a JSON document
 * valid for only ~10 minutes, fetched and normalized to text on the second hop.
 */
import { type ResolvedConfig } from "../config.js";
import type { FetchLike } from "../pocketcasts/client.js";
import { type RetryOptions } from "../retry.js";
export type PodchaserTranscript = {
    text: string;
    sourceUrl: string;
};
export declare function podchaserConfigured(config: ResolvedConfig): boolean;
/**
 * Look an episode up by RSS GUID first (exact), then by title, and return its transcript.
 * Podchaser episode GUIDs and titles are only unique within a podcast, so every candidate
 * is validated against the resolved feed's URL when one is known, or against the podcast
 * title otherwise — an unscoped or mismatched candidate is treated as a miss rather than a hit.
 * Returns undefined when Podchaser knows the episode but has no usable transcript.
 */
export declare function fetchPodchaserTranscript(config: ResolvedConfig, episode: {
    guid?: string;
    title: string;
    feedUrl?: string;
    podcastTitle?: string;
}, fetchImpl?: FetchLike, retry?: RetryOptions): Promise<PodchaserTranscript | undefined>;
