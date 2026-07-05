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
