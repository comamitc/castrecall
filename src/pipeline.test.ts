import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "./config.js";
import { runPipeline } from "./pipeline.js";
import { clearPocketCastsSessionCache } from "./pocketcasts/session.js";
import { setupStatus } from "./tools.js";
import { LOCK_TTL_MS, Storage, TRANSCRIPT_RECHECK_BASE_MS } from "./storage.js";
import { CORPUS_SCALE_MIN_EPISODES } from "./transcripts/preflight.js";

const HISTORY_EPISODE = {
  uuid: "ep-1",
  title: "Episode One",
  url: "https://cdn.example.com/ep1.mp3",
  podcastUuid: "pod-1",
  podcastTitle: "Example Show",
  playingStatus: 3,
};

const FEED_XML = `<?xml version="1.0"?>
  <rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0">
    <channel>
      <item>
        <title>Episode One</title>
        <guid>ep-1</guid>
        <enclosure url="https://cdn.example.com/ep1.mp3" />
        <podcast:transcript url="https://cdn.example.com/ep1.vtt" type="text/vtt" />
      </item>
    </channel>
  </rss>`;

const VTT = "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nA short transcript body for review generation.";

/** A counting fetch stub covering login, history, feed resolution, feed XML, and transcript VTT. */
function makeFetchImpl(
  opts: { historyThrows?: boolean; historyInvalidJson?: boolean; episodes?: unknown[] } = {},
) {
  const calls: string[] = [];
  const fetchImpl = (async (input: any) => {
    const url = String(input);
    if (url.endsWith("/user/login")) {
      calls.push("login");
      return new Response(JSON.stringify({ token: "tok" }), { status: 200 });
    }
    if (url.endsWith("/user/history")) {
      calls.push("history");
      if (opts.historyThrows) {
        return new Response("boom", { status: 500 });
      }
      if (opts.historyInvalidJson) {
        return new Response("not json", { status: 200 });
      }
      return new Response(JSON.stringify({ episodes: opts.episodes ?? [HISTORY_EPISODE] }), {
        status: 200,
      });
    }
    if (url.includes("export_feed_urls")) {
      calls.push("feed-lookup");
      return new Response(JSON.stringify({ result: { "pod-1": "https://example.com/feed.xml" } }), {
        status: 200,
      });
    }
    if (url === "https://example.com/feed.xml") {
      calls.push("feed-xml");
      return new Response(FEED_XML, { status: 200 });
    }
    if (url === "https://cdn.example.com/ep1.vtt") {
      calls.push("vtt");
      return new Response(VTT, { status: 200, headers: { "content-type": "text/vtt" } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("runPipeline", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "castrecall-pipeline-"));
    clearPocketCastsSessionCache();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function config(env: NodeJS.ProcessEnv = {}) {
    return resolveConfig(
      {},
      { CASTRECALL_DATA_DIR: dir, POCKETCASTS_EMAIL: "a@b.c", POCKETCASTS_PASSWORD: "pw", ...env },
    );
  }

  it("chains sync → transcript → review → export with no human input", async () => {
    const exportDir = path.join(dir, "export");
    const { fetchImpl } = makeFetchImpl();
    const result = (await runPipeline(
      config({ CASTRECALL_EXPORT_DIR: exportDir }),
      {},
      { fetchImpl, env: { PATH: "" } },
    )) as Record<string, any>;

    expect(result.newListens).toBe(1);
    expect(result.transcripts).toEqual({ stored: 1, failed: 0 });
    expect(result.reviews).toEqual({ generated: 1, skipped: 0 });

    const state = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
    expect(state.episodes["ep-1"].transcriptStatus).toBe("stored");
    await expect(
      fs.access(path.join(dir, "sources", "ep-1", "transcript.txt")),
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(dir, "review", "pending", "ep-1.md"))).resolves.toBeUndefined();
    const episodeExportDir = path.join(exportDir, "podcasts", "example-show", "episode-one-25422834");
    const files = await fs.readdir(episodeExportDir);
    expect(files).toContain("index.md");
  });

  it("is a cheap no-op on a second run with nothing new", async () => {
    const { fetchImpl, calls } = makeFetchImpl();
    await runPipeline(config(), {}, { fetchImpl, env: { PATH: "" } });
    calls.length = 0;

    const second = (await runPipeline(config(), {}, { fetchImpl, env: { PATH: "" } })) as Record<string, any>;
    expect(second.newListens).toBe(0);
    expect(second.transcripts).toEqual({ stored: 0, failed: 0 });
    expect(second.reviews).toEqual({ generated: 0, skipped: 0 });
    // No feed/transcript work should have happened for the already-seen episode, and the
    // second run reuses the cached session token instead of logging in again.
    expect(calls).toEqual(["history"]);
  });

  it("keeps overlapping runs safe: exactly one reaches login/history, the other is a locked no-op", async () => {
    const { fetchImpl, calls } = makeFetchImpl();
    const [a, b] = await Promise.all([
      runPipeline(config(), {}, { fetchImpl, env: { PATH: "" } }),
      runPipeline(config(), {}, { fetchImpl, env: { PATH: "" } }),
    ]);
    const results = [a, b] as Record<string, any>[];
    const locked = results.filter((r) => r.skipped === "locked");
    const ran = results.filter((r) => r.skipped !== "locked");
    expect(locked).toHaveLength(1);
    expect(ran).toHaveLength(1);
    expect(ran[0].newListens).toBe(1);

    expect(calls.filter((c) => c === "login")).toHaveLength(1);
    expect(calls.filter((c) => c === "history")).toHaveLength(1);

    const state = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
    expect(Object.keys(state.episodes)).toEqual(["ep-1"]);
    const reviews = await fs.readdir(path.join(dir, "review", "pending"));
    expect(reviews).toEqual(["ep-1.md"]);
  });

  it("records an actionable failure and resolves (never throws) on a Pocket Casts API error", async () => {
    const { fetchImpl } = makeFetchImpl({ historyThrows: true });
    const result = (await runPipeline(config(), {}, { fetchImpl, env: { PATH: "" } })) as Record<string, any>;
    expect(result.ok).toBe(false);
    expect(result.stage).toBe("sync");
    expect(result.reason).toContain("HTTP 500");

    const state = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
    expect(state.sync.consecutiveFailures).toBe(1);
    expect(state.sync.lastError).toContain("HTTP 500");
    expect(new Date(state.sync.nextEligibleAt).getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it("records an actionable failure and enters cooldown on an unparseable Pocket Casts response", async () => {
    const { fetchImpl } = makeFetchImpl({ historyInvalidJson: true });
    const result = (await runPipeline(config(), {}, { fetchImpl, env: { PATH: "" } })) as Record<string, any>;
    expect(result.ok).toBe(false);
    expect(result.stage).toBe("sync");
    expect(result.reason).toContain("unparseable");

    const state = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
    expect(state.sync.consecutiveFailures).toBe(1);
    expect(state.sync.nextEligibleAt).toBeDefined();
  });

  it("records an actionable failure when Pocket Casts credentials are missing", async () => {
    const result = (await runPipeline(
      config({ POCKETCASTS_EMAIL: "", POCKETCASTS_PASSWORD: "" }),
      {},
      { env: { PATH: "" } },
    )) as Record<string, any>;
    expect(result.ok).toBe(false);
    expect(result.stage).toBe("sync");
    expect(result.reason).toContain("POCKETCASTS_EMAIL");

    const state = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
    expect(state.sync.consecutiveFailures).toBe(1);
  });

  it("stays quiet during cooldown (zero Pocket Casts calls) and only retries with force: true", async () => {
    const storage = new Storage(dir);
    await storage.init();
    const future = new Date(Date.now() + 60_000);
    const state = await storage.loadState();
    state.sync = { consecutiveFailures: 1, lastError: "boom", nextEligibleAt: future.toISOString() };
    await storage.saveState(state);

    const { fetchImpl, calls } = makeFetchImpl();
    const cooled = (await runPipeline(config(), {}, { fetchImpl, env: { PATH: "" } })) as Record<string, any>;
    expect(cooled.skipped).toBe("cooldown");
    expect(calls).toHaveLength(0);

    const forced = (await runPipeline(config(), { force: true }, { fetchImpl, env: { PATH: "" } })) as Record<string, any>;
    expect(forced.newListens).toBe(1);
    expect(calls.length).toBeGreaterThan(0);
  });

  it("resets consecutiveFailures on a successful sync even if the new episode's transcript fails", async () => {
    const storage = new Storage(dir);
    await storage.init();
    // Pre-seed an already-elapsed cooldown from an earlier failure so this run isn't gated by it.
    const seeded = await storage.loadState();
    seeded.sync = {
      consecutiveFailures: 2,
      lastError: "earlier failure",
      lastErrorAt: new Date(Date.now() - 60_000).toISOString(),
      nextEligibleAt: new Date(Date.now() - 1_000).toISOString(),
    };
    await storage.saveState(seeded);

    // Every non-history call 404s, so the transcript ladder exhausts and the episode ends failed.
    const fetchImpl = (async (input: any) => {
      const url = String(input);
      if (url.endsWith("/user/login")) return new Response(JSON.stringify({ token: "tok" }), { status: 200 });
      if (url.endsWith("/user/history")) {
        return new Response(JSON.stringify({ episodes: [HISTORY_EPISODE] }), { status: 200 });
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;

    const result = (await runPipeline(config(), {}, { fetchImpl, env: { PATH: "" } })) as Record<
      string,
      any
    >;
    expect(result.transcripts).toEqual({ stored: 0, failed: 1 });

    const state = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
    expect(state.sync.consecutiveFailures).toBe(0);
    expect(state.sync.nextEligibleAt).toBeUndefined();
    expect(state.episodes["ep-1"].transcriptStatus).toBe("failed");
  });

  it("backs off a transient Deepgram failure (defers until eligible, no re-billing), then resumes it", async () => {
    const storage = new Storage(dir);
    await storage.init();

    // Every rung ahead of stt misses (no RSS transcript, taddy/whisper unconfigured), and Deepgram
    // returns a transient 429 rather than succeeding or rejecting the key.
    let deepgramCalls = 0;
    const fetchImpl = (async (input: any) => {
      const url = String(input);
      if (url.endsWith("/user/login")) return new Response(JSON.stringify({ token: "tok" }), { status: 200 });
      if (url.endsWith("/user/history")) {
        return new Response(JSON.stringify({ episodes: [HISTORY_EPISODE] }), { status: 200 });
      }
      if (url.startsWith("https://api.deepgram.com/")) {
        deepgramCalls += 1;
        return new Response("too many requests", { status: 429 });
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;

    const sttConfig = config({
      CASTRECALL_ENABLE_STT: "true",
      CASTRECALL_STT_PROVIDER: "deepgram",
      DEEPGRAM_API_KEY: "dg-key",
    });

    let clock = Date.parse("2026-01-01T00:00:00Z");
    const now = () => new Date(clock);

    const result = (await runPipeline(sttConfig, {}, { fetchImpl, env: { PATH: "" }, now })) as Record<
      string,
      any
    >;
    expect(result.transcripts).toEqual({ stored: 0, failed: 1 });
    expect(deepgramCalls).toBe(1);

    const stateAfterFailure = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
    expect(stateAfterFailure.episodes["ep-1"].transcriptStatus).toBe("none");
    expect(stateAfterFailure.episodes["ep-1"].transcriptError).toContain("429");
    expect(stateAfterFailure.episodes["ep-1"].transcriptRetry).toEqual({
      consecutiveFailures: 1,
      nextEligibleAt: "2026-01-01T00:05:00.000Z",
    });

    // A scheduled tick BEFORE nextEligibleAt must defer the episode: retrying a
    // paid STT call on every tick would re-bill the provider on each run.
    clock += 60_000;
    const deferredResult = (await runPipeline(sttConfig, {}, { fetchImpl, env: { PATH: "" }, now })) as Record<
      string,
      any
    >;
    expect(deferredResult.transcripts).toEqual({ stored: 0, failed: 0, deferred: 1 });
    expect(deepgramCalls).toBe(1);

    // Once past nextEligibleAt (and Deepgram recovered), the episode is picked
    // back up because it was never marked terminally failed.
    const recoveredFetchImpl = (async (input: any) => {
      const url = String(input);
      if (url.endsWith("/user/login")) return new Response(JSON.stringify({ token: "tok" }), { status: 200 });
      if (url.endsWith("/user/history")) {
        return new Response(JSON.stringify({ episodes: [HISTORY_EPISODE] }), { status: 200 });
      }
      if (url.startsWith("https://api.deepgram.com/")) {
        return new Response(
          JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: "recovered" }] }] } }),
          { status: 200 },
        );
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;

    clock += 5 * 60_000;
    const secondResult = (await runPipeline(
      sttConfig,
      {},
      { fetchImpl: recoveredFetchImpl, env: { PATH: "" }, now },
    )) as Record<string, any>;
    expect(secondResult.transcripts).toEqual({ stored: 1, failed: 0 });

    const stateAfterRecovery = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
    expect(stateAfterRecovery.episodes["ep-1"].transcriptStatus).toBe("stored");
    expect(stateAfterRecovery.episodes["ep-1"].transcriptRetry).toBeUndefined();
  });

  it("defers a Taddy-pending transcript until eligible (zero ladder attempts while deferred), then resumes it", async () => {
    const storage = new Storage(dir);
    await storage.init();

    const taddyConfig = config({ TADDY_API_KEY: "key", TADDY_USER_ID: "user" });
    let clock = Date.parse("2026-01-01T00:00:00Z");
    const now = () => new Date(clock);

    const pendingFetchImpl = (async (input: any) => {
      const url = String(input);
      if (url.endsWith("/user/login")) return new Response(JSON.stringify({ token: "tok" }), { status: 200 });
      if (url.endsWith("/user/history")) {
        return new Response(JSON.stringify({ episodes: [HISTORY_EPISODE] }), { status: 200 });
      }
      if (url === "https://api.taddy.org") {
        return new Response(
          JSON.stringify({
            data: {
              getPodcastEpisode: { uuid: "ep-1", transcript: null, taddyTranscribeStatus: "PROCESSING" },
            },
          }),
          { status: 200 },
        );
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;

    const first = (await runPipeline(taddyConfig, {}, { fetchImpl: pendingFetchImpl, env: { PATH: "" }, now })) as Record<
      string,
      any
    >;
    expect(first.transcripts).toEqual({ stored: 0, failed: 1 });

    const stateAfterFirst = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
    expect(stateAfterFirst.episodes["ep-1"].transcriptStatus).toBe("none");
    expect(stateAfterFirst.episodes["ep-1"].transcriptRecheck.attempts).toBe(1);

    // A tick before the recheck gate elapses must defer — zero further ladder attempts.
    clock += 60_000;
    const deferred = (await runPipeline(taddyConfig, {}, { fetchImpl: pendingFetchImpl, env: { PATH: "" }, now })) as Record<
      string,
      any
    >;
    expect(deferred.transcripts).toEqual({ stored: 0, failed: 0, deferred: 1 });

    // Past the gate, with the transcript now available, the episode is picked back up.
    clock += TRANSCRIPT_RECHECK_BASE_MS;
    const hitFetchImpl = (async (input: any) => {
      const url = String(input);
      if (url.endsWith("/user/login")) return new Response(JSON.stringify({ token: "tok" }), { status: 200 });
      if (url.endsWith("/user/history")) {
        return new Response(JSON.stringify({ episodes: [HISTORY_EPISODE] }), { status: 200 });
      }
      if (url === "https://api.taddy.org") {
        return new Response(
          JSON.stringify({ data: { getPodcastEpisode: { uuid: "ep-1", transcript: "now available" } } }),
          { status: 200 },
        );
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    const recovered = (await runPipeline(taddyConfig, {}, { fetchImpl: hitFetchImpl, env: { PATH: "" }, now })) as Record<
      string,
      any
    >;
    expect(recovered.transcripts).toEqual({ stored: 1, failed: 0 });
    const stateAfterRecovery = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
    expect(stateAfterRecovery.episodes["ep-1"].transcriptStatus).toBe("stored");
    expect(stateAfterRecovery.episodes["ep-1"].transcriptRecheck).toBeUndefined();
  });

  it("defers an RSS 'no transcript links declared' episode across runs until the recheck horizon, then fails it terminally", async () => {
    const storage = new Storage(dir);
    await storage.init();

    let clock = Date.parse("2026-01-01T00:00:00Z");
    const now = () => new Date(clock);
    const NO_TRANSCRIPT_LINKS_FEED = `<?xml version="1.0"?>
      <rss version="2.0">
        <channel>
          <item>
            <title>Episode One</title>
            <guid>ep-1</guid>
            <enclosure url="https://cdn.example.com/ep1.mp3" />
          </item>
        </channel>
      </rss>`;
    const fetchImpl = (async (input: any) => {
      const url = String(input);
      if (url.endsWith("/user/login")) return new Response(JSON.stringify({ token: "tok" }), { status: 200 });
      if (url.endsWith("/user/history")) {
        return new Response(JSON.stringify({ episodes: [HISTORY_EPISODE] }), { status: 200 });
      }
      if (url.includes("export_feed_urls")) {
        return new Response(JSON.stringify({ result: { "pod-1": "https://example.com/feed.xml" } }), {
          status: 200,
        });
      }
      if (url === "https://example.com/feed.xml") {
        return new Response(NO_TRANSCRIPT_LINKS_FEED, { status: 200 });
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;

    const first = (await runPipeline(config(), {}, { fetchImpl, env: { PATH: "" }, now })) as Record<string, any>;
    expect(first.transcripts).toEqual({ stored: 0, failed: 1 });
    const stateAfterFirst = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
    // Stays "none" (not terminally failed) — the transcript link may simply not exist YET.
    expect(stateAfterFirst.episodes["ep-1"].transcriptStatus).toBe("none");
    expect(stateAfterFirst.episodes["ep-1"].transcriptRecheck).toBeDefined();

    // Fast-forward well past the recheck horizon with the feed still declaring no links.
    clock += 15 * 24 * 60 * 60_000;
    const last = (await runPipeline(config(), {}, { fetchImpl, env: { PATH: "" }, now })) as Record<string, any>;
    expect(last.transcripts).toEqual({ stored: 0, failed: 1 });
    const finalState = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
    expect(finalState.episodes["ep-1"].transcriptStatus).toBe("failed");
    expect(finalState.episodes["ep-1"].transcriptRecheck).toBeUndefined();
  });

  it("defers until the LATER of transcriptRetry and transcriptRecheck when both gates are set", async () => {
    const storage = new Storage(dir);
    await storage.init();
    await storage.recordListens([HISTORY_EPISODE]);
    await storage.updateEpisode(
      "ep-1",
      {
        transcriptRetry: { consecutiveFailures: 1, nextEligibleAt: "2026-01-01T00:05:00.000Z" },
        transcriptRecheck: {
          attempts: 1,
          nextEligibleAt: "2026-01-01T01:00:00.000Z",
          firstDeferredAt: "2026-01-01T00:00:00.000Z",
        },
      },
      () => new Date("2026-01-01T00:00:00.000Z"),
    );

    const { fetchImpl } = makeFetchImpl({ episodes: [] });

    // Past the earlier (transcriptRetry) gate but still before the later (transcriptRecheck) gate.
    const stillDeferred = (await runPipeline(config(), {}, {
      fetchImpl,
      env: { PATH: "" },
      now: () => new Date("2026-01-01T00:10:00.000Z"),
    })) as Record<string, any>;
    expect(stillDeferred.transcripts).toEqual({ stored: 0, failed: 0, deferred: 1 });

    // Past both gates: the episode is picked up.
    const resumed = (await runPipeline(config(), {}, {
      fetchImpl,
      env: { PATH: "" },
      now: () => new Date("2026-01-01T01:05:00.000Z"),
    })) as Record<string, any>;
    expect(resumed.transcripts.deferred).toBeUndefined();
  });

  it("picks up stored-but-unreviewed episodes from prior runs; skips those already reviewed", async () => {
    const storage = new Storage(dir);
    await storage.init();
    const longText = Array.from(
      { length: 6 },
      (_, i) =>
        `Paragraph ${i} of a pre-existing episode's conversation covering a substantial idea in enough detail to be a real review candidate.`,
    ).join("\n\n");
    await storage.recordListens([
      {
        uuid: "ep-existing",
        title: "Existing Episode",
        url: "https://cdn.example.com/existing.mp3",
        podcastUuid: "pod-1",
        podcastTitle: "Example Show",
      },
    ]);
    await storage.storeTranscript("ep-existing", {
      raw: longText,
      ext: "txt",
      text: longText,
      provenance: {
        platform: "pocketcasts",
        podcastTitle: "Example Show",
        podcastUuid: "pod-1",
        episodeTitle: "Existing Episode",
        episodeUuid: "ep-existing",
        transcriptSource: "rss",
        format: "txt",
        fetchedAt: "2026-07-01T00:00:00Z",
        privacyClass: "private-source",
      },
    });
    await storage.updateEpisode("ep-existing", { transcriptStatus: "stored" });
    // A second pre-existing episode that already went through review must NOT
    // get a duplicate: reviewGeneratedAt is the "done" marker.
    await storage.recordListens([
      {
        uuid: "ep-reviewed",
        title: "Already Reviewed",
        url: "https://cdn.example.com/reviewed.mp3",
        podcastUuid: "pod-1",
        podcastTitle: "Example Show",
      },
    ]);
    await storage.updateEpisode("ep-reviewed", {
      transcriptStatus: "stored",
      reviewGeneratedAt: "2026-07-01T00:00:00Z",
    });

    const { fetchImpl } = makeFetchImpl();
    const result = (await runPipeline(config(), {}, { fetchImpl, env: { PATH: "" } })) as Record<string, any>;
    // ep-1 (stored this run) AND ep-existing (stranded by a prior run) both
    // get reviews; ep-reviewed is not re-reviewed.
    expect(result.reviews.generated).toBe(2);

    const reviews = await fs.readdir(path.join(dir, "review", "pending"));
    expect(reviews.sort()).toEqual(["ep-1.md", "ep-existing.md"]);
  });

  it("persists review-stage failures to state so setup_status can expose them", async () => {
    const storage = new Storage(dir);
    await storage.init();
    await storage.recordListens([HISTORY_EPISODE]);
    // Stored transcript, no review yet — but a file squatting on the review
    // pending dir path makes generateReview's mkdir throw.
    const longText = "A ".repeat(200);
    await storage.storeTranscript("ep-1", {
      raw: longText,
      ext: "txt",
      text: longText,
      provenance: {
        platform: "pocketcasts",
        podcastTitle: "Example Show",
        podcastUuid: "pod-1",
        episodeTitle: "Episode One",
        episodeUuid: "ep-1",
        transcriptSource: "rss",
        format: "txt",
        fetchedAt: "2026-07-01T00:00:00Z",
        privacyClass: "private-source",
      },
    });
    await storage.updateEpisode("ep-1", { transcriptStatus: "stored" });
    // A write-protected pending dir makes the candidate write throw EACCES
    // inside generateReview — a real failure, unlike EEXIST (benign skip).
    const pendingDir = path.join(dir, "review", "pending");
    await fs.chmod(pendingDir, 0o500);

    try {
      const { fetchImpl } = makeFetchImpl({ episodes: [] });
      const result = (await runPipeline(config(), {}, { fetchImpl, env: { PATH: "" } })) as Record<string, any>;
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ stage: "review", episodeUuid: "ep-1" })]),
      );

      const state = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
      expect(state.episodes["ep-1"].reviewError).toBeTruthy();
      expect(state.episodes["ep-1"].reviewGeneratedAt).toBeUndefined();
    } finally {
      await fs.chmod(pendingDir, 0o755);
    }
  });

  it("resumes an episode stranded with transcriptStatus 'none' by a prior crashed run, even when this run's history has no new listens", async () => {
    const storage = new Storage(dir);
    await storage.init();
    // Simulate a prior run: syncHistory persisted the listen via recordListens, but the
    // process crashed before fetchTranscript/generateReview ran for it.
    await storage.recordListens([HISTORY_EPISODE]);

    const { fetchImpl } = makeFetchImpl({ episodes: [] });
    const result = (await runPipeline(config(), {}, { fetchImpl, env: { PATH: "" } })) as Record<string, any>;

    expect(result.newListens).toBe(0);
    expect(result.transcripts).toEqual({ stored: 1, failed: 0 });
    expect(result.reviews).toEqual({ generated: 1, skipped: 0 });

    const state = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
    expect(state.episodes["ep-1"].transcriptStatus).toBe("stored");
    const reviews = await fs.readdir(path.join(dir, "review", "pending"));
    expect(reviews).toEqual(["ep-1.md"]);
  });

  it("continues processing other pending episodes after one throws mid-run, and still resolves instead of rejecting", async () => {
    const storage = new Storage(dir);
    await storage.init();
    // Two episodes stranded with transcriptStatus "none", as if left behind by a prior
    // partial run. ep-2 has no matching feed entry, so its ladder ends cleanly at
    // no-transcript; ep-1 matches the feed and stores successfully.
    await storage.recordListens([
      HISTORY_EPISODE,
      {
        ...HISTORY_EPISODE,
        uuid: "ep-2",
        title: "Episode Two",
        podcastUuid: "pod-2",
        podcastTitle: "Other Show",
      },
    ]);

    // A regular file sitting where the export dir should be makes exportIfEnabled's mkdir
    // throw for ep-1 after its transcript is otherwise successfully stored — a real
    // misconfiguration, not the ladder's own handled "no-transcript" path.
    const exportDirAsFile = path.join(dir, "export-is-a-file");
    await fs.writeFile(exportDirAsFile, "not a directory", "utf8");

    const { fetchImpl } = makeFetchImpl({ episodes: [] });
    const result = (await runPipeline(
      config({ CASTRECALL_EXPORT_DIR: exportDirAsFile }),
      {},
      { fetchImpl, env: { PATH: "" } },
    )) as Record<string, any>;

    // ep-1's transcript stage SUCCEEDS (transcript stored); only its export
    // fails, is persisted as exportError, and is reported as an export-stage
    // error by the retry pass. ep-2 ends cleanly at no-transcript.
    expect(result.transcripts).toEqual({ stored: 1, failed: 1 });
    expect(result.exports).toEqual({ exported: 0 });
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ stage: "export", episodeUuid: "ep-1" })]),
    );
    expect(result.errors.some((e: any) => e.episodeUuid === "ep-2")).toBe(false);

    const state = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
    expect(state.episodes["ep-1"].transcriptStatus).toBe("stored");
    expect(state.episodes["ep-1"].exportError).toBeTruthy();
  });

  it("retries a stored episode's failed export on the next scheduled run and clears the error", async () => {
    const storage = new Storage(dir);
    await storage.init();
    await storage.recordListens([HISTORY_EPISODE]);

    // Run 1: export dir blocked by a file → transcript stored, export fails.
    const exportDir = path.join(dir, "export");
    await fs.writeFile(exportDir, "squatter", "utf8");
    const { fetchImpl } = makeFetchImpl();
    await runPipeline(config({ CASTRECALL_EXPORT_DIR: exportDir }), {}, { fetchImpl, env: { PATH: "" } });
    let state = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
    expect(state.episodes["ep-1"].exportError).toBeTruthy();

    // Run 2: obstruction removed → the retry pass exports and clears the error.
    await fs.rm(exportDir);
    const second = (await runPipeline(
      config({ CASTRECALL_EXPORT_DIR: exportDir }),
      {},
      { fetchImpl: makeFetchImpl({ episodes: [] }).fetchImpl, env: { PATH: "" } },
    )) as Record<string, any>;
    expect(second.exports.exported).toBe(1);
    state = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
    expect(state.episodes["ep-1"].exportError).toBeUndefined();
    expect(state.episodes["ep-1"].exportedAt).toBeTruthy();
    const pages = await fs.readdir(exportDir, { recursive: true });
    expect(pages.length).toBeGreaterThan(0);
  });

  it("records a repairable export error (never success) when stored inputs are missing on disk", async () => {
    const storage = new Storage(dir);
    await storage.init();
    await storage.recordListens([HISTORY_EPISODE]);
    // State says stored, but the sources dir is gone (corruption/manual deletion).
    await storage.updateEpisode("ep-1", { transcriptStatus: "stored" });

    const exportDir = path.join(dir, "export");
    const { fetchImpl } = makeFetchImpl({ episodes: [] });
    const result = (await runPipeline(
      config({ CASTRECALL_EXPORT_DIR: exportDir }),
      {},
      { fetchImpl, env: { PATH: "" } },
    )) as Record<string, any>;

    expect(result.exports.exported).toBe(0);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ stage: "export", episodeUuid: "ep-1" })]),
    );
    const state = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
    expect(state.episodes["ep-1"].exportError).toMatch(/missing/);
    expect(state.episodes["ep-1"].exportedAt).toBeUndefined();
  });

  it("re-exports after the export tree is lost or the export dir changes (self-healing)", async () => {
    const storage = new Storage(dir);
    await storage.init();
    await storage.recordListens([HISTORY_EPISODE]);

    const exportDir = path.join(dir, "export");
    const { fetchImpl } = makeFetchImpl();
    const first = (await runPipeline(
      config({ CASTRECALL_EXPORT_DIR: exportDir }),
      {},
      { fetchImpl, env: { PATH: "" } },
    )) as Record<string, any>;
    expect(first.transcripts.stored).toBe(1);

    // Losing the whole export tree must not strand the corpus: the export
    // pass runs the (hash-idempotent) exporter for every stored episode.
    await fs.rm(exportDir, { recursive: true, force: true });
    const second = (await runPipeline(config({ CASTRECALL_EXPORT_DIR: exportDir }), {}, {
      fetchImpl: makeFetchImpl({ episodes: [] }).fetchImpl,
      env: { PATH: "" },
    })) as Record<string, any>;
    expect(second.exports.exported).toBe(1);

    // A different export dir is populated the same way.
    const otherDir = path.join(dir, "export-elsewhere");
    const third = (await runPipeline(config({ CASTRECALL_EXPORT_DIR: otherDir }), {}, {
      fetchImpl: makeFetchImpl({ episodes: [] }).fetchImpl,
      env: { PATH: "" },
    })) as Record<string, any>;
    expect(third.exports.exported).toBe(1);

    // And an unchanged tree converges to the cheap no-op.
    const fourth = (await runPipeline(config({ CASTRECALL_EXPORT_DIR: otherDir }), {}, {
      fetchImpl: makeFetchImpl({ episodes: [] }).fetchImpl,
      env: { PATH: "" },
    })) as Record<string, any>;
    expect(fourth.exports.exported).toBe(0);
    expect(fourth.errors).toBeUndefined();
  });

  it("a clean tick with unchanged exports leaves state.json byte-identical (cheap no-op)", async () => {
    const storage = new Storage(dir);
    await storage.init();
    await storage.recordListens([HISTORY_EPISODE]);
    const exportDir = path.join(dir, "export");
    const { fetchImpl } = makeFetchImpl();
    await runPipeline(config({ CASTRECALL_EXPORT_DIR: exportDir }), {}, { fetchImpl, env: { PATH: "" } });

    const before = await fs.readFile(path.join(dir, "state.json"), "utf8");
    const second = (await runPipeline(config({ CASTRECALL_EXPORT_DIR: exportDir }), {}, {
      fetchImpl: makeFetchImpl({ episodes: [] }).fetchImpl,
      env: { PATH: "" },
    })) as Record<string, any>;
    expect(second.exports.exported).toBe(0);
    const after = await fs.readFile(path.join(dir, "state.json"), "utf8");
    // Only lastSyncAt may move; per-episode records must be untouched.
    expect(JSON.parse(after).episodes).toEqual(JSON.parse(before).episodes);
  });

  it("surfaces a stale lock without breaking it, and recovers only with breakStaleLock", async () => {
    const storage = new Storage(dir);
    await storage.init();
    // A hard-killed run's leftover lock (older than the TTL).
    const staleAcquiredAt = new Date(Date.now() - LOCK_TTL_MS - 60_000);
    const crashed = await storage.acquirePipelineLock(() => staleAcquiredAt);
    expect(crashed.acquired).toBe(true);

    const { fetchImpl, calls } = makeFetchImpl();
    const blocked = (await runPipeline(config(), {}, { fetchImpl, env: { PATH: "" } })) as Record<string, any>;
    expect(blocked.skipped).toBe("stale-lock");
    expect(blocked.staleLockAgeMs).toBeGreaterThan(LOCK_TTL_MS);
    expect(blocked.note).toContain("breakStaleLock");
    expect(calls.filter((c) => c === "login")).toHaveLength(0); // fail-closed: no Pocket Casts traffic

    const recovered = (await runPipeline(config(), { breakStaleLock: true }, { fetchImpl, env: { PATH: "" } })) as Record<
      string,
      any
    >;
    expect(recovered.skipped).toBeUndefined();
    expect(recovered.newListens).toBe(1);
  });

  it("an orphaned recovery mutex is surfaced as recovery-blocked, not a generic lock no-op", async () => {
    const storage = new Storage(dir);
    await storage.init();
    // Hard-killed recovery: mutex left behind, NO pipeline lock at all.
    await fs.mkdir(path.join(dir, ".staging"), { recursive: true });
    const mutexPath = path.join(dir, ".staging", "pipeline.lock.recovery");
    await fs.writeFile(mutexPath, new Date().toISOString(), "utf8");

    const { fetchImpl, calls } = makeFetchImpl();
    const result = (await runPipeline(config(), {}, { fetchImpl, env: { PATH: "" } })) as Record<string, any>;
    expect(result.skipped).toBe("recovery-blocked");
    expect(result.note).toContain("pipeline.lock.recovery");
    expect(calls.filter((c) => c === "login")).toHaveLength(0);

    // setup_status diagnoses it too, with the manual remediation.
    const status = (await setupStatus(config(), { env: { PATH: "" } })) as Record<string, any>;
    expect(status.pipelineLock.held).toBe(false);
    expect(status.pipelineLock.recoveryMutex.path).toBe(mutexPath);
    expect(status.pipelineLock.recoveryMutex.note).toContain("remove the file manually");

    // Removing the mutex restores normal scheduling.
    await fs.rm(mutexPath);
    const after = (await runPipeline(config(), {}, { fetchImpl, env: { PATH: "" } })) as Record<string, any>;
    expect(after.skipped).toBeUndefined();
  });

  it("reconciles a pending review file left by a crash so scheduled runs converge", async () => {
    const storage = new Storage(dir);
    await storage.init();
    await storage.recordListens([HISTORY_EPISODE]);
    const longText = "Substantial paragraph. ".repeat(30);
    await storage.storeTranscript("ep-1", {
      raw: longText,
      ext: "txt",
      text: longText,
      provenance: {
        platform: "pocketcasts",
        podcastTitle: "Example Show",
        podcastUuid: "pod-1",
        episodeTitle: "Episode One",
        episodeUuid: "ep-1",
        transcriptSource: "rss",
        format: "txt",
        fetchedAt: "2026-07-01T00:00:00Z",
        privacyClass: "private-source",
      },
    });
    await storage.updateEpisode("ep-1", { transcriptStatus: "stored" });
    // Simulate the crash: the review file was written but the state update
    // (reviewGeneratedAt) was lost.
    await storage.writeReviewCandidate("ep-1", "# Review from crashed run\n");

    const { fetchImpl } = makeFetchImpl({ episodes: [] });
    const first = (await runPipeline(config(), {}, { fetchImpl, env: { PATH: "" } })) as Record<string, any>;
    expect(first.reviews).toEqual({ generated: 0, skipped: 1 });

    const state = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
    expect(state.episodes["ep-1"].reviewGeneratedAt).toBeTruthy();

    // Converged: the next run has no review targets at all.
    const second = (await runPipeline(config(), {}, {
      fetchImpl: makeFetchImpl({ episodes: [] }).fetchImpl,
      env: { PATH: "" },
    })) as Record<string, any>;
    expect(second.reviews).toEqual({ generated: 0, skipped: 0 });
  });

  it("renews the run lock during a long stage so a concurrent scheduler tick cannot steal it as stale", async () => {
    // Fake only Date + the interval timers the heartbeat uses; leave setTimeout real so the
    // test can pause on genuine wall-clock ticks for real fs writes (lock acquire/renew) to
    // land before advancing the virtual clock past LOCK_TTL_MS.
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    try {
      const storage = new Storage(dir);
      await storage.init();

      let resolveHistory: () => void;
      const historyGate = new Promise<void>((resolve) => {
        resolveHistory = resolve;
      });
      const fetchImpl = (async (input: any) => {
        const url = String(input);
        if (url.endsWith("/user/login")) {
          return new Response(JSON.stringify({ token: "tok" }), { status: 200 });
        }
        if (url.endsWith("/user/history")) {
          // Simulate a stage that legitimately runs past LOCK_TTL_MS (e.g. local Whisper).
          await historyGate;
          return new Response(JSON.stringify({ episodes: [HISTORY_EPISODE] }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as typeof fetch;

      const runPromise = runPipeline(config(), {}, { fetchImpl, env: { PATH: "" } });

      // Let the real lock-acquire fs write land before advancing the virtual clock.
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Advance well past LOCK_TTL_MS while the run is still in flight; the heartbeat should
      // renew the lock at least once in that window.
      await vi.advanceTimersByTimeAsync(LOCK_TTL_MS + 60_000);

      // Let the heartbeat's real fs renewal writes land before checking the lock file.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const contender = await storage.acquirePipelineLock();
      expect(contender.acquired).toBe(false);

      resolveHistory!();
      const result = (await runPromise) as Record<string, any>;
      expect(result.newListens).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("corpus-scale transcription preflight gate (issue #55)", () => {
    let binDir: string;
    let markerPath: string;

    beforeEach(async () => {
      binDir = await fs.mkdtemp(path.join(os.tmpdir(), "castrecall-bin-"));
      markerPath = path.join(binDir, "invoked.marker");
      // Touches a marker only if actually invoked, proving via the real
      // (non-injectable) exec path whether the executable ran.
      await fs.writeFile(path.join(binDir, "mlx_whisper"), `#!/bin/sh\ntouch '${markerPath}'\n`, {
        mode: 0o755,
      });
    });

    afterEach(async () => {
      await fs.rm(binDir, { recursive: true, force: true });
    });

    async function seedPendingEpisodes(count: number) {
      const storage = new Storage(dir);
      await storage.init();
      await storage.recordListens(
        Array.from({ length: count }, (_, i) => ({
          uuid: `ep-${i}`,
          title: `Episode ${i}`,
          url: `https://cdn.example.com/ep${i}.mp3`,
          podcastUuid: "pod-1",
          podcastTitle: "Example Show",
        })),
      );
    }

    // Sync reports zero new listens (all episodes pre-seeded); RSS/Taddy/
    // Podchaser all miss (404), but audio downloads succeed, so a run that
    // reaches local-whisper actually invokes the executable rather than
    // failing earlier on the download.
    function fetchImplNoNewListensPlusAudio() {
      return (async (input: any) => {
        const url = String(input);
        if (url.endsWith("/user/login")) return new Response(JSON.stringify({ token: "tok" }), { status: 200 });
        if (url.endsWith("/user/history")) {
          return new Response(JSON.stringify({ episodes: [] }), { status: 200 });
        }
        if (/ep\d+\.mp3$/.test(url)) return new Response("fake audio bytes", { status: 200 });
        return new Response("nope", { status: 404 });
      }) as typeof fetch;
    }

    it("blocks corpus-scale low-quality local generation, reports preflight.blocked, and never invokes the executable", async () => {
      await seedPendingEpisodes(CORPUS_SCALE_MIN_EPISODES);
      const result = (await runPipeline(
        config({ CASTRECALL_LOCAL_WHISPER_PRESET: "fast" }),
        {},
        { fetchImpl: fetchImplNoNewListensPlusAudio(), env: { PATH: binDir } },
      )) as Record<string, any>;

      expect(result.preflight).toMatchObject({
        blocked: true,
        corpusScale: true,
        quality: "low-quality",
        ready: true,
        lowQualityOptIn: false,
      });
      expect(result.transcripts).toMatchObject({
        stored: 0,
        failed: 0,
        preflightDeferred: CORPUS_SCALE_MIN_EPISODES,
      });
      await expect(fs.access(markerPath)).rejects.toThrow();
    });

    it("does not advance retry/failure state when a run is preflight-blocked, so episodes are stored immediately once the operator opts in (issue #55 review)", async () => {
      await seedPendingEpisodes(CORPUS_SCALE_MIN_EPISODES);
      const blockedResult = (await runPipeline(
        config({ CASTRECALL_LOCAL_WHISPER_PRESET: "fast" }),
        {},
        { fetchImpl: fetchImplNoNewListensPlusAudio(), env: { PATH: binDir } },
      )) as Record<string, any>;
      expect(blockedResult.transcripts).toMatchObject({
        stored: 0,
        failed: 0,
        preflightDeferred: CORPUS_SCALE_MIN_EPISODES,
      });

      const stateAfterBlock = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
      for (let i = 0; i < CORPUS_SCALE_MIN_EPISODES; i++) {
        const episode = stateAfterBlock.episodes[`ep-${i}`];
        expect(episode.transcriptStatus).toBe("none");
        expect(episode.transcriptError).toBeUndefined();
        expect(episode.transcriptRetry).toBeUndefined();
        expect(episode.transcriptRecheck).toBeUndefined();
      }

      // No backoff was recorded, so every episode is immediately re-attempted
      // on the very next tick rather than deferred or permanently failed —
      // the same count is preflight-blocked again, none silently dropped.
      const secondBlockedResult = (await runPipeline(
        config({ CASTRECALL_LOCAL_WHISPER_PRESET: "fast" }),
        {},
        { fetchImpl: fetchImplNoNewListensPlusAudio(), env: { PATH: binDir } },
      )) as Record<string, any>;
      expect(secondBlockedResult.transcripts).toMatchObject({
        stored: 0,
        failed: 0,
        preflightDeferred: CORPUS_SCALE_MIN_EPISODES,
      });
      await expect(fs.access(markerPath)).rejects.toThrow();

      // Once the operator opts in, the executable is actually invoked for
      // every episode instead of the run being stuck deferred/failed.
      const recoveredResult = (await runPipeline(
        config({
          CASTRECALL_LOCAL_WHISPER_PRESET: "fast",
          CASTRECALL_WHISPER_ALLOW_LOW_QUALITY: "true",
        }),
        {},
        { fetchImpl: fetchImplNoNewListensPlusAudio(), env: { PATH: binDir } },
      )) as Record<string, any>;
      expect(recoveredResult.preflight).toMatchObject({ blocked: false, lowQualityOptIn: true });
      expect(recoveredResult.transcripts.preflightDeferred).toBeUndefined();
      await expect(fs.access(markerPath)).resolves.toBeUndefined();
    });

    it("does not block once CASTRECALL_WHISPER_ALLOW_LOW_QUALITY opts in, and the executable is invoked", async () => {
      await seedPendingEpisodes(CORPUS_SCALE_MIN_EPISODES);
      const result = (await runPipeline(
        config({
          CASTRECALL_LOCAL_WHISPER_PRESET: "fast",
          CASTRECALL_WHISPER_ALLOW_LOW_QUALITY: "true",
        }),
        {},
        { fetchImpl: fetchImplNoNewListensPlusAudio(), env: { PATH: binDir } },
      )) as Record<string, any>;

      expect(result.preflight).toMatchObject({ blocked: false, lowQualityOptIn: true });
      await expect(fs.access(markerPath)).resolves.toBeUndefined();
    });

    it("does not block below the corpus-scale threshold, and reports corpusScale: false", async () => {
      await seedPendingEpisodes(CORPUS_SCALE_MIN_EPISODES - 1);
      const result = (await runPipeline(
        config({ CASTRECALL_LOCAL_WHISPER_PRESET: "fast" }),
        {},
        { fetchImpl: fetchImplNoNewListensPlusAudio(), env: { PATH: binDir } },
      )) as Record<string, any>;

      expect(result.preflight).toMatchObject({ blocked: false, corpusScale: false });
      await expect(fs.access(markerPath)).resolves.toBeUndefined();
    });
  });
});
