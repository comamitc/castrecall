import { describe, expect, it } from "vitest";
import type { FetchLike } from "./pocketcasts/client.js";
import { extractTranscriptLinks, findFeedItem, resolveFeedUrl } from "./resolver.js";
import { rankTranscriptLinks } from "./transcripts/rss.js";

const noWaitSleep = async () => {};

const FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0">
  <channel>
    <title>Example Show</title>
    <item>
      <title>Episode One: Beginnings</title>
      <guid isPermaLink="false">ep-guid-001</guid>
      <link>https://example.com/episodes/1</link>
      <enclosure url="https://cdn.example.com/audio/ep1.mp3?token=abc" type="audio/mpeg" length="1"/>
      <podcast:transcript url="https://cdn.example.com/transcripts/ep1.vtt" type="text/vtt"/>
      <podcast:transcript url="https://cdn.example.com/transcripts/ep1.json" type="application/json" language="en"/>
      <podcast:transcript url="https://cdn.example.com/transcripts/ep1.html" type="text/html"/>
    </item>
    <item>
      <title>Episode Two: No Transcript</title>
      <guid isPermaLink="false">ep-guid-002</guid>
      <enclosure url="https://cdn.example.com/audio/ep2.mp3" type="audio/mpeg" length="1"/>
    </item>
  </channel>
