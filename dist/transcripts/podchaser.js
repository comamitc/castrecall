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
 * Returns undefined when Podchaser knows the episode but has no usable transcript.
 */
export async function fetchPodchaserTranscript(config, episode, fetchImpl = fetch, retry = {}) {
    if (!podchaserConfigured(config)) {
        throw new CastrecallSetupError("Podchaser is not configured. Set PODCHASER_API_KEY to a bearer access token minted via " +
            "Podchaser's requestAccessToken mutation (see https://api-docs.podchaser.com/docs/authorization/) " +
            "or skip this rung of the transcript ladder.");
    }
    const attempts = [];
    if (episode.guid) {
        attempts.push(() => lookupByGuid(config, episode.guid, fetchImpl, retry));
    }
    attempts.push(() => lookupByTitle(config, episode.title, fetchImpl, retry));
    for (const attempt of attempts) {
        const episodeData = await attempt();
        if (!episodeData)
            continue;
        const ref = selectTranscriptRef(episodeData.transcripts);
        if (!ref?.url)
            continue;
        const text = await fetchTranscriptUrl(ref.url, fetchImpl, retry);
        if (text)
            return { text, sourceUrl: ref.url };
    }
    return undefined;
}
async function lookupByGuid(config, guid, fetchImpl, retry) {
    const query = `query GetEpisodeByGuid($identifier: EpisodeIdentifier!) {
    episode(identifier: $identifier) {
      title
      transcripts { url source transcriptType }
    }
  }`;
    const result = await podchaserRequest(config, query, { identifier: { identifier: guid, type: "GUID" } }, fetchImpl, retry);
    return result?.episode ?? undefined;
}
async function lookupByTitle(config, title, fetchImpl, retry) {
    const query = `query FindEpisodeByTitle($searchTerm: String!) {
    episodes(searchTerm: $searchTerm) {
      data { title transcripts { url source transcriptType } }
    }
  }`;
    const result = await podchaserRequest(config, query, { searchTerm: title }, fetchImpl, retry);
    const list = result?.episodes?.data ?? [];
    const normalizedTitle = title.trim().toLowerCase();
    return list.find((candidate) => candidate.title?.trim().toLowerCase() === normalizedTitle);
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
