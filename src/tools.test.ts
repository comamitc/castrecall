import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "./config.js";
import type { ExecImpl } from "./pocketcasts/secret-store.js";
import { clearPocketCastsSessionCache } from "./pocketcasts/session.js";
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
    clearPocketCastsSessionCache();
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
      { env: { PATH: "" } },
    )) as Record<string, any>;
    expect(status.pocketcasts.credentialsConfigured).toBe(true);
    expect(JSON.stringify(status)).not.toContain("secret@example.com");
    expect(JSON.stringify(status)).not.toContain("hunter2");
    expect(status.counts.syncedListens).toBe(0);
  });

  it("setup_status reports whisper.cpp WITHOUT a model as not ready, never as available", async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "castrecall-bin-"));
    try {
      await fs.writeFile(path.join(binDir, "whisper-cli"), "#!/bin/sh\n", { mode: 0o755 });
      // Detected on PATH, but no CASTRECALL_WHISPER_MODEL: the rung would
      // throw on first use, so status must say so up front.
      const status = (await setupStatus(config(), { env: { PATH: binDir } })) as Record<string, any>;
      expect(status.transcriptLadder.localWhisper).toContain("NOT ready");
      expect(status.transcriptLadder.localWhisper).toContain("CASTRECALL_WHISPER_MODEL");

      // With a model configured, the same detection reads as available.
      const ready = (await setupStatus(
        config({ CASTRECALL_WHISPER_MODEL: "/models/ggml-base.en.bin" }),
        { env: { PATH: binDir } },
      )) as Record<string, any>;
      expect(ready.transcriptLadder.localWhisper).toContain("free, private transcription");
    } finally {
      await fs.rm(binDir, { recursive: true, force: true });
    }
  });

  it("sync_history fails fast with an actionable error when credentials are missing", async () => {
    await expect(syncHistory(config(), {}, { env: { PATH: "" } })).rejects.toThrowError(
      /POCKETCASTS_EMAIL/,
    );
  });

  it("setup_status reports sync health and cooldown state without leaking secrets", async () => {
    const storage = new Storage(dir);
    await storage.init();
    await storage.recordSyncFailure(
      "Pocket Casts history request failed with HTTP 500.",
      () => new Date("2026-07-05T00:00:00Z"),
    );

    const status = (await setupStatus(config(), {
      now: () => new Date("2026-07-05T00:01:00Z"),
      env: { PATH: "" },
    })) as Record<string, any>;
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
        "providers.podchaser",
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

    it("verify:true never persists a durable session token to the keychain", async () => {
      const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "castrecall-keychain-bin-"));
      try {
        await fs.writeFile(path.join(binDir, "security"), "#!/bin/sh\n", { mode: 0o755 });
        const store = new Map<string, string>();
        const writes: string[] = [];
        const execImpl: ExecImpl = async (argv) => {
          const action = argv[1];
          const account = argv[argv.indexOf("-a") + 1];
          if (action === "find-generic-password") {
            const value = store.get(account);
            return value === undefined
              ? { code: 44, stdout: "", stderr: "not found" }
              : { code: 0, stdout: `${value}\n`, stderr: "" };
          }
          if (action === "add-generic-password") {
            writes.push(account);
            store.set(account, argv[argv.indexOf("-w") + 1]);
            return { code: 0, stdout: "", stderr: "" };
          }
          throw new Error(`unexpected argv: ${argv.join(" ")}`);
        };

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

        const result = (await setup(
          config({ POCKETCASTS_EMAIL: "a@b.c", POCKETCASTS_PASSWORD: "pw" }),
          { verify: true },
          { fetchImpl, execImpl, env: { PATH: binDir }, platform: "darwin" },
        )) as Record<string, any>;

        expect(result.verify).toEqual({ ok: true, sampleCount: 0 });
        expect(writes).toEqual([]);
      } finally {
        await fs.rm(binDir, { recursive: true, force: true });
      }
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
    const first = (await syncHistory(cfg, {}, { fetchImpl, env: { PATH: "" } })) as Record<string, any>;
    expect(first.newListens).toHaveLength(1);
    const second = (await syncHistory(cfg, {}, { fetchImpl, env: { PATH: "" } })) as Record<string, any>;
    expect(second.newListens).toHaveLength(0);
    expect(second.totalSeen).toBe(1);

    const recent = (await listRecent(cfg, {})) as Record<string, any>;
    expect(recent.episodes[0].episodeUuid).toBe("ep-1");
    expect(recent.episodes[0].transcriptStatus).toBe("none");
  });

  it("sync_history skips episodes that fail the listened threshold and reports fetched/eligible/skipped", async () => {
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
                uuid: "ep-completed",
                title: "Completed Episode",
                url: "https://cdn.example.com/completed.mp3",
                podcastUuid: "pod-1",
                podcastTitle: "Example Show",
                playingStatus: 3,
              },
              {
                uuid: "ep-low-ratio",
                title: "Barely Started Episode",
                url: "https://cdn.example.com/low-ratio.mp3",
                podcastUuid: "pod-1",
                podcastTitle: "Example Show",
                duration: 3600,
                playedUpTo: 60,
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const cfg = config({ POCKETCASTS_EMAIL: "a@b.c", POCKETCASTS_PASSWORD: "pw" });
    const result = (await syncHistory(cfg, {}, { fetchImpl, env: { PATH: "" } })) as Record<
      string,
      any
    >;
    expect(result.fetched).toBe(2);
    expect(result.eligible).toBe(1);
    expect(result.skippedAsNotListened).toBe(1);
    expect(result.eligible + result.skippedAsNotListened).toBe(result.fetched);
    expect(result.newListens).toHaveLength(1);
    expect(result.newListens[0].episodeUuid).toBe("ep-completed");

    const recent = (await listRecent(cfg, {})) as Record<string, any>;
    const uuids = recent.episodes.map((e: Record<string, any>) => e.episodeUuid);
    expect(uuids).toContain("ep-completed");
    expect(uuids).not.toContain("ep-low-ratio");

    // Idempotent re-sync: same history yields no new listens and stable stats.
    const second = (await syncHistory(cfg, {}, { fetchImpl, env: { PATH: "" } })) as Record<
      string,
      any
    >;
    expect(second.fetched).toBe(2);
    expect(second.eligible).toBe(1);
    expect(second.skippedAsNotListened).toBe(1);
    expect(second.newListens).toHaveLength(0);
    expect(second.totalSeen).toBe(1);
  });

  describe("credential handling", () => {
    let binDir: string;

    beforeEach(async () => {
      binDir = await fs.mkdtemp(path.join(os.tmpdir(), "castrecall-keychain-bin-"));
      await fs.writeFile(path.join(binDir, "security"), "#!/bin/sh\n", { mode: 0o755 });
    });

    afterEach(async () => {
      await fs.rm(binDir, { recursive: true, force: true });
    });

    function keychainExec(initial: Record<string, string> = {}): {
      execImpl: ExecImpl;
      calls: string[][];
    } {
      const store = new Map(Object.entries(initial));
      const calls: string[][] = [];
      const execImpl: ExecImpl = async (argv) => {
        calls.push(argv);
        const action = argv[1];
        const account = argv[argv.indexOf("-a") + 1];
        if (action === "find-generic-password") {
          const value = store.get(account);
          return value === undefined
            ? { code: 44, stdout: "", stderr: "not found" }
            : { code: 0, stdout: `${value}\n`, stderr: "" };
        }
        if (action === "add-generic-password") {
          store.set(account, argv[argv.indexOf("-w") + 1]);
          return { code: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected argv: ${argv.join(" ")}`);
      };
      return { execImpl, calls };
    }

    function loginFetch() {
      const counts = { login: 0, history: 0 };
      const fetchImpl = (async (input: any) => {
        const url = String(input);
        if (url.endsWith("/user/login")) {
          counts.login += 1;
          return new Response(JSON.stringify({ token: `tok-${counts.login}` }), { status: 200 });
        }
        if (url.endsWith("/user/history")) {
          counts.history += 1;
          return new Response(JSON.stringify({ episodes: [] }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as typeof fetch;
      return { fetchImpl, counts };
    }

    it("with no backend, sync_history authenticates from env vars and calls execImpl zero times", async () => {
      const calls: unknown[] = [];
      const execImpl: ExecImpl = async (argv) => {
        calls.push(argv);
        throw new Error("execImpl should never be called with no backend detected");
      };
      const cfg = config({ POCKETCASTS_EMAIL: "a@b.c", POCKETCASTS_PASSWORD: "pw" });
      const { fetchImpl, counts } = loginFetch();
      const result = (await syncHistory(cfg, {}, { fetchImpl, execImpl, env: { PATH: "" } })) as Record<
        string,
        any
      >;
      expect(result.fetched).toBe(0);
      expect(counts.login).toBe(1);
      expect(calls).toHaveLength(0);
    });

    it("sync_history authenticates from keychain-stored credentials and reuses the token on a second call", async () => {
      const { execImpl, calls } = keychainExec({
        "pocketcasts-email": "keychain@example.com",
        "pocketcasts-password": "kpw",
      });
      // Env vars are also set, proving the keychain wins over them.
      const cfg = config({ POCKETCASTS_EMAIL: "env@example.com", POCKETCASTS_PASSWORD: "envpw" });
      const { fetchImpl, counts } = loginFetch();
      const deps = { fetchImpl, execImpl, env: { PATH: binDir }, platform: "darwin" as const };

      await syncHistory(cfg, {}, deps);
      await syncHistory(cfg, {}, deps);

      expect(counts.login).toBe(1); // second call reused the cached token
      const writeCall = calls.find((c) => c[1] === "add-generic-password");
      expect(writeCall?.slice(0, 7)).toEqual([
        path.join(binDir, "security"),
        "add-generic-password",
        "-U",
        "-s",
        "castrecall",
        "-a",
        "pocketcasts-token",
      ]);
    });

    it("setup_status surfaces credentialSource and secretBackend/tokenCache without leaking any secret values", async () => {
      const { execImpl } = keychainExec({
        "pocketcasts-email": "keychain@example.com",
        "pocketcasts-password": "kpw",
      });
      const status = (await setupStatus(config(), {
        execImpl,
        env: { PATH: binDir },
        platform: "darwin",
      })) as Record<string, any>;

      expect(status.pocketcasts.credentialSource).toBe("keychain");
      expect(status.pocketcasts.credentialsConfigured).toBe(true);
      expect(status.secretBackend).toEqual({ available: true, kind: "macos-keychain", disabled: false });
      expect(status.tokenCache).toEqual({ cached: false });
      const serialized = JSON.stringify(status);
      expect(serialized).not.toContain("keychain@example.com");
      expect(serialized).not.toContain("kpw");
    });
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
    expect(rungs.podchaser.outcome).toBe("skipped");
    expect(rungs.podchaser.detail).toContain("PODCHASER_API_KEY");
    expect(result.ladder.findIndex((r: any) => r.rung === "podchaser")).toBeGreaterThan(
      result.ladder.findIndex((r: any) => r.rung === "taddy"),
    );
    expect(result.ladder.findIndex((r: any) => r.rung === "podchaser")).toBeLessThan(
      result.ladder.findIndex((r: any) => r.rung === "local-whisper"),
    );
    expect(rungs["local-whisper"].outcome).toBe("skipped");
    expect(rungs["local-whisper"].detail).toContain("No local Whisper CLI detected");
    expect(rungs.stt.outcome).toBe("skipped");
    expect(rungs.stt.detail).toContain("CASTRECALL_ENABLE_STT");
  });

  it("fetch_transcript hits the podchaser rung when configured and RSS/Taddy miss", async () => {
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
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.podchaser.com/graphql") {
        return new Response(
          JSON.stringify({
            data: {
              episodes: {
                data: [
                  {
                    title: "Episode One",
                    transcripts: [
                      { url: "https://transcripts.example.com/ep1.json", transcriptType: "raw_JSON" },
                    ],
                    podcast: { title: "Example Show", rssUrl: null },
                  },
                ],
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url === "https://transcripts.example.com/ep1.json") {
        return new Response(JSON.stringify([{ utterance: "hello from podchaser" }]), { status: 200 });
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    const result = (await fetchTranscript(
      config({ PODCHASER_API_KEY: "pk_x" }),
      { episodeUuid: "ep-1" },
      { fetchImpl, env: { PATH: "" } },
    )) as any;
    expect(result.status).toBe("stored");
    expect(result.source).toBe("podchaser");
    const rungs = Object.fromEntries(result.ladder.map((r: any) => [r.rung, r]));
    expect(rungs.podchaser.outcome).toBe("hit");
    expect(rungs["local-whisper"]).toBeUndefined();
    expect(rungs.stt).toBeUndefined();
  });

  it("fetch_transcript bounds transient STT retries: capped backoff, then a terminal failure after the budget", async () => {
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
    // RSS/feed lookups miss; Deepgram persistently returns a transient 502.
    const fetchImpl = (async (input: any) => {
      const url = String(input);
      if (url.startsWith("https://api.deepgram.com/")) {
        return new Response("bad gateway", { status: 502 });
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    const sttConfig = config({
      CASTRECALL_ENABLE_STT: "true",
      CASTRECALL_STT_PROVIDER: "deepgram",
      DEEPGRAM_API_KEY: "dg-key",
    });
    let clock = Date.parse("2026-01-01T00:00:00Z");
    const deps = { fetchImpl, env: { PATH: "" }, now: () => new Date(clock) };

    const first = (await fetchTranscript(sttConfig, { episodeUuid: "ep-1" }, deps)) as any;
    expect(first.status).toBe("no-transcript");
    expect(first.retry).toEqual({
      attempt: 1,
      maxAttempts: 5,
      nextEligibleAt: "2026-01-01T00:05:00.000Z",
    });
    const afterFirst = await new Storage(dir).loadState();
    expect(afterFirst.episodes["ep-1"].transcriptStatus).toBe("none");
    expect(afterFirst.episodes["ep-1"].transcriptRetry?.consecutiveFailures).toBe(1);

    for (let attempt = 2; attempt <= 4; attempt += 1) {
      clock += 60 * 60_000;
      const result = (await fetchTranscript(sttConfig, { episodeUuid: "ep-1" }, deps)) as any;
      expect(result.retry.attempt).toBe(attempt);
    }

    // Backoff doubles per failure: 5 → 10 → 20 → 40 minutes.
    const afterFourth = await new Storage(dir).loadState();
    const nextEligible = Date.parse(afterFourth.episodes["ep-1"].transcriptRetry!.nextEligibleAt);
    expect(nextEligible - clock).toBe(40 * 60_000);

    // The fifth consecutive transient failure exhausts the budget: terminal
    // "failed", retry bookkeeping cleared, scheduled runs stop re-billing.
    clock += 60 * 60_000;
    const last = (await fetchTranscript(sttConfig, { episodeUuid: "ep-1" }, deps)) as any;
    expect(last.status).toBe("no-transcript");
    expect(last.retry).toBeUndefined();
    const finalState = await new Storage(dir).loadState();
    expect(finalState.episodes["ep-1"].transcriptStatus).toBe("failed");
    expect(finalState.episodes["ep-1"].transcriptError).toContain("gave up after 5");
    expect(finalState.episodes["ep-1"].transcriptRetry).toBeUndefined();
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