</rss>`;

describe("findFeedItem", () => {
  it("matches by enclosure URL ignoring query strings", () => {
    const item = findFeedItem(
      FEED_XML,
      { title: "totally different title", url: "https://cdn.example.com/audio/ep1.mp3?other=1", uuid: "x" },
      "https://example.com/feed.xml",
    );
    expect(item?.itemTitle).toBe("Episode One: Beginnings");
    expect(item?.itemGuid).toBe("ep-guid-001");
    expect(item?.transcripts).toHaveLength(3);
  });

  it("falls back to title matching", () => {
    const item = findFeedItem(
      FEED_XML,
      { title: "  episode two: NO transcript ", url: "", uuid: "x" },
      "https://example.com/feed.xml",
    );
    expect(item?.itemGuid).toBe("ep-guid-002");
    expect(item?.transcripts).toEqual([]);
  });

  it("returns undefined when nothing matches", () => {
    const item = findFeedItem(
      FEED_XML,
      { title: "unknown", url: "https://elsewhere.com/a.mp3", uuid: "x" },
      "https://example.com/feed.xml",
    );
    expect(item).toBeUndefined();
  });
});

describe("extractTranscriptLinks", () => {
  it("handles a single (non-array) transcript tag", () => {
    const links = extractTranscriptLinks({
      "podcast:transcript": { "@_url": "https://a.example/t.srt", "@_type": "application/srt" },
    });
    expect(links).toEqual([
      { url: "https://a.example/t.srt", type: "application/srt", language: undefined, rel: undefined },
    ]);
  });

  it("drops entries without a url", () => {
    expect(extractTranscriptLinks({ "podcast:transcript": [{ "@_type": "text/vtt" }] })).toEqual([]);
  });

  it("handles namespace aliases and relative transcript URLs", () => {
    const links = extractTranscriptLinks(
      {
        "pc:transcript": {
          "@_url": "../transcripts/ep1.srt?download=1",
          "@_type": "text/srt",
          "@_language": "en",
        },
      },
      "https://example.com/podcasts/feed.xml",
    );
    expect(links).toEqual([
      {
        url: "https://example.com/transcripts/ep1.srt?download=1",
        type: "text/srt",
        language: "en",
        rel: undefined,
      },
    ]);
  });
});

describe("resolveFeedUrl retry behavior", () => {
  it("retries a transient feed-export 500 and returns the feed-export URL without ever calling iTunes", async () => {
    let feedExportCalls = 0;
    let itunesCalls = 0;
    const fetchImpl: FetchLike = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("refresh.pocketcasts.com")) {
        feedExportCalls++;
        if (feedExportCalls < 2) return new Response("err", { status: 500 });
        return new Response(
          JSON.stringify({ result: { "uuid-1": "https://feeds.example.com/show.xml" } }),
          { status: 200 },
        );
      }
      itunesCalls++;
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as FetchLike;

    const feedUrl = await resolveFeedUrl("uuid-1", "Example Show", fetchImpl, {
      sleep: noWaitSleep,
    });

    expect(feedUrl).toBe("https://feeds.example.com/show.xml");
    expect(feedExportCalls).toBe(2);
    expect(itunesCalls).toBe(0);
  });
});

describe("resolveFeedUrl Listen Notes fallback", () => {
  function makeFetch(listenNotesResults: Array<{ title_original?: string; rss?: string }>, opts: {
    listenNotesStatus?: number;
  } = {}) {
    const calls = { pocketcasts: 0, itunes: 0, listenNotes: 0 };
    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    const fetchImpl: FetchLike = (async (input: unknown, init?: any) => {
      const url = String(input);
      if (url.includes("refresh.pocketcasts.com")) {
        calls.pocketcasts++;
        return new Response(JSON.stringify({ result: {} }), { status: 200 });
      }
      if (url.includes("itunes.apple.com")) {
        calls.itunes++;
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }
      calls.listenNotes++;
      capturedUrl = url;
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify({ results: listenNotesResults }), {
        status: opts.listenNotesStatus ?? 200,
      });
    }) as FetchLike;
    return { fetchImpl, calls, getCapturedUrl: () => capturedUrl, getCapturedHeaders: () => capturedHeaders };
  }

  it("falls back to Listen Notes when Pocket Casts and iTunes both miss", async () => {
    const { fetchImpl, calls, getCapturedUrl, getCapturedHeaders } = makeFetch([
      { title_original: "Example Show", rss: "https://feeds.example.com/from-listennotes.xml" },
    ]);

    const feedUrl = await resolveFeedUrl("uuid-1", "Example Show", fetchImpl, {}, "ln_key");

    expect(feedUrl).toBe("https://feeds.example.com/from-listennotes.xml");
    expect(calls.listenNotes).toBe(1);
    const requestUrl = new URL(getCapturedUrl()!);
    expect(requestUrl.searchParams.get("type")).toBe("podcast");
    expect(requestUrl.searchParams.get("q")).toBe("Example Show");
    expect(getCapturedHeaders()).toEqual({ "X-ListenAPI-Key": "ln_key" });
  });

  it("never calls Listen Notes when no API key is supplied", async () => {
    const { fetchImpl, calls } = makeFetch([
      { title_original: "Example Show", rss: "https://feeds.example.com/from-listennotes.xml" },
    ]);

    const feedUrl = await resolveFeedUrl("uuid-1", "Example Show", fetchImpl);

    expect(feedUrl).toBeUndefined();
    expect(calls.listenNotes).toBe(0);
  });

  it("does not call iTunes or Listen Notes when Pocket Casts feed export hits", async () => {
    let itunesCalls = 0;
    let listenNotesCalls = 0;
    const fetchImpl: FetchLike = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("refresh.pocketcasts.com")) {
        return new Response(
          JSON.stringify({ result: { "uuid-1": "https://feeds.example.com/show.xml" } }),
          { status: 200 },
        );
      }
      if (url.includes("itunes.apple.com")) itunesCalls++;
      else listenNotesCalls++;
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as FetchLike;

    const feedUrl = await resolveFeedUrl("uuid-1", "Example Show", fetchImpl, {}, "ln_key");

    expect(feedUrl).toBe("https://feeds.example.com/show.xml");
    expect(itunesCalls).toBe(0);
    expect(listenNotesCalls).toBe(0);
  });

  it("returns undefined without throwing on a non-ok Listen Notes response", async () => {
    const { fetchImpl } = makeFetch([], { listenNotesStatus: 401 });

    const feedUrl = await resolveFeedUrl("uuid-1", "Example Show", fetchImpl, {}, "ln_key");

    expect(feedUrl).toBeUndefined();
  });

  it("matches by normalized title, case/whitespace-insensitively", async () => {
    const { fetchImpl } = makeFetch([
      { title_original: "Another Show", rss: "https://feeds.example.com/another.xml" },
      { title_original: "  EXAMPLE   show ", rss: "https://feeds.example.com/match.xml" },
    ]);

    const feedUrl = await resolveFeedUrl("uuid-1", "Example Show", fetchImpl, {}, "ln_key");

    expect(feedUrl).toBe("https://feeds.example.com/match.xml");
  });

  it("falls back to the first rss-bearing result when no title matches", async () => {
    const { fetchImpl } = makeFetch([
      { title_original: "Totally Different", rss: "https://feeds.example.com/first.xml" },
      { title_original: "Also Different", rss: "https://feeds.example.com/second.xml" },
    ]);

    const feedUrl = await resolveFeedUrl("uuid-1", "Example Show", fetchImpl, {}, "ln_key");

    expect(feedUrl).toBe("https://feeds.example.com/first.xml");
  });

  it("returns undefined when no results carry an rss field (episode-shaped payload)", async () => {
    const { fetchImpl } = makeFetch([{ title_original: "Example Show" }]);

    const feedUrl = await resolveFeedUrl("uuid-1", "Example Show", fetchImpl, {}, "ln_key");

    expect(feedUrl).toBeUndefined();
  });
});

describe("rankTranscriptLinks", () => {
  it("prefers structured formats over html", () => {
    const ranked = rankTranscriptLinks([
      { url: "c.html", type: "text/html" },
      { url: "a.json", type: "application/json" },
      { url: "b.vtt", type: "text/vtt" },
      { url: "d.srt", type: "text/srt" },
    ]);
    expect(ranked.map((l) => l.url)).toEqual(["a.json", "b.vtt", "d.srt", "c.html"]);
  });
});
