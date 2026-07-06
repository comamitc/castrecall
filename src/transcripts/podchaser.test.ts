import { describe, expect, it } from "vitest";
import { CastrecallSetupError, resolveConfig } from "../config.js";
import { fetchPodchaserTranscript, podchaserConfigured } from "./podchaser.js";

const noWaitSleep = async () => {};
const RETRY = { maxAttempts: 1, sleep: noWaitSleep };

const GRAPHQL_URL = "https://api.podchaser.com/graphql";
const TRANSCRIPT_URL = "https://transcripts.example.com/ep1.json";

const DEFAULT_TOKEN = "pk_test_token";

function config(env: NodeJS.ProcessEnv = { PODCHASER_API_KEY: DEFAULT_TOKEN }) {
  return resolveConfig({}, env);
}

function configuredWith(apiKey: string) {
  return resolveConfig({}, { PODCHASER_API_KEY: apiKey });
}

const NOT_CONFIGURED = resolveConfig({}, {});

function graphqlResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function episodeByGuidResponse(transcripts: unknown[]): Response {
  return graphqlResponse({ data: { episode: { title: "Episode One", transcripts } } });
}

function notFoundResponse(): Response {
  return graphqlResponse({ errors: [{ message: "Episode not found" }] });
}

function searchResponse(episodes: Array<{ title: string; transcripts: unknown[] }>): Response {
  return graphqlResponse({ data: { episodes: { data: episodes } } });
}

describe("podchaserConfigured", () => {
  it("is true only when PODCHASER_API_KEY is set", () => {
    expect(podchaserConfigured(configuredWith("pk_x"))).toBe(true);
    expect(podchaserConfigured(NOT_CONFIGURED)).toBe(false);
  });
});

