import { describe, expect, it } from "vitest";
import { CastrecallSetupError, resolveConfig } from "../config.js";
import { fetchPodchaserTranscript, podchaserConfigured } from "./podchaser.js";

const noWaitSleep = async () => {};
const RETRY = { maxAttempts: 1, sleep: noWaitSleep };

const GRAPHQL_URL = "https://api.podchaser.com/graphql";
const TRANSCRIPT_URL = "https://transcripts.example.com/ep1.json";

const DEFAULT_TOKEN = "pk_test_token";
const PODCAST_TITLE = "Example Show";
const FEED_URL = "https://feeds.example.com/show.xml";

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

function episodeByGuidResponse(
  transcripts: unknown[],
  podcast: unknown = { title: PODCAST_TITLE, rssUrl: FEED_URL },
): Response {
  return graphqlResponse({ data: { episode: { title: "Episode One", transcripts, podcast } } });
}

function notFoundResponse(): Response {
  return graphqlResponse({ errors: [{ message: "Episode not found" }] });
}

function searchResponse(
  episodes: Array<{ title: string; transcripts: unknown[]; podcast?: unknown }>,
): Response {
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
      { guid: "guid-1", title: "Episode One", podcastTitle: PODCAST_TITLE },
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

    await fetchPodchaserTranscript(config(), { guid: "guid-1", title: "Episode One", podcastTitle: PODCAST_TITLE }, fetchImpl, RETRY);

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
      { guid: "guid-1", title: "Episode One", podcastTitle: PODCAST_TITLE },
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
      { guid: "guid-1", title: "Episode One", podcastTitle: PODCAST_TITLE },
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
          {
            title: "Episode One",
            transcripts: [{ url: TRANSCRIPT_URL, transcriptType: "raw_JSON" }],
            podcast: { title: PODCAST_TITLE, rssUrl: FEED_URL },
          },
        ]);
      }
      if (url === TRANSCRIPT_URL) {
        return new Response(JSON.stringify([{ utterance: "found by title" }]), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await fetchPodchaserTranscript(
      config(),
      { guid: "guid-1", title: "Episode One", podcastTitle: PODCAST_TITLE },
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
      { guid: "guid-1", title: "Episode One", podcastTitle: PODCAST_TITLE },
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
      { guid: "guid-1", title: "Episode One", podcastTitle: PODCAST_TITLE },
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
      { guid: "guid-1", title: "Episode One", podcastTitle: PODCAST_TITLE },
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
      { guid: "guid-1", title: "Episode One", podcastTitle: PODCAST_TITLE },
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
      fetchPodchaserTranscript(config(), { guid: "guid-1", title: "Episode One", podcastTitle: PODCAST_TITLE }, fetchImpl, RETRY),
    ).rejects.toThrowError(/HTTP 404/);
  });

  it("throws CastrecallSetupError on GraphQL 401/403 without leaking the token", async () => {
    const token = "pk_super_secret_token";
    for (const status of [401, 403]) {
      const fetchImpl = (async () => new Response("nope", { status })) as typeof fetch;
      await expect(
        fetchPodchaserTranscript(configuredWith(token), { guid: "guid-1", title: "Episode One", podcastTitle: PODCAST_TITLE }, fetchImpl, RETRY),
      ).rejects.toThrowError(CastrecallSetupError);
      try {
        await fetchPodchaserTranscript(configuredWith(token), { guid: "guid-1", title: "Episode One", podcastTitle: PODCAST_TITLE }, fetchImpl, RETRY);
      } catch (error) {
        expect((error as Error).message).not.toContain(token);
      }
    }
  });

  it("throws a plain Error on GraphQL HTTP 500 without leaking the token", async () => {
    const token = "pk_super_secret_token";
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    await expect(
      fetchPodchaserTranscript(configuredWith(token), { guid: "guid-1", title: "Episode One", podcastTitle: PODCAST_TITLE }, fetchImpl, RETRY),
    ).rejects.toThrowError(/HTTP 500/);
    try {
      await fetchPodchaserTranscript(configuredWith(token), { guid: "guid-1", title: "Episode One", podcastTitle: PODCAST_TITLE }, fetchImpl, RETRY);
    } catch (error) {
      expect((error as Error).message).not.toContain(token);
      expect(error).not.toBeInstanceOf(CastrecallSetupError);
    }
  });

  it("GUID hit for a matching guid on a different podcast is treated as a miss", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === GRAPHQL_URL) {
        return episodeByGuidResponse(
          [{ url: TRANSCRIPT_URL, transcriptType: "raw_JSON" }],
          { title: "Some Other Show", rssUrl: "https://feeds.example.com/other.xml" },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await fetchPodchaserTranscript(
      config(),
      { guid: "guid-1", title: "Episode One", feedUrl: FEED_URL, podcastTitle: PODCAST_TITLE },
      fetchImpl,
      RETRY,
    );
    expect(result).toBeUndefined();
  });

  it("title fallback matches the same title on two podcasts and only accepts the one from the resolved feed", async () => {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === GRAPHQL_URL) {
        const body = JSON.parse(String(init?.body)) as { query: string };
        if (body.query.includes("GetEpisodeByGuid")) return notFoundResponse();
        return searchResponse([
          {
            title: "Episode One",
            transcripts: [{ url: "https://transcripts.example.com/wrong.json", transcriptType: "raw_JSON" }],
            podcast: { title: "Some Other Show", rssUrl: "https://feeds.example.com/other.xml" },
          },
          {
            title: "Episode One",
            transcripts: [{ url: TRANSCRIPT_URL, transcriptType: "raw_JSON" }],
            podcast: { title: PODCAST_TITLE, rssUrl: FEED_URL },
          },
        ]);
      }
      if (url === TRANSCRIPT_URL) {
        return new Response(JSON.stringify([{ utterance: "correct show" }]), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await fetchPodchaserTranscript(
      config(),
      { guid: "guid-1", title: "Episode One", feedUrl: FEED_URL, podcastTitle: PODCAST_TITLE },
      fetchImpl,
      RETRY,
    );
    expect(result).toEqual({ text: "correct show", sourceUrl: TRANSCRIPT_URL });
  });

  it("title fallback misses a same-title candidate with no rssUrl when a feed URL is expected", async () => {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === GRAPHQL_URL) {
        const body = JSON.parse(String(init?.body)) as { query: string };
        if (body.query.includes("GetEpisodeByGuid")) return notFoundResponse();
        return searchResponse([
          {
            title: "Episode One",
            transcripts: [{ url: "https://transcripts.example.com/wrong.json", transcriptType: "raw_JSON" }],
            podcast: { title: PODCAST_TITLE },
          },
        ]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await fetchPodchaserTranscript(
      config(),
      { guid: "guid-1", title: "Episode One", feedUrl: FEED_URL, podcastTitle: PODCAST_TITLE },
      fetchImpl,
      RETRY,
    );
    expect(result).toBeUndefined();
  });

  it("GUID lookup never includes the feed URL in the identifier — scoping is local-only", async () => {
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

    await fetchPodchaserTranscript(
      config(),
      { guid: "guid-1", title: "Episode One", feedUrl: FEED_URL, podcastTitle: PODCAST_TITLE },
      fetchImpl,
      RETRY,
    );

    expect(capturedVariables).toEqual({ identifier: { id: "guid-1", type: "GUID" } });
  });

  it("never transmits a feed URL to Podchaser wherever its token hides (query, userinfo, fragment, path)", async () => {
    const tokenizedUrls = [
      "https://feeds.example.com/show.xml?auth=SECRET-SUBSCRIBER-TOKEN",
      "https://user:SECRET-SUBSCRIBER-TOKEN@feeds.example.com/show.xml",
      "https://feeds.example.com/show.xml#SECRET-SUBSCRIBER-TOKEN",
      "https://feeds.example.com/private/SECRET-SUBSCRIBER-TOKEN/show.xml",
    ];
    for (const tokenizedFeedUrl of tokenizedUrls) {
      const requestBodies: string[] = [];
      const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === GRAPHQL_URL) {
          requestBodies.push(String(init?.body));
          return notFoundResponse();
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as typeof fetch;

      await fetchPodchaserTranscript(
        config(),
        { guid: "guid-1", title: "Episode One", feedUrl: tokenizedFeedUrl, podcastTitle: PODCAST_TITLE },
        fetchImpl,
        RETRY,
      );

      expect(requestBodies.length).toBeGreaterThan(0);
      for (const body of requestBodies) {
        expect(body).not.toContain("SECRET-SUBSCRIBER-TOKEN");
        expect(body).not.toContain("feeds.example.com");
      }
      // The GUID identifier is always unscoped; local validation gates the match.
      const guidVariables = JSON.parse(requestBodies[0]).variables;
      expect(guidVariables).toEqual({ identifier: { id: "guid-1", type: "GUID" } });
    }
  });

  it("a tokenized feed URL still scopes matching locally: wrong-podcast candidates stay misses", async () => {
    const tokenizedFeedUrl = "https://feeds.example.com/show.xml?auth=SECRET-SUBSCRIBER-TOKEN";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === GRAPHQL_URL) {
        // Unscoped lookup returns a same-guid candidate from a DIFFERENT feed.
        return episodeByGuidResponse(
          [{ url: TRANSCRIPT_URL, transcriptType: "raw_JSON" }],
          { title: "Imposter Show", rssUrl: "https://feeds.other.example/imposter.xml" },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await fetchPodchaserTranscript(
      config(),
      { guid: "guid-1", title: "Episode One", feedUrl: tokenizedFeedUrl, podcastTitle: PODCAST_TITLE },
      fetchImpl,
      RETRY,
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined (miss) when there is no feed URL or podcast title to scope the match against", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === GRAPHQL_URL) {
        return episodeByGuidResponse([{ url: TRANSCRIPT_URL, transcriptType: "raw_JSON" }]);
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
});
