/**
 * Episode resolver: maps a Pocket Casts listen to its canonical RSS feed item
 * so the transcript ladder can start from the open `<podcast:transcript>` standard.
 */
import { XMLParser } from "fast-xml-parser";
/**
 * Resolve a Pocket Casts podcast UUID to its RSS feed URL.
 *
 * Primary: the (unofficial, unauthenticated) Pocket Casts feed-export endpoint
 * used by community export tools. Fallback: the official iTunes Search API,
 * matched by podcast title.
 */
export async function resolveFeedUrl(podcastUuid, podcastTitle, fetchImpl = fetch) {
    const fromPocketCasts = await feedUrlFromPocketCasts(podcastUuid, fetchImpl);
    if (fromPocketCasts)
        return fromPocketCasts;
    return feedUrlFromItunes(podcastTitle, fetchImpl);
}
async function feedUrlFromPocketCasts(podcastUuid, fetchImpl) {
    try {
        const response = await fetchImpl("https://refresh.pocketcasts.com/import/export_feed_urls", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ uuids: [podcastUuid] }),
        });
        if (!response.ok)
            return undefined;
        const body = (await response.json());
        const url = body.result?.[podcastUuid];
        return typeof url === "string" && url.startsWith("http") ? url : undefined;
    }
    catch {
        return undefined;
    }
}
async function feedUrlFromItunes(podcastTitle, fetchImpl) {
    if (!podcastTitle)
        return undefined;
    try {
        const query = new URLSearchParams({ media: "podcast", term: podcastTitle, limit: "5" });
        const response = await fetchImpl(`https://itunes.apple.com/search?${query}`);
        if (!response.ok)
            return undefined;
        const body = (await response.json());
        const wanted = normalizeTitle(podcastTitle);
        const match = body.results?.find((r) => normalizeTitle(r.collectionName ?? "") === wanted) ??
            body.results?.[0];
        return match?.feedUrl;
    }
    catch {
        return undefined;
    }
}
/**
 * Fetch the feed and find the item matching the listened episode.
 * Matching order: enclosure URL, then GUID, then normalized title.
 */
export async function resolveFeedItem(feedUrl, episode, fetchImpl = fetch) {
    const response = await fetchImpl(feedUrl, {
        headers: { accept: "application/rss+xml, application/xml, text/xml, */*" },
    });
    if (!response.ok) {
        throw new Error(`Feed fetch failed with HTTP ${response.status} for ${feedUrl}`);
    }
    const xml = await response.text();
    return findFeedItem(xml, episode, feedUrl);
}
/** Pure feed-XML matcher; exported for tests. */
export function findFeedItem(feedXml, episode, feedUrl) {
    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
        // Keep namespace prefixes: podcast:transcript must stay distinguishable.
        removeNSPrefix: false,
    });
    const doc = parser.parse(feedXml);
    const channel = doc?.rss?.channel;
    if (!channel)
        return undefined;
    const items = Array.isArray(channel.item)
        ? channel.item
        : channel.item
            ? [channel.item]
            : [];
    const wantedAudio = stripQuery(episode.url);
    const wantedTitle = normalizeTitle(episode.title);
    const scored = items.map((item) => {
        const enclosureUrl = item?.enclosure?.["@_url"];
        const guid = typeof item?.guid === "object" ? item.guid?.["#text"] : item?.guid;
        const title = textOf(item?.title);
        let score = 0;
        if (enclosureUrl && wantedAudio && stripQuery(enclosureUrl) === wantedAudio)
            score = 3;
        else if (guid && String(guid) === episode.uuid)
            score = 2;
        else if (title && normalizeTitle(title) === wantedTitle)
            score = 1;
        return { item, score, enclosureUrl, guid, title };
    });
    const best = scored.sort((a, b) => b.score - a.score)[0];
    if (!best || best.score === 0)
        return undefined;
    return {
        feedUrl,
        itemTitle: best.title ?? episode.title,
        itemGuid: best.guid ? String(best.guid) : undefined,
        itemLink: textOf(best.item?.link),
        enclosureUrl: best.enclosureUrl,
        transcripts: extractTranscriptLinks(best.item, feedUrl),
    };
}
/** Extract podcast-namespace transcript links from a parsed feed item. */
export function extractTranscriptLinks(item, baseUrl) {
    const entries = transcriptTagValues(item);
    return entries
        .map((entry) => {
        const url = resolveMaybeRelativeUrl(entry?.["@_url"] ?? entry?.["@_href"], baseUrl);
        return {
            url,
            type: entry?.["@_type"],
            language: entry?.["@_language"],
            rel: entry?.["@_rel"],
        };
    })
        .filter((link) => typeof link.url === "string" && link.url.length > 0);
}
function textOf(value) {
    if (typeof value === "string")
        return value;
    if (typeof value === "object" && value !== null && "#text" in value) {
        const text = value["#text"];
        return typeof text === "string" ? text : undefined;
    }
    return undefined;
}
function normalizeTitle(title) {
    return title.toLowerCase().replace(/\s+/g, " ").trim();
}
function stripQuery(url) {
    const index = url.indexOf("?");
    return index === -1 ? url : url.slice(0, index);
}
function transcriptTagValues(item) {
    if (!item || typeof item !== "object")
        return [];
    const values = [];
    for (const [key, value] of Object.entries(item)) {
        if (!isTranscriptElementName(key))
            continue;
        values.push(...(Array.isArray(value) ? value : [value]));
    }
    return values;
}
function isTranscriptElementName(key) {
    const lower = key.toLowerCase();
    return lower === "transcript" || lower.endsWith(":transcript");
}
function resolveMaybeRelativeUrl(url, baseUrl) {
    if (typeof url !== "string" || !url.trim())
        return undefined;
    const trimmed = url.trim();
    if (!baseUrl)
        return trimmed;
    try {
        return new URL(trimmed, baseUrl).toString();
    }
    catch {
        return trimmed;
    }
}
