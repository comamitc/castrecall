/**
 * Episode resolver: maps a Pocket Casts listen to its canonical RSS feed item
 * so the transcript ladder can start from the open `<podcast:transcript>` standard.
 */
import type { FetchLike, PocketCastsEpisode } from "./pocketcasts/client.js";
import { type RetryOptions } from "./retry.js";
export type TranscriptLink = {
    url: string;
    /** MIME type as declared in the feed, e.g. "text/vtt". */
    type?: string;
    language?: string;
    rel?: string;
};
export type ResolvedFeedItem = {
    feedUrl: string;
    itemTitle: string;
    itemGuid?: string;
    itemLink?: string;
    enclosureUrl?: string;
    transcripts: TranscriptLink[];
    /** Which signal matched the listened episode — "title" is the weakest and never sufficient to *select* a feed. */
    matchEvidence: "enclosure" | "guid" | "title";
};
/**
 * Resolve a Pocket Casts podcast UUID to its RSS feed URL.
 *
 * Primary: the (unofficial, unauthenticated) Pocket Casts feed-export endpoint
 * used by community export tools. Fallback: the official iTunes Search API,
 * matched by podcast title. Optional last-resort fallback: Listen Notes'
 * podcast search, only used when a Listen Notes API key is supplied.
 */
export declare function resolveFeedUrl(podcastUuid: string, podcastTitle: string, fetchImpl?: FetchLike, retry?: RetryOptions, listenNotesApiKey?: string, episode?: Pick<PocketCastsEpisode, "title" | "url" | "uuid">): Promise<string | undefined>;
/**
 * Fetch the feed and find the item matching the listened episode.
 * Matching order: enclosure URL, then GUID, then normalized title.
 */
export declare function resolveFeedItem(feedUrl: string, episode: Pick<PocketCastsEpisode, "title" | "url" | "uuid">, fetchImpl?: FetchLike, retry?: RetryOptions): Promise<ResolvedFeedItem | undefined>;
/** Pure feed-XML matcher; exported for tests. */
export declare function findFeedItem(feedXml: string, episode: Pick<PocketCastsEpisode, "title" | "url" | "uuid">, feedUrl: string): ResolvedFeedItem | undefined;
/** Extract podcast-namespace transcript links from a parsed feed item. */
export declare function extractTranscriptLinks(item: any, baseUrl?: string): TranscriptLink[];
