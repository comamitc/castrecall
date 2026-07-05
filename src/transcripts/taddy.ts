/**
 * Rung 2 of the transcript ladder: the Taddy podcast API (https://taddy.org).
 * Optional; only used when TADDY_API_KEY and TADDY_USER_ID are set.
 * Transcript access requires a paid Taddy plan; free keys return no transcript.
 */

import { CastrecallSetupError, type ResolvedConfig } from "../config.js";
import type { FetchLike } from "../pocketcasts/client.js";
import { fetchWithRetry, type RetryOptions } from "../retry.js";

const TADDY_ENDPOINT = "https://api.taddy.org";

export type TaddyTranscript = {
  text: string;
  episodeUuid?: string;
};

export function taddyConfigured(config: ResolvedConfig): boolean {
  return Boolean(config.taddy.apiKey && config.taddy.userId);
}

/**
 * Look an episode up by RSS GUID first (exact), then by name, and return its transcript.
 * Returns undefined when Taddy knows the episode but has no transcript.
 */
export async function fetchTaddyTranscript(
  config: ResolvedConfig,
  episode: { guid?: string; title: string },
  fetchImpl: FetchLike = fetch,
  retry: RetryOptions = {},
): Promise<TaddyTranscript | undefined> {
  if (!taddyConfigured(config)) {
    throw new CastrecallSetupError(
      "Taddy is not configured. Set TADDY_API_KEY and TADDY_USER_ID (free signup at https://taddy.org/developers) " +
        "or skip this rung of the transcript ladder.",
    );
  }

  const attempts: Array<Record<string, string>> = [];
  if (episode.guid) attempts.push({ guid: episode.guid });
  attempts.push({ name: episode.title });

  for (const variables of attempts) {
    const argName = Object.keys(variables)[0];
    const query = `query GetEpisode($value: String!) {
      getPodcastEpisode(${argName}: $value) {
        uuid
        name
        taddyTranscribeStatus
        transcript
      }
    }`;
    const result = await taddyRequest(config, query, { value: variables[argName] }, fetchImpl, retry);
    const episodeData = result?.getPodcastEpisode as
      | { uuid?: string; transcript?: string[] | string | null }
      | null
      | undefined;
    if (!episodeData) continue;
    const transcript = episodeData.transcript;
    const text = Array.isArray(transcript)
      ? transcript.filter((line) => typeof line === "string").join("\n")
      : typeof transcript === "string"
        ? transcript
        : "";
    if (text.trim()) {
      return { text: text.trim(), episodeUuid: episodeData.uuid };
    }
  }
  return undefined;
}

async function taddyRequest(
  config: ResolvedConfig,
  query: string,
  variables: Record<string, string>,
  fetchImpl: FetchLike,
  retry: RetryOptions = {},
): Promise<Record<string, unknown> | undefined> {
  let response: Response;
  try {
    response = await fetchWithRetry(
      fetchImpl,
      TADDY_ENDPOINT,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-user-id": config.taddy.userId ?? "",
          "x-api-key": config.taddy.apiKey ?? "",
        },
        body: JSON.stringify({ query, variables }),
      },
      retry,
    );
  } catch (error) {
    throw new Error(
      `Could not reach the Taddy API (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new CastrecallSetupError(
      "Taddy rejected the configured credentials. Check TADDY_API_KEY and TADDY_USER_ID.",
    );
  }
  if (!response.ok) {
    throw new Error(`Taddy API request failed with HTTP ${response.status}.`);
  }
  const body = (await response.json()) as {
    data?: Record<string, unknown>;
    errors?: Array<{ message?: string }>;
  };
  if (body.errors?.length) {
    const notFound = body.errors.every((e) => /not.?found/i.test(e.message ?? ""));
    if (notFound) return undefined;
    throw new Error(`Taddy API error: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  return body.data;
}
