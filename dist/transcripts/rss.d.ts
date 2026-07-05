/** Rung 1 of the transcript ladder: `<podcast:transcript>` links from the episode's RSS item. */
import type { FetchLike } from "../pocketcasts/client.js";
import { type RetryOptions } from "../retry.js";
import type { TranscriptLink } from "../resolver.js";
import { type NormalizedTranscript } from "./normalize.js";
export type FetchedTranscript = NormalizedTranscript & {
    raw: string;
    sourceUrl: string;
    declaredType?: string;
};
export declare function rankTranscriptLinks(links: TranscriptLink[]): TranscriptLink[];
/** Try each declared transcript link in preference order; return the first that parses. */
export declare function fetchRssTranscript(links: TranscriptLink[], fetchImpl?: FetchLike, retry?: RetryOptions): Promise<FetchedTranscript | undefined>;