describe("fetchPodchaserTranscript", () => {
  it("throws CastrecallSetupError when not configured", async () => {
    await expect(
      fetchPodchaserTranscript(NOT_CONFIGURED, { guid: "g1", title: "Episode One" }),
    ).rejects.toThrowError(CastrecallSetupError);
  });

  it("GUID hit: beautified_JSON transcript ref, transcript URL returns an utterances object", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === GRAPHQL_URL) {
        return episodeByGuidResponse([
          { url: TRANSCRIPT_URL, source: "podchaser", transcriptType: "beautified_JSON" },
        ]);
      }
      if (url === TRANSCRIPT_URL) {
        return new Response(
          JSON.stringify({ utterances: [{ utterance: "hello" }, { utterance: "world" }] }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await fetchPodchaserTranscript(
      config(),
      { guid: "guid-1", title: "Episode One" },
      fetchImpl,
      RETRY,
    );
    expect(result).toEqual({ text: "hello\nworld", sourceUrl: TRANSCRIPT_URL });
  });

  it("GUID lookup sends the documented EpisodeIdentifier shape ({ id, type })", async () => {
    let capturedVariables: unknown;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === GRAPHQL_URL) {
        const body = JSON.parse(String(init?.body)) as { query: string; variables: unknown };
        if (body.query.includes("GetEpisodeByGuid")) {
          capturedVariables = body.variables;
          return episodeByGuidResponse([]);
        }
        return notFoundResponse();
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await fetchPodchaserTranscript(config(), { guid: "guid-1", title: "Episode One" }, fetchImpl, RETRY);

    expect(capturedVariables).toEqual({ identifier: { id: "guid-1", type: "GUID" } });
  });

  it("raw_JSON hit: top-level array of utterance objects yields the same joined text", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === GRAPHQL_URL) {
        return episodeByGuidResponse([
          { url: TRANSCRIPT_URL, source: "podchaser", transcriptType: "raw_JSON" },
        ]);
      }
      if (url === TRANSCRIPT_URL) {
        return new Response(JSON.stringify([{ utterance: "hello" }, { utterance: "world" }]), {
          status: 200,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await fetchPodchaserTranscript(
      config(),
      { guid: "guid-1", title: "Episode One" },
      fetchImpl,
      RETRY,
    );
    expect(result).toEqual({ text: "hello\nworld", sourceUrl: TRANSCRIPT_URL });
  });

  it("prefers beautified_JSON over raw_JSON when both are declared", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === GRAPHQL_URL) {
        return episodeByGuidResponse([
          { url: "https://transcripts.example.com/raw.json", transcriptType: "raw_JSON" },
          { url: TRANSCRIPT_URL, transcriptType: "beautified_JSON" },
        ]);
      }
      if (url === TRANSCRIPT_URL) {
        return new Response(JSON.stringify({ utterances: [{ utterance: "beautified wins" }] }), {
          status: 200,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await fetchPodchaserTranscript(
      config(),
      { guid: "guid-1", title: "Episode One" },
      fetchImpl,
      RETRY,
    );
    expect(result?.sourceUrl).toBe(TRANSCRIPT_URL);
    expect(result?.text).toBe("beautified wins");
  });

  it("title fallback: GUID attempt not-found, episodes(searchTerm:) exact-title match yields a hit", async () => {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === GRAPHQL_URL) {
        const body = JSON.parse(String(init?.body)) as { query: string };
        if (body.query.includes("GetEpisodeByGuid")) return notFoundResponse();
        return searchResponse([
          { title: "Some Other Episode", transcripts: [] },
          { title: "Episode One", transcripts: [{ url: TRANSCRIPT_URL, transcriptType: "raw_JSON" }] },
        ]);
      }
      if (url === TRANSCRIPT_URL) {
        return new Response(JSON.stringify([{ utterance: "found by title" }]), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await fetchPodchaserTranscript(
      config(),
      { guid: "guid-1", title: "Episode One" },
      fetchImpl,
      RETRY,
    );
    expect(result).toEqual({ text: "found by title", sourceUrl: TRANSCRIPT_URL });
  });

  it("title fallback misses when no episode title matches exactly", async () => {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === GRAPHQL_URL) {
        const body = JSON.parse(String(init?.body)) as { query: string };
        if (body.query.includes("GetEpisodeByGuid")) return notFoundResponse();
        return searchResponse([{ title: "A Totally Different Episode", transcripts: [] }]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await fetchPodchaserTranscript(
      config(),
      { guid: "guid-1", title: "Episode One" },
      fetchImpl,
      RETRY,
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined (miss) when the episode has no transcripts", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === GRAPHQL_URL) return episodeByGuidResponse([]);
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await fetchPodchaserTranscript(
      config(),
      { guid: "guid-1", title: "Episode One" },
      fetchImpl,
      RETRY,
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined (miss, no throw) for an unrecognized transcript JSON shape", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === GRAPHQL_URL) {
        return episodeByGuidResponse([{ url: TRANSCRIPT_URL, transcriptType: "raw_JSON" }]);
      }
      if (url === TRANSCRIPT_URL) {
        return new Response(JSON.stringify({ unexpected: "shape" }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await fetchPodchaserTranscript(
      config(),
      { guid: "guid-1", title: "Episode One" },
      fetchImpl,
      RETRY,
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined (miss, no throw) when utterances are whitespace-only", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === GRAPHQL_URL) {
        return episodeByGuidResponse([{ url: TRANSCRIPT_URL, transcriptType: "raw_JSON" }]);
      }
      if (url === TRANSCRIPT_URL) {
        return new Response(JSON.stringify([{ utterance: "   " }, { utterance: "" }]), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await fetchPodchaserTranscript(
      config(),
      { guid: "guid-1", title: "Episode One" },
      fetchImpl,
      RETRY,
    );
    expect(result).toBeUndefined();
  });

  it("throws a plain Error when the transcript URL fetch returns non-ok", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === GRAPHQL_URL) {
        return episodeByGuidResponse([{ url: TRANSCRIPT_URL, transcriptType: "raw_JSON" }]);
      }
      if (url === TRANSCRIPT_URL) {
        return new Response("gone", { status: 404 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await expect(
      fetchPodchaserTranscript(config(), { guid: "guid-1", title: "Episode One" }, fetchImpl, RETRY),
    ).rejects.toThrowError(/HTTP 404/);
  });

  it("throws CastrecallSetupError on GraphQL 401/403 without leaking the token", async () => {
    const token = "pk_super_secret_token";
    for (const status of [401, 403]) {
      const fetchImpl = (async () => new Response("nope", { status })) as typeof fetch;
      await expect(
        fetchPodchaserTranscript(configuredWith(token), { guid: "guid-1", title: "Episode One" }, fetchImpl, RETRY),
      ).rejects.toThrowError(CastrecallSetupError);
      try {
        await fetchPodchaserTranscript(configuredWith(token), { guid: "guid-1", title: "Episode One" }, fetchImpl, RETRY);
      } catch (error) {
        expect((error as Error).message).not.toContain(token);
      }
    }
  });

  it("throws a plain Error on GraphQL HTTP 500 without leaking the token", async () => {
    const token = "pk_super_secret_token";
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    await expect(
      fetchPodchaserTranscript(configuredWith(token), { guid: "guid-1", title: "Episode One" }, fetchImpl, RETRY),
    ).rejects.toThrowError(/HTTP 500/);
    try {
      await fetchPodchaserTranscript(configuredWith(token), { guid: "guid-1", title: "Episode One" }, fetchImpl, RETRY);
    } catch (error) {
      expect((error as Error).message).not.toContain(token);
      expect(error).not.toBeInstanceOf(CastrecallSetupError);
    }
  });
});
