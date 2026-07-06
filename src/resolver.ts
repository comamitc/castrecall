/**
 * Episode resolver: maps a Pocket Casts listen to its canonical RSS feed item
 * so the transcript ladder can start from the open `<podcast:transcript>` standard.
 */

import { XMLParser } from "fast-xml-parser";
import type { FetchLike, PocketCastsEpisode } from "./pocketcasts/client.js";
import { fetchWithRetry, type RetryOptions } from "./retry.js";

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
export async function resolveFeedUrl(
  podcastUuid: string,
  podcastTitle: string,
  fetchImpl: FetchLike = fetch,
  retry: RetryOptions = {},
  listenNotesApiKey?: string,
  episode?: Pick<PocketCastsEpisode, "title" | "url" | "uuid">,
): Promise<string | undefined> {
  const fromPocketCasts = await feedUrlFromPocketCasts(podcastUuid, fetchImpl, retry);
  if (fromPocketCasts) return fromPocketCasts;
  const fromItunes = await feedUrlFromItunes(podcastTitle, fetchImpl, retry);
  if (fromItunes) return fromItunes;
  if (!listenNotesApiKey) return undefined;
  return feedUrlFromListenNotes(podcastTitle, listenNotesApiKey, fetchImpl, retry, episode);
}

async function feedUrlFromPocketCasts(
  podcastUuid: string,
  fetchImpl: FetchLike,
  retry: RetryOptions,
): Promise<string | undefined> {
  try {
    const response = await fetchWithRetry(
      fetchImpl,
      "https://refresh.pocketcasts.com/import/export_feed_urls",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uuids: [podcastUuid] }),
      },
      retry,
    );
    if (!response.ok) return undefined;
    const body = (await response.json()) as { result?: Record<string, string> };
    const url = body.result?.[podcastUuid];
    return typeof url === "string" && url.startsWith("http") ? url : undefined;
  } catch {
    return undefined;
  }
}

async function feedUrlFromItunes(
  podcastTitle: string,
  fetchImpl: FetchLike,
  retry: RetryOptions,
): Promise<string | undefined> {
  if (!podcastTitle) return undefined;
  try {
    const query = new URLSearchParams({ media: "podcast", term: podcastTitle, limit: "5" });
    const response = await fetchWithRetry(
      fetchImpl,
      `https://itunes.apple.com/search?${query}`,
      undefined,
      retry,
    );
    if (!response.ok) return undefined;
    const body = (await response.json()) as {
      results?: Array<{ collectionName?: string; feedUrl?: string }>;
    };
    const wanted = normalizeTitle(podcastTitle);
    const match =
      body.results?.find((r) => normalizeTitle(r.collectionName ?? "") === wanted) ??
      body.results?.[0];
    return match?.feedUrl;
  } catch {
    return undefined;
  }
}

/**
 * Last-resort feed-URL fallback via Listen Notes' podcast search
 * (https://www.listennotes.com/api/docs/#get-api-v2-search). Only reached when
 * both the Pocket Casts feed-export endpoint and iTunes Search miss, and only
 * when a Listen Notes API key is configured.
 */
const LISTEN_NOTES_MAX_CANDIDATE_FEEDS = 5;

