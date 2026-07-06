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
import { CastrecallSetupError } from "../config.js";
import { fetchWithRetry } from "../retry.js";
const PODCHASER_ENDPOINT = "https://api.podchaser.com/graphql";
/** Preference order when an episode declares multiple transcript references. */
const TRANSCRIPT_TYPE_PREFERENCE = ["beautified_JSON", "raw_JSON"];
export function podchaserConfigured(config) {
    return Boolean(config.podchaser.apiKey);
}
/**
 * Look an episode up by RSS GUID first (exact), then by title, and return its transcript.
 * Podchaser episode GUIDs and titles are only unique within a podcast, so every candidate
 * is validated against the resolved feed's URL when one is known, or against the podcast
 * title otherwise — an unscoped or mismatched candidate is treated as a miss rather than a hit.
 *
 * PRIVACY INVARIANT: the resolved feed URL is used ONLY for that local comparison and is
 * never placed in a Podchaser request. Feed URLs come from the user's Pocket Casts
 * subscriptions, and private/paid feeds embed subscriber tokens anywhere in the URL
 * (userinfo, query, fragment, or path) with no way to prove a given URL is public —
 * so nothing derived from it may cross the Podchaser trust boundary. The same rule
 * covers RSS GUIDs: permalink-style GUIDs are URLs from the same private feed and can
 * carry the same tokens, so only opaque GUIDs (no URL structure) are ever sent; a
 * URL-like GUID skips straight to title search, which transmits the episode title only.
 *
 * Returns undefined when Podchaser knows the episode but has no usable transcript.
 */
export async function fetchPodchaserTranscript(config, episode, fetchImpl = fetch, retry = {}) {
    if (!podchaserConfigured(config)) {
        throw new CastrecallSetupError("Podchaser is not configured. Set PODCHASER_API_KEY to a bearer access token minted via " +
            "Podchaser's requestAccessToken mutation (see https://api-docs.podchaser.com/docs/authorization/) " +
            "or skip this rung of the transcript ladder.");
    }
    const expectedPodcast = { feedUrl: episode.feedUrl, podcastTitle: episode.podcastTitle };
    const attempts = [];
    if (episode.guid && isOpaqueGuid(episode.guid)) {
        const guid = episode.guid;
        attempts.push(async () => {
            const found = await lookupByGuid(config, guid, fetchImpl, retry);
            return found ? [found] : [];
        });
    }
    attempts.push(() => lookupByTitle(config, episode.title, fetchImpl, retry));
    for (const attempt of attempts) {
        const candidates = await attempt();
        for (const episodeData of candidates) {
            if (!matchesExpectedPodcast(episodeData.podcast, expectedPodcast))
                continue;
            const ref = selectTranscriptRef(episodeData.transcripts);
            if (!ref?.url)
                continue;
            const text = await fetchTranscriptUrl(ref.url, fetchImpl, retry);
            if (text)
                return { text, sourceUrl: ref.url };
        }
    }
    return undefined;
}
/**
 * Require the candidate episode's podcast to match the resolved feed before accepting it —
 * without scoping context (no feed URL or podcast title to compare against) a match cannot
 * be verified, so it's treated as a miss rather than trusted.
 */
function matchesExpectedPodcast(candidatePodcast, expected) {
    if (!expected.feedUrl && !expected.podcastTitle)
        return false;
    if (expected.feedUrl) {
        return (Boolean(candidatePodcast?.rssUrl) &&
            normalizeUrl(candidatePodcast.rssUrl) === normalizeUrl(expected.feedUrl));
    }
    if (expected.podcastTitle && candidatePodcast?.title) {
        return normalizeTitle(candidatePodcast.title) === normalizeTitle(expected.podcastTitle);
    }
    return false;
}
/**
 * True only for GUIDs with no URL structure at all. RSS permits permalink
 * GUIDs, and on a private feed those are URLs carrying the same subscriber
 * tokens as the feed URL (in path, query, userinfo, or fragment) — none of
 * which can be proven safe. Rejects anything with URL-structural characters
 * or a parseable scheme (http:, tag:, urn:, ...); such episodes fall back to
 * title search, which transmits only the episode title.
 */
