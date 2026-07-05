import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "./config.js";
import { Storage, type Provenance } from "./storage.js";
import {
  fetchTranscript,
  generateReview,
  listRecent,
  setup,
  setupStatus,
  syncHistory,
} from "./tools.js";

const PROVENANCE: Provenance = {
  platform: "pocketcasts",
  podcastTitle: "Example Show",
  podcastUuid: "pod-1",
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

  it("setup_status reports sync health and cooldown state without leaking secrets", async () => {
    const storage = new Storage(dir);
    await storage.init();
    await storage.recordSyncFailure(
      "Pocket Casts history request failed with HTTP 500.",
      () => new Date("2026-07-05T00:00:00Z"),
    );

    const status = (await setupStatus(config(), { now: () => new Date("2026-07-05T00:01:00Z") })) as Record<
      string,
      any
    >;
    expect(status.sync.consecutiveFailures).toBe(1);
    expect(status.sync.lastError).toContain("HTTP 500");
    expect(status.sync.inCooldown).toBe(true);
    expect(JSON.stringify(status)).not.toContain("hunter2");
  });

  it("setup_status reports export mode and structured privacy defaults", async () => {
    const off = (await setupStatus(config(), { env: { PATH: "" } })) as Record<string, any>;
    expect(off.export).toEqual({ exportDir: null, mode: "off" });
    expect(off.privacyDefaults.dataDir).toBe(dir);
    expect(off.privacyDefaults.privacyClass).toBe("private-source");
    expect(off.privacyDefaults.durableMemory).toContain("never");

    const exportDir = path.join(dir, ".gbrain", "inbox");
    const on = (await setupStatus(config({ CASTRECALL_EXPORT_DIR: exportDir }), {
      env: { PATH: "" },
    })) as Record<string, any>;
    expect(on.export).toEqual({ exportDir, mode: "gbrain-inbox" });
  });

  describe("setup", () => {
    it("returns an ordered plan whose pocketcasts step carries both caveats, with no verify block by default", async () => {
      const result = (await setup(config(), {}, { env: { PATH: "" } })) as Record<string, any>;
      expect(result.steps.map((s: any) => s.id)).toEqual([
        "pocketcasts",
        "storage",
        "privacy",
        "providers.taddy",
        "providers.localWhisper",
        "providers.stt",
        "export",
      ]);
      const pocketcasts = result.steps.find((s: any) => s.id === "pocketcasts");
      expect(pocketcasts.status).toBe("missing");
      expect(pocketcasts.caveat).toContain("Sign in with Google/Apple");
      expect(result.privacyDefaults.dataDir).toBe(dir);
      expect(result.verify).toBeUndefined();
    });

    it("passes CASTRECALL_GBRAIN_INSTALLED through to the export step's gbrain suggestion", async () => {
      const result = (await setup(config(), {}, {
        env: { PATH: "", CASTRECALL_GBRAIN_INSTALLED: "1" },
      })) as Record<string, any>;
      const exportStep = result.steps.find((s: any) => s.id === "export");
      expect(exportStep.explanation).toContain(path.join(os.homedir(), ".gbrain", "inbox"));
    });

    it("verify:true with no credentials makes zero fetch calls and reports missing", async () => {
      let calls = 0;
      const fetchImpl = (async () => {
        calls += 1;
        throw new Error("should never be called");
      }) as unknown as typeof fetch;

      const result = (await setup(
        config(),
        { verify: true },
        { fetchImpl, env: { PATH: "" } },
      )) as Record<string, any>;
      expect(calls).toBe(0);
      expect(result.verify).toEqual({
        ok: false,
        detail: expect.stringContaining("POCKETCASTS_EMAIL"),
      });
      expect(result.steps.find((s: any) => s.id === "pocketcasts").status).toBe("missing");
    });

    it("verify:true with a stubbed fetchImpl calls login then history and reports a sample count only", async () => {
      const calledUrls: string[] = [];
      const fetchImpl = (async (input: any) => {
        const url = String(input);
        calledUrls.push(url);
        if (url.endsWith("/user/login")) {
          return new Response(JSON.stringify({ token: "tok" }), { status: 200 });
        }
        if (url.endsWith("/user/history")) {
          return new Response(
            JSON.stringify({
              episodes: [
                { uuid: "ep-1", title: "Secret Episode Title", url: "https://cdn.example.com/ep1.mp3" },
                { uuid: "ep-2", title: "Another Secret Title", url: "https://cdn.example.com/ep2.mp3" },
              ],
            }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as typeof fetch;

      const result = (await setup(
        config({ POCKETCASTS_EMAIL: "a@b.c", POCKETCASTS_PASSWORD: "pw" }),
        { verify: true },
        { fetchImpl, env: { PATH: "" } },
      )) as Record<string, any>;

      expect(calledUrls.some((u) => u.endsWith("/user/login"))).toBe(true);
      expect(calledUrls.some((u) => u.endsWith("/user/history"))).toBe(true);
      expect(result.verify).toEqual({ ok: true, sampleCount: 2 });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("Secret Episode Title");
      expect(serialized).not.toContain("Another Secret Title");
      expect(serialized).not.toContain("a@b.c");
      expect(serialized).not.toContain("pw");
    });

    it("verify:true reports failure with the SSO caveat when login is rejected, leaking no secrets", async () => {
      const fetchImpl = (async (input: any) => {
        const url = String(input);
        if (url.endsWith("/user/login")) {
          return new Response(JSON.stringify({ error: "invalid" }), { status: 401 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as typeof fetch;

      const result = (await setup(
        config({ POCKETCASTS_EMAIL: "a@b.c", POCKETCASTS_PASSWORD: "wrongpw" }),
        { verify: true },
        { fetchImpl, env: { PATH: "" } },
      )) as Record<string, any>;

      expect(result.verify.ok).toBe(false);
      expect(result.verify.detail).toContain("Sign in with Google/Apple");
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("a@b.c");
      expect(serialized).not.toContain("wrongpw");
    });

    it("never writes to disk — data dir contents and an openclaw.json sentinel are unchanged", async () => {
      await fs.mkdir(dir, { recursive: true });
      const sentinelPath = path.join(dir, "openclaw.json");
      await fs.writeFile(sentinelPath, '{"sentinel":true}', "utf8");
      const before = await fs.readdir(dir);

      const fetchImpl = (async (input: any) => {
        const url = String(input);
        if (url.endsWith("/user/login")) {
          return new Response(JSON.stringify({ token: "tok" }), { status: 200 });
        }
        if (url.endsWith("/user/history")) {
          return new Response(JSON.stringify({ episodes: [] }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as typeof fetch;

      await setup(config(), {}, { env: { PATH: "" } });
      await setup(
        config({ POCKETCASTS_EMAIL: "a@b.c", POCKETCASTS_PASSWORD: "pw" }),
        { verify: true },
        { fetchImpl, env: { PATH: "" } },
      );

      const after = await fs.readdir(dir);
      expect(after.sort()).toEqual(before.sort());
      expect(await fs.readFile(sentinelPath, "utf8")).toBe('{"sentinel":true}');
    });
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

  it("does not create an export directory when CASTRECALL_EXPORT_DIR is unset", async () => {
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
    expect(result.export).toBeUndefined();
    const exportDir = path.join(dir, "export");
    await expect(fs.access(exportDir)).rejects.toThrow();
  });

  it("writes section pages + an index page under CASTRECALL_EXPORT_DIR on fresh transcript store", async () => {
    const exportDir = path.join(dir, "export");
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
        return new Response("WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nA short transcript body.", {
          status: 200,
          headers: { "content-type": "text/vtt" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = (await fetchTranscript(
      config({ CASTRECALL_EXPORT_DIR: exportDir }),
      { episodeUuid: "ep-1" },
      { fetchImpl },
    )) as Record<string, any>;
    expect(result.export.skipped).toBe(false);
    expect(result.export.exported).toBeGreaterThan(0);

    const episodeDir = path.join(exportDir, "podcasts", "example-show", "episode-one-25422834");
    const files = await fs.readdir(episodeDir);
    expect(files).toContain("index.md");

    // Already-stored branch on a second call: no new writes, export skipped.
    const second = (await fetchTranscript(
      config({ CASTRECALL_EXPORT_DIR: exportDir }),
      { episodeUuid: "ep-1" },
      { fetchImpl },
    )) as Record<string, any>;
    expect(second.status).toBe("already-stored");
    expect(second.export.skipped).toBe(true);
  });

  it("recomputes the content hash for a legacy provenance sidecar missing contentHash", async () => {
    const exportDir = path.join(dir, "export");
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
    const text = "Legacy transcript text stored before the content hash field existed.";
    const legacyProvenance = {
      platform: "pocketcasts",
      podcastTitle: "Example Show",
      episodeTitle: "Episode One",
      episodeUuid: "ep-1",
      transcriptSource: "rss",
      format: "txt",
      fetchedAt: "2026-07-04T00:00:00Z",
      privacyClass: "private-source",
    };
    const sourceDir = storage.sourceDir("ep-1");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "transcript.txt"), text, "utf8");
    await fs.writeFile(path.join(sourceDir, "provenance.json"), JSON.stringify(legacyProvenance), "utf8");

    const result = (await fetchTranscript(
      config({ CASTRECALL_EXPORT_DIR: exportDir }),
      { episodeUuid: "ep-1" },
    )) as Record<string, any>;
    expect(result.status).toBe("already-stored");
    expect(result.export.skipped).toBe(false);

    const indexPath = path.join(
      exportDir,
      "podcasts",
      "example-show",
      "episode-one-25422834",
      "index.md",
    );
    const indexContent = await fs.readFile(indexPath, "utf8");
    const expectedHash = createHash("sha256").update(text, "utf8").digest("hex");
    expect(indexContent).toContain(`content_hash: "${expectedHash}"`);
  });

  it("never exports review candidates or state files", async () => {
    const exportDir = path.join(dir, "export");
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
      text: "stored transcript text with enough words to review later, covering a durable idea in depth.",
      provenance: PROVENANCE,
    });
    await storage.updateEpisode("ep-1", { transcriptStatus: "stored" });

    await fetchTranscript(config({ CASTRECALL_EXPORT_DIR: exportDir }), { episodeUuid: "ep-1" });
    await generateReview(config({ CASTRECALL_EXPORT_DIR: exportDir }), { episodeUuid: "ep-1" });

    async function listFiles(root: string): Promise<string[]> {
      const out: string[] = [];
      async function walk(current: string) {
        const entries = await fs.readdir(current, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) await walk(full);
          else out.push(path.relative(root, full));
        }
      }
      await walk(root);
      return out;
    }

    const files = await listFiles(exportDir);
    for (const f of files) {
      expect(f).not.toBe("state.json");
      expect(f).not.toMatch(/(^|\/)review\//);
      const content = await fs.readFile(path.join(exportDir, f), "utf8");
      expect(content).not.toContain("status: pending-review");
    }
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