async function feedUrlFromListenNotes(
  podcastTitle: string,
  apiKey: string,
  fetchImpl: FetchLike,
  retry: RetryOptions,
  episode?: Pick<PocketCastsEpisode, "title" | "url" | "uuid">,
): Promise<string | undefined> {
  // Podcast titles are not unique, so a title match alone can select a
  // different show entirely and let the ladder attach the wrong podcast's
  // transcript. Every title-matching candidate must therefore be verified
  // against the listened episode with strong evidence — matching enclosure
  // audio URL or GUID, never the episode-title fallback — before its feed
  // URL is accepted. No episode identity to verify against → fail closed.
  if (!podcastTitle || !episode) return undefined;
  try {
    const query = new URLSearchParams({ q: podcastTitle, type: "podcast" });
    const response = await fetchWithRetry(
      fetchImpl,
      `https://listen-api.listennotes.com/api/v2/search?${query}`,
      { headers: { "X-ListenAPI-Key": apiKey } },
      retry,
    );
    if (!response.ok) return undefined;
    const body = (await response.json()) as {
      results?: Array<{ title_original?: string; rss?: string }>;
    };
    const usable = body.results?.filter((r) => typeof r.rss === "string" && r.rss.length > 0) ?? [];
    const wanted = normalizeTitle(podcastTitle);
    const candidates = usable
      .filter((r) => normalizeTitle(r.title_original ?? "") === wanted)
      .slice(0, LISTEN_NOTES_MAX_CANDIDATE_FEEDS);
    for (const candidate of candidates) {
      const item = await resolveFeedItem(candidate.rss!, episode, fetchImpl, retry).catch(
        () => undefined,
      );
      if (item && item.matchEvidence !== "title") return candidate.rss;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fetch the feed and find the item matching the listened episode.
 * Matching order: enclosure URL, then GUID, then normalized title.
 */
export async function resolveFeedItem(
  feedUrl: string,
  episode: Pick<PocketCastsEpisode, "title" | "url" | "uuid">,
  fetchImpl: FetchLike = fetch,
  retry: RetryOptions = {},
): Promise<ResolvedFeedItem | undefined> {
  const response = await fetchWithRetry(
    fetchImpl,
    feedUrl,
    { headers: { accept: "application/rss+xml, application/xml, text/xml, */*" } },
    retry,
  );
  if (!response.ok) {
    throw new Error(`Feed fetch failed with HTTP ${response.status} for ${feedUrl}`);
  }
  const xml = await response.text();
  return findFeedItem(xml, episode, feedUrl);
}

/** Pure feed-XML matcher; exported for tests. */
export function findFeedItem(
  feedXml: string,
  episode: Pick<PocketCastsEpisode, "title" | "url" | "uuid">,
  feedUrl: string,
): ResolvedFeedItem | undefined {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    // Keep namespace prefixes: podcast:transcript must stay distinguishable.
    removeNSPrefix: false,
  });
  const doc = parser.parse(feedXml) as Record<string, any>;
  const channel = doc?.rss?.channel;
  if (!channel) return undefined;
  const items: any[] = Array.isArray(channel.item)
    ? channel.item
    : channel.item
      ? [channel.item]
      : [];

  const wantedAudio = stripQuery(episode.url);
  const wantedTitle = normalizeTitle(episode.title);

  const scored = items.map((item) => {
    const enclosureUrl: string | undefined = item?.enclosure?.["@_url"];
    const guid = typeof item?.guid === "object" ? item.guid?.["#text"] : item?.guid;
    const title = textOf(item?.title);
    let score = 0;
    if (enclosureUrl && wantedAudio && stripQuery(enclosureUrl) === wantedAudio) score = 3;
    else if (guid && String(guid) === episode.uuid) score = 2;
    else if (title && normalizeTitle(title) === wantedTitle) score = 1;
    return { item, score, enclosureUrl, guid, title };
  });

  const best = scored.sort((a, b) => b.score - a.score)[0];
  if (!best || best.score === 0) return undefined;

  return {
    feedUrl,
    matchEvidence: best.score === 3 ? "enclosure" : best.score === 2 ? "guid" : "title",
    itemTitle: best.title ?? episode.title,
    itemGuid: best.guid ? String(best.guid) : undefined,
    itemLink: textOf(best.item?.link),
    enclosureUrl: best.enclosureUrl,
    transcripts: extractTranscriptLinks(best.item, feedUrl),
  };
}

/** Extract podcast-namespace transcript links from a parsed feed item. */
export function extractTranscriptLinks(item: any, baseUrl?: string): TranscriptLink[] {
  const entries = transcriptTagValues(item);
  return entries
    .map((entry: any): Partial<TranscriptLink> => {
      const url = resolveMaybeRelativeUrl(entry?.["@_url"] ?? entry?.["@_href"], baseUrl);
      return {
        url,
        type: entry?.["@_type"],
        language: entry?.["@_language"],
        rel: entry?.["@_rel"],
      };
    })
    .filter((link): link is TranscriptLink => typeof link.url === "string" && link.url.length > 0);
}

function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "#text" in value) {
    const text = (value as Record<string, unknown>)["#text"];
    return typeof text === "string" ? text : undefined;
  }
  return undefined;
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, " ").trim();
}

function stripQuery(url: string): string {
  const index = url.indexOf("?");
  return index === -1 ? url : url.slice(0, index);
}

function transcriptTagValues(item: any): any[] {
  if (!item || typeof item !== "object") return [];
  const values: any[] = [];
  for (const [key, value] of Object.entries(item)) {
    if (!isTranscriptElementName(key)) continue;
    values.push(...(Array.isArray(value) ? value : [value]));
  }
  return values;
}

function isTranscriptElementName(key: string): boolean {
  const lower = key.toLowerCase();
  return lower === "transcript" || lower.endsWith(":transcript");
}

function resolveMaybeRelativeUrl(url: unknown, baseUrl: string | undefined): string | undefined {
  if (typeof url !== "string" || !url.trim()) return undefined;
  const trimmed = url.trim();
  if (!baseUrl) return trimmed;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return trimmed;
  }
}