function isOpaqueGuid(guid) {
    if (/[/?#@]/.test(guid))
        return false;
    try {
        new URL(guid);
        return false;
    }
    catch {
        return true;
    }
}
function normalizeUrl(url) {
    return url.trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "");
}
function normalizeTitle(title) {
    return title.trim().toLowerCase();
}
async function lookupByGuid(config, guid, fetchImpl, retry) {
    const query = `query GetEpisodeByGuid($identifier: EpisodeIdentifier!) {
    episode(identifier: $identifier) {
      title
      transcripts { url source transcriptType }
      podcast { title rssUrl }
    }
  }`;
    // Deliberately unscoped: adding identifier.podcast would transmit the
    // resolved feed URL (see the privacy invariant on fetchPodchaserTranscript).
    // A wrong-podcast candidate is rejected by matchesExpectedPodcast locally.
    const identifier = { id: guid, type: "GUID" };
    const result = await podchaserRequest(config, query, { identifier }, fetchImpl, retry);
    return result?.episode ?? undefined;
}
async function lookupByTitle(config, title, fetchImpl, retry) {
    const query = `query FindEpisodeByTitle($searchTerm: String!) {
    episodes(searchTerm: $searchTerm) {
      data { title transcripts { url source transcriptType } podcast { title rssUrl } }
    }
  }`;
    const result = await podchaserRequest(config, query, { searchTerm: title }, fetchImpl, retry);
    const list = result?.episodes?.data ?? [];
    const normalizedTitle = normalizeTitle(title);
    return list.filter((candidate) => candidate.title && normalizeTitle(candidate.title) === normalizedTitle);
}
function selectTranscriptRef(transcripts) {
    const withUrl = (transcripts ?? []).filter((ref) => Boolean(ref.url));
    if (withUrl.length === 0)
        return undefined;
    return [...withUrl].sort((a, b) => transcriptTypePreference(a.transcriptType) - transcriptTypePreference(b.transcriptType))[0];
}
function transcriptTypePreference(type) {
    const index = TRANSCRIPT_TYPE_PREFERENCE.indexOf(type ?? "");
    return index === -1 ? TRANSCRIPT_TYPE_PREFERENCE.length : index;
}
/** Fetch the ~10-minute transcript URL and normalize its JSON body to text. */
async function fetchTranscriptUrl(url, fetchImpl, retry) {
    let response;
    try {
        response = await fetchWithRetry(fetchImpl, url, {}, retry);
    }
    catch (error) {
        throw new Error(`Could not fetch the Podchaser transcript URL (${error instanceof Error ? error.message : String(error)}).`);
    }
    if (!response.ok) {
        throw new Error(`Podchaser transcript URL fetch failed with HTTP ${response.status}.`);
    }
    let body;
    try {
        body = await response.json();
    }
    catch (error) {
        throw new Error(`Podchaser transcript URL returned invalid JSON (${error instanceof Error ? error.message : String(error)}).`);
    }
    return normalizeUtterances(body);
}
/** `raw_JSON` is a top-level array; `beautified_JSON` is an object with `utterances`. */
function normalizeUtterances(body) {
    const entries = Array.isArray(body)
        ? body
        : body && typeof body === "object" && Array.isArray(body.utterances)
            ? (body.utterances)
            : undefined;
    if (!entries)
        return undefined;
    const text = entries
        .map((entry) => entry && typeof entry === "object" && typeof entry.utterance === "string"
        ? entry.utterance
        : "")
        .filter((line) => line.trim())
        .join("\n")
        .trim();
    return text ? text : undefined;
}
async function podchaserRequest(config, query, variables, fetchImpl, retry = {}) {
    let response;
    try {
        response = await fetchWithRetry(fetchImpl, PODCHASER_ENDPOINT, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${config.podchaser.apiKey ?? ""}`,
            },
            body: JSON.stringify({ query, variables }),
        }, retry);
    }
    catch (error) {
        throw new Error(`Could not reach the Podchaser API (${error instanceof Error ? error.message : String(error)}).`);
    }
    if (response.status === 401 || response.status === 403) {
        throw new CastrecallSetupError("Podchaser rejected the configured token. Check PODCHASER_API_KEY.");
    }
    if (!response.ok) {
        throw new Error(`Podchaser API request failed with HTTP ${response.status}.`);
    }
    const body = (await response.json());
    if (body.errors?.length) {
        const notFound = body.errors.every((e) => /not.?found/i.test(e.message ?? ""));
        if (notFound)
            return undefined;
        throw new Error(`Podchaser API error: ${body.errors.map((e) => e.message).join("; ")}`);
    }
    return body.data;
}
