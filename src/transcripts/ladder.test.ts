import { describe, expect, it } from "vitest";
import { resolveConfig } from "../config.js";
import type { ListenRecord } from "../storage.js";
import { runTranscriptLadder } from "./ladder.js";

function config(env: NodeJS.ProcessEnv = {}) {
  return resolveConfig({}, env);
}

const RECORD: ListenRecord = {
  uuid: "ep-1",
  title: "Episode One",
  podcastUuid: "pod-1",
  podcastTitle: "Example Show",
  audioUrl: "https://cdn.example.com/ep1.mp3",
  firstSeenAt: "2026-07-04T00:00:00.000Z",
  transcriptStatus: "none",
};

const EMPTY_FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Example Show</title></channel></rss>`;

function fetchImplWithListenNotes() {
  const calls = { listenNotes: 0 };
  const fetchImpl = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("refresh.pocketcasts.com")) {
      return new Response(JSON.stringify({ result: {} }), { status: 200 });
    }
    if (url.includes("itunes.apple.com")) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (url.includes("listen-api.listennotes.com")) {
      calls.listenNotes++;
      return new Response(
        JSON.stringify({
          results: [{ title_original: "Example Show", rss: "https://feeds.example.com/from-listennotes.xml" }],
        }),
        { status: 200 },
      );
    }
    if (url === "https://feeds.example.com/from-listennotes.xml") {
      return new Response(EMPTY_FEED_XML, { status: 200 });
    }
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("runTranscriptLadder feed resolution with Listen Notes configured", () => {
  it("resolves a feed URL via Listen Notes when Pocket Casts and iTunes both miss", async () => {
    const { fetchImpl, calls } = fetchImplWithListenNotes();

    const result = await runTranscriptLadder(
      config({ LISTENNOTES_API_KEY: "ln_x" }),
      RECORD,
      { fetchImpl, env: { PATH: "" }, skipStt: true },
    );

    expect(calls.listenNotes).toBe(1);
    const rss = result.rungs.find((r) => r.rung === "rss")!;
    expect(rss.outcome).not.toBe("failed");
  });

  it("stays failed with the Pocket-Casts-and-iTunes-only message when LISTENNOTES_API_KEY is unset", async () => {
    const { fetchImpl, calls } = fetchImplWithListenNotes();

    const result = await runTranscriptLadder(config({}), RECORD, {
      fetchImpl,
      env: { PATH: "" },
      skipStt: true,
    });

    expect(calls.listenNotes).toBe(0);
    const rss = result.rungs.find((r) => r.rung === "rss")!;
    expect(rss.outcome).toBe("failed");
    expect(rss.detail).toBe(
      "Could not resolve the podcast's RSS feed URL (Pocket Casts feed export and iTunes search both missed).",
    );
  });
});
