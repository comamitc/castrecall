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

import { CastrecallSetupError, type ResolvedConfig } from "../config.js";
import type { FetchLike } from "../pocketcasts/client.js";
import { fetchWithRetry, type RetryOptions } from "../retry.js";

const PODCHASER_ENDPOINT = "https://api.podchaser.com/graphql";

/** Preference order when an episode declares multiple transcript references. */
const TRANSCRIPT_TYPE_PREFERENCE = ["beautified_JSON", "raw_JSON"];

export type PodchaserTranscript = {
  text: string;
  sourceUrl: string;
};

type PodchaserTranscriptRef = {
  url?: string | null;
  source?: string | null;
  transcriptType?: string | null;
};

type PodchaserPodcastRef = {
  title?: string | null;
  rssUrl?: string | null;
};

type PodchaserEpisode = {
  title?: string | null;
  transcripts?: PodchaserTranscriptRef[] | null;
  podcast?: PodchaserPodcastRef | null;
};

export function podchaserConfigured(config: ResolvedConfig): boolean {
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
export async function fetchPodchaserTranscript(
  config: ResolvedConfig,
  episode: { guid?: string; title: string; feedUrl?: string; podcastTitle?: string },
  fetchImpl: FetchLike = fetch,
  retry: RetryOptions = {},
): Promise<PodchaserTranscript | undefined> {
  if (!podchaserConfigured(config)) {
    throw new CastrecallSetupError(
      "Podchaser is not configured. Set PODCHASER_API_KEY to a bearer access token minted via " +
        "Podchaser's requestAccessToken mutation (see https://api-docs.podchaser.com/docs/authorization/) " +
        "or skip this rung of the transcript ladder.",
    );
  }

  const expectedPodcast = { feedUrl: episode.feedUrl, podcastTitle: episode.podcastTitle };
  const attempts: Array<() => Promise<PodchaserEpisode[]>> = [];
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
      if (!matchesExpectedPodcast(episodeData.podcast, expectedPodcast)) continue;
      const ref = selectTranscriptRef(episodeData.transcripts);
      if (!ref?.url) continue;
      const text = await fetchTranscriptUrl(ref.url, fetchImpl, retry);
      if (text) return { text, sourceUrl: ref.url };
    }
  }
  return undefined;
}

/**
 * Require the candidate episode's podcast to match the resolved feed before accepting it —
 * without scoping context (no feed URL or podcast title to compare against) a match cannot
 * be verified, so it's treated as a miss rather than trusted.
 */
function matchesExpectedPodcast(
  candidatePodcast: PodchaserPodcastRef | null | undefined,
  expected: { feedUrl?: string; podcastTitle?: string },
): boolean {
  if (!expected.feedUrl && !expected.podcastTitle) return false;
  if (expected.feedUrl) {
    return (
      Boolean(candidatePodcast?.rssUrl) &&
      normalizeUrl(candidatePodcast!.rssUrl!) === normalizeUrl(expected.feedUrl)
    );
  }
  if (expected.podcastTitle && candidatePodcast?.title) {
    return normalizeTitle(candidatePodcast.title) === normalizeTitle(expected.podcastTitle);
  }
  return false;
}

/** Percent-decoding rounds before a still-encoded GUID is deemed suspect. */
const MAX_GUID_DECODE_ROUNDS = 3;

/**
 * True only for GUIDs with no URL structure at all. RSS permits permalink
 * GUIDs, and on a private feed those are URLs carrying the same subscriber
 * tokens as the feed URL (in path, query, userinfo, or fragment) — none of
 * which can be proven safe. Rejects anything with URL-structural characters
 * or a parseable scheme (http:, tag:, urn:, ...), and classifies AFTER
 * bounded repeated percent-decoding so encoded structure (%2F, %3F, %40,
 * double-encoding) can't smuggle a token past the raw-character checks;
 * malformed or never-terminating percent-encoding is rejected outright.
 * Rejected episodes fall back to title search, which transmits only the
 * episode title.
 */
function isOpaqueGuid(guid: string): boolean {
  let value = guid;
  for (let round = 0; round <= MAX_GUID_DECODE_ROUNDS; round += 1) {
    if (hasUrlStructure(value)) return false;
    if (!value.includes("%")) return true;
    if (round === MAX_GUID_DECODE_ROUNDS) return false;
    try {
      value = decodeURIComponent(value);
    } catch {
      return false;
    }
  }
  return false;
}

