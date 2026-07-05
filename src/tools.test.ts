import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "./config.js";
import { Storage, type Provenance } from "./storage.js";
import { fetchTranscript, generateReview, listRecent, setupStatus, syncHistory } from "./tools.js";

const PROVENANCE: Provenance = {
  platform: "pocketcasts",
  podcastTitle: "Example Show",
  episodeTitle: "Episode One",
  episodeUuid: "ep-1",
  audioUrl: "https://cdn.example.com/ep1.mp3?token=secret-audio",
  transcriptSourceUrl: "https://cdn.example.com/ep1.vtt?sig=secret-transcript",
  transcriptSource: "rss",
  format: "vtt",
  fetchedAt: "2026-07-04T00:00:00Z",
  privacyClass: "private-source",
};

describe("tools", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "castrecall-tools-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function config(env: NodeJS.ProcessEnv = {}) {
    return resolveConfig({}, { CASTRECALL_DATA_DIR: dir, ...env });
  }

  it("setup_status reports configuration presence without leaking secrets", async () => {
    const status = (await setupStatus(
      config({ POCKETCASTS_EMAIL: "secret@example.com", POCKETCASTS_PASSWORD: "hunter2" }),
    )) as Record<string, any>;
    expect(status.pocketcasts.credentialsConfigured).toBe(true);
    expect(JSON.stringify(status)).not.toContain("secret@example.com");
    expect(JSON.stringify(status)).not.toContain("hunter2");
    expect(status.counts.syncedListens).toBe(0);
  });

  it("sync_history fails fast with an actionable error when credentials are missing", async () => {
    await expect(syncHistory(config(), {})).rejects.toThrowError(/POCKETCASTS_EMAIL/);
  });

  it("sync_history records new listens via the (stubbed) Pocket Casts API", async () => {
    const fetchImpl = (async (input: any) => {
      const url = String(input);
      if (url.endsWith("/user/login")) {
        return new Response(JSON.stringify({ token: "tok" }), { status: 200 });
      }
      if (url.endsWith("/user/history")) {
        return new Response(
          JSON.stringify({
            episodes: [
              {
                uuid: "ep-1",
                title: "Episode One",
                url: "https://cdn.example.com/ep1.mp3",
                podcastUuid: "pod-1",
                podcastTitle: "Example Show",
                playingStatus: 3,
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const cfg = config({ POCKETCASTS_EMAIL: "a@b.c", POCKETCASTS_PASSWORD: "pw" });
    const first = (await syncHistory(cfg, {}, { fetchImpl })) as Record<string, any>;
    expect(first.newListens).toHaveLength(1);
    const second = (await syncHistory(cfg, {}, { fetchImpl })) as Record<string, any>;
    expect(second.newListens).toHaveLength(0);
    expect(second.totalSeen).toBe(1);

    const recent = (await listRecent(cfg, {})) as Record<string, any>;
    expect(recent.episodes[0].episodeUuid).toBe("ep-1");
    expect(recent.episodes[0].transcriptStatus).toBe("none");
  });

  it("fetch_transcript rejects unknown episodes with a pointer to sync", async () => {
    await expect(fetchTranscript(config(), { episodeUuid: "nope" })).rejects.toThrowError(
      /castrecall_sync_history/,
    );
  });

  it("fetch_transcript reports skipped ladder rungs when providers are unconfigured", async () => {
    const storage = new Storage(dir);
    await storage.init();
    await storage.recordListens([
      {
        uuid: "ep-1",
        title: "Episode One",
        url: "https://cdn.example.com/ep1.mp3",
        podcastUuid: "pod-1",
        podcastTitle: "Example Show",
      },
    ]);
    // Every network call fails: feed resolution misses, so the RSS rung fails.
    const fetchImpl = (async () => new Response("nope", { status: 404 })) as typeof fetch;
    // Empty PATH so local Whisper detection is deterministic regardless of the host machine.
    const result = (await fetchTranscript(
      config(),
      { episodeUuid: "ep-1" },
      { fetchImpl, env: { PATH: "" } },
    )) as any;
    expect(result.status).toBe("no-transcript");
    const rungs = Object.fromEntries(result.ladder.map((r: any) => [r.rung, r]));
    expect(rungs.taddy.outcome).toBe("skipped");
    expect(rungs.taddy.detail).toContain("TADDY_API_KEY");
    expect(rungs["local-whisper"].outcome).toBe("skipped");
    expect(rungs["local-whisper"].detail).toContain("No local Whisper CLI detected");
    expect(rungs.stt.outcome).toBe("skipped");
    expect(rungs.stt.detail).toContain("CASTRECALL_ENABLE_STT");
  });

  it("fetch_transcript stores RSS transcripts without returning transcript text", async () => {
    const storage = new Storage(dir);
    await storage.init();
    await storage.recordListens([
      {
        uuid: "ep-1",
        title: "Episode One",
        url: "https://cdn.example.com/ep1.mp3",
        podcastUuid: "pod-1",
        podcastTitle: "Example Show",
      },
    ]);
    const fetchImpl = (async (input: any) => {
      const url = String(input);
      if (url.includes("export_feed_urls")) {
        return new Response(JSON.stringify({ result: { "pod-1": "https://example.com/feed.xml" } }), {
          status: 200,
        });
      }
      if (url === "https://example.com/feed.xml") {
        return new Response(
          `<?xml version="1.0"?>
          <rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0">
            <channel>
              <item>
                <title>Episode One</title>
                <guid>ep-1</guid>
                <enclosure url="https://cdn.example.com/ep1.mp3" />
                <podcast:transcript url="https://cdn.example.com/ep1.vtt" type="text/vtt" />
              </item>
            </channel>
          </rss>`,
          { status: 200 },
        );
      }
      if (url === "https://cdn.example.com/ep1.vtt") {
        return new Response("WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nPrivate transcript text.", {
          status: 200,
          headers: { "content-type": "text/vtt" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = (await fetchTranscript(config(), { episodeUuid: "ep-1" }, { fetchImpl })) as Record<string, any>;
    expect(result.status).toBe("stored");
    expect(JSON.stringify(result)).not.toContain("Private transcript text");
    expect(result.note).toContain("castrecall_generate_review");
  });

  it("fetch_transcript repairs state when transcript files already exist", async () => {
    const storage = new Storage(dir);
    await storage.init();
    await storage.recordListens([
      {
        uuid: "ep-1",
        title: "Episode One",
        url: "https://cdn.example.com/ep1.mp3",
        podcastUuid: "pod-1",
        podcastTitle: "Example Show",
      },
    ]);
    await storage.storeTranscript("ep-1", {
      raw: "stored",
      ext: "txt",
      text: "stored transcript text with enough words to review later",
      provenance: PROVENANCE,
    });

    const result = (await fetchTranscript(config(), { episodeUuid: "ep-1" })) as Record<string, any>;
    expect(result.status).toBe("already-stored");
    expect(result.episode.transcriptStatus).toBe("stored");

    const review = (await generateReview(config(), {})) as Record<string, any>;
    expect(review.generated).toHaveLength(1);
  });

  it("generate_review creates approval-gated candidates only for stored transcripts", async () => {
    const storage = new Storage(dir);
    await storage.init();
    await storage.recordListens([
      {
        uuid: "ep-1",
        title: "Episode One",
        url: "https://cdn.example.com/ep1.mp3",
        podcastUuid: "pod-1",
        podcastTitle: "Example Show",
      },
      {
        uuid: "ep-2",
        title: "Episode Two",
        url: "https://cdn.example.com/ep2.mp3",
        podcastUuid: "pod-1",
        podcastTitle: "Example Show",
      },
    ]);
    const longText = Array.from(
      { length: 6 },
      (_, i) =>
        `Paragraph ${i} of the conversation covering a substantial idea in enough detail that the excerpt picker treats it as a real candidate for review by a human reader.`,
    ).join("\n\n");
    await storage.storeTranscript("ep-1", {
      raw: longText,
      ext: "txt",
      text: longText,
      provenance: PROVENANCE,
    });
    await storage.updateEpisode("ep-1", { transcriptStatus: "stored" });

    const cfg = config();
    const result = (await generateReview(cfg, {})) as Record<string, any>;
    expect(result.generated).toHaveLength(1);
    expect(result.generated[0].episodeUuid).toBe("ep-1");

    const markdown = await fs.readFile(result.generated[0].path, "utf8");
    expect(markdown).toContain("status: pending-review");
    expect(markdown).toContain("privacy: private-source");
    expect(markdown).toContain("Nothing below is in durable memory");
    expect(markdown).not.toContain(longText); // excerpts only, never the full transcript
    expect(markdown).not.toContain("secret-audio");
    expect(markdown).not.toContain("secret-transcript");
    expect(markdown).toContain("query removed; full URL is in provenance.json");

    // Re-running generates nothing new and never overwrites the pending review.
    const again = (await generateReview(cfg, { episodeUuid: "ep-1" })) as Record<string, any>;
    expect(again.generated).toHaveLength(0);
    expect(again.skipped[0].reason).toContain("already exists");
  });
});
