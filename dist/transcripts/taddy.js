/**
 * Rung 2 of the transcript ladder: the Taddy podcast API (https://taddy.org).
 * Optional; only used when TADDY_API_KEY and TADDY_USER_ID are set.
 * Transcript access requires a paid Taddy plan; free keys return no transcript.
 */
import { CastrecallSetupError } from "../config.js";
const TADDY_ENDPOINT = "https://api.taddy.org";
export function taddyConfigured(config) {
    return Boolean(config.taddy.apiKey && config.taddy.userId);
}
/**
 * Look an episode up by RSS GUID first (exact), then by name, and return its transcript.
 * Returns undefined when Taddy knows the episode but has no transcript.
 */
export async function fetchTaddyTranscript(config, episode, fetchImpl = fetch) {
    if (!taddyConfigured(config)) {
        throw new CastrecallSetupError("Taddy is not configured. Set TADDY_API_KEY and TADDY_USER_ID (free signup at https://taddy.org/developers) " +
            "or skip this rung of the transcript ladder.");
    }
    const attempts = [];
    if (episode.guid)
        attempts.push({ guid: episode.guid });
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
        const result = await taddyRequest(config, query, { value: variables[argName] }, fetchImpl);
        const episodeData = result?.getPodcastEpisode;
        if (!episodeData)
            continue;
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
async function taddyRequest(config, query, variables, fetchImpl) {
    let response;
    try {
        response = await fetchImpl(TADDY_ENDPOINT, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-user-id": config.taddy.userId ?? "",
                "x-api-key": config.taddy.apiKey ?? "",
            },
            body: JSON.stringify({ query, variables }),
        });
    }
    catch (error) {
        throw new Error(`Could not reach the Taddy API (${error instanceof Error ? error.message : String(error)}).`);
    }
    if (response.status === 401 || response.status === 403) {
        throw new CastrecallSetupError("Taddy rejected the configured credentials. Check TADDY_API_KEY and TADDY_USER_ID.");
    }
    if (!response.ok) {
        throw new Error(`Taddy API request failed with HTTP ${response.status}.`);
    }
    const body = (await response.json());
    if (body.errors?.length) {
        const notFound = body.errors.every((e) => /not.?found/i.test(e.message ?? ""));
        if (notFound)
            return undefined;
        throw new Error(`Taddy API error: ${body.errors.map((e) => e.message).join("; ")}`);
    }
    return body.data;
}