function hasUrlStructure(value: string): boolean {
  if (/[/?#@\\\s]/.test(value)) return true;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function normalizeUrl(url: string): string {
  return url.trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "");
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase();
}

async function lookupByGuid(
  config: ResolvedConfig,
  guid: string,
  fetchImpl: FetchLike,
  retry: RetryOptions,
): Promise<PodchaserEpisode | undefined> {
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
  const identifier: Record<string, unknown> = { id: guid, type: "GUID" };
  const result = await podchaserRequest(config, query, { identifier }, fetchImpl, retry);
  return (result?.episode as PodchaserEpisode | null | undefined) ?? undefined;
}

async function lookupByTitle(
  config: ResolvedConfig,
  title: string,
  fetchImpl: FetchLike,
  retry: RetryOptions,
): Promise<PodchaserEpisode[]> {
  const query = `query FindEpisodeByTitle($searchTerm: String!) {
    episodes(searchTerm: $searchTerm) {
      data { title transcripts { url source transcriptType } podcast { title rssUrl } }
    }
  }`;
  const result = await podchaserRequest(config, query, { searchTerm: title }, fetchImpl, retry);
  const list =
    (result?.episodes as { data?: PodchaserEpisode[] } | null | undefined)?.data ?? [];
  const normalizedTitle = normalizeTitle(title);
  return list.filter((candidate) => candidate.title && normalizeTitle(candidate.title) === normalizedTitle);
}

function selectTranscriptRef(
  transcripts: PodchaserTranscriptRef[] | null | undefined,
): PodchaserTranscriptRef | undefined {
  const withUrl = (transcripts ?? []).filter((ref): ref is PodchaserTranscriptRef & { url: string } =>
    Boolean(ref.url),
  );
  if (withUrl.length === 0) return undefined;
  return [...withUrl].sort(
    (a, b) => transcriptTypePreference(a.transcriptType) - transcriptTypePreference(b.transcriptType),
  )[0];
}

function transcriptTypePreference(type?: string | null): number {
  const index = TRANSCRIPT_TYPE_PREFERENCE.indexOf(type ?? "");
  return index === -1 ? TRANSCRIPT_TYPE_PREFERENCE.length : index;
}

/** Fetch the ~10-minute transcript URL and normalize its JSON body to text. */
async function fetchTranscriptUrl(
  url: string,
  fetchImpl: FetchLike,
  retry: RetryOptions,
): Promise<string | undefined> {
  let response: Response;
  try {
    response = await fetchWithRetry(fetchImpl, url, {}, retry);
  } catch (error) {
    throw new Error(
      `Could not fetch the Podchaser transcript URL (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  if (!response.ok) {
    throw new Error(`Podchaser transcript URL fetch failed with HTTP ${response.status}.`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(
      `Podchaser transcript URL returned invalid JSON (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  return normalizeUtterances(body);
}

/** `raw_JSON` is a top-level array; `beautified_JSON` is an object with `utterances`. */
function normalizeUtterances(body: unknown): string | undefined {
  const entries = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as { utterances?: unknown }).utterances)
      ? ((body as { utterances: unknown[] }).utterances)
      : undefined;
  if (!entries) return undefined;

  const text = entries
    .map((entry) =>
      entry && typeof entry === "object" && typeof (entry as { utterance?: unknown }).utterance === "string"
        ? (entry as { utterance: string }).utterance
        : "",
    )
    .filter((line) => line.trim())
    .join("\n")
    .trim();
  return text ? text : undefined;
}

async function podchaserRequest(
  config: ResolvedConfig,
  query: string,
  variables: Record<string, unknown>,
  fetchImpl: FetchLike,
  retry: RetryOptions = {},
): Promise<Record<string, unknown> | undefined> {
  let response: Response;
  try {
    response = await fetchWithRetry(
      fetchImpl,
      PODCHASER_ENDPOINT,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.podchaser.apiKey ?? ""}`,
        },
        body: JSON.stringify({ query, variables }),
      },
      retry,
    );
  } catch (error) {
    throw new Error(
      `Could not reach the Podchaser API (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new CastrecallSetupError("Podchaser rejected the configured token. Check PODCHASER_API_KEY.");
  }
  if (!response.ok) {
    throw new Error(`Podchaser API request failed with HTTP ${response.status}.`);
  }
  const body = (await response.json()) as {
    data?: Record<string, unknown>;
    errors?: Array<{ message?: string }>;
  };
  if (body.errors?.length) {
    const notFound = body.errors.every((e) => /not.?found/i.test(e.message ?? ""));
    if (notFound) return undefined;
    throw new Error(`Podchaser API error: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  return body.data;
}
