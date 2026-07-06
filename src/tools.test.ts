import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "./config.js";
import type { ExecImpl } from "./pocketcasts/secret-store.js";
import { clearPocketCastsSessionCache } from "./pocketcasts/session.js";
import {
  Storage,
  TRANSCRIPT_RECHECK_BASE_MS,
  TRANSCRIPT_RECHECK_MAX_AGE_MS,
  TRANSCRIPT_RETRY_MAX_ATTEMPTS,
  type Provenance,
} from "./storage.js";
import { CORPUS_SCALE_MIN_EPISODES } from "./transcripts/preflight.js";
import { normalizeTranscript } from "./transcripts/normalize.js";
import {
  digest,
  fetchTranscript,
  generateReview,
  listRecent,
  resolveReview,
  search,
  setup,
  setupStatus,
  syncHistory,
  transcriptionPreflight,
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

  it("setup_status surfaces an ignored decode option in the localWhisper status line (issue #53)", async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "castrecall-bin-"));
    try {
      await fs.writeFile(path.join(binDir, "whisper-cli"), "#!/bin/sh\n", { mode: 0o755 });
      const status = (await setupStatus(
        config({
          CASTRECALL_WHISPER_MODEL: "/models/ggml-base.en.bin",
          CASTRECALL_WHISPER_HALLUCINATION_SILENCE_THRESHOLD: "2",
        }),
        { env: { PATH: binDir } },
      )) as Record<string, any>;
      expect(status.transcriptLadder.localWhisper).toContain("ignored decode options");
      expect(status.transcriptLadder.localWhisper).toContain("hallucinationSilenceThreshold");
    } finally {
      await fs.rm(binDir, { recursive: true, force: true });
    }
  });

  it("setup_status names the preset-resolved concrete model for mlx-whisper ready via a preset", async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "castrecall-bin-"));
    try {
      await fs.writeFile(path.join(binDir, "mlx_whisper"), "#!/bin/sh\n", { mode: 0o755 });
      const status = (await setupStatus(config({ CASTRECALL_LOCAL_WHISPER_PRESET: "best" }), {
        env: { PATH: binDir },
      })) as Record<string, any>;
      expect(status.transcriptLadder.localWhisper).toContain("mlx-community/whisper-large-v3-turbo");
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
        "providers.listenNotes",
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

  describe("fetch_transcript skipLocalWhisper (issue #55 corpus-scale preflight gating)", () => {
    let binDir: string;
    let markerPath: string;

    beforeEach(async () => {
      binDir = await fs.mkdtemp(path.join(os.tmpdir(), "castrecall-bin-"));
      markerPath = path.join(binDir, "invoked.marker");
      // Touches a marker only if actually invoked, so "never/does invoke the
      // executable" is proven via the real (non-injectable) exec path.
      await fs.writeFile(path.join(binDir, "mlx_whisper"), `#!/bin/sh\ntouch '${markerPath}'\n`, {
        mode: 0o755,
      });
    });

    afterEach(async () => {
      await fs.rm(binDir, { recursive: true, force: true });
    });

    async function seedReadyLowQualityEpisode() {
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
    }

    const missAll = (async () => new Response("nope", { status: 404 })) as typeof fetch;
    // RSS/Taddy/Podchaser all miss (404), but the audio download itself must
    // succeed, or transcribeWithLocalWhisper throws before ever invoking the
    // executable — that would prove nothing about the gate.
    const missAllButAudio = (async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("ep1.mp3")) return new Response("fake audio bytes", { status: 200 });
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    const lowQualityConfig = () => config({ CASTRECALL_LOCAL_WHISPER_PRESET: "fast" });

    it("skips the local-whisper rung and never invokes the executable when skipLocalWhisper is set", async () => {
      await seedReadyLowQualityEpisode();
      const result = (await fetchTranscript(
        lowQualityConfig(),
        { episodeUuid: "ep-1", skipLocalWhisper: true },
        { fetchImpl: missAll, env: { PATH: binDir } },
      )) as any;
      const rungs = Object.fromEntries(result.ladder.map((r: any) => [r.rung, r]));
      expect(rungs["local-whisper"].outcome).toBe("skipped");
      expect(rungs["local-whisper"].detail).toContain("Corpus-scale preflight blocked");
      await expect(fs.access(markerPath)).rejects.toThrow();
    });

    it("a direct single-episode call (skipLocalWhisper unset, as castrecall_fetch_transcript always calls it) still attempts local generation under the same low-quality config", async () => {
      await seedReadyLowQualityEpisode();
      await fetchTranscript(
        lowQualityConfig(),
        { episodeUuid: "ep-1" },
        { fetchImpl: missAllButAudio, env: { PATH: binDir } },
      );
      await expect(fs.access(markerPath)).resolves.toBeUndefined();
    });

    it("returns preflight-blocked (not no-transcript) and never advances retry/failure state when the preflight block is the only reason no transcript was produced (issue #55 review)", async () => {
      await seedReadyLowQualityEpisode();
      const result = (await fetchTranscript(
        lowQualityConfig(),
        { episodeUuid: "ep-1", scheduled: true, skipLocalWhisper: true },
        { fetchImpl: missAllButAudio, env: { PATH: binDir } },
      )) as any;

      expect(result.status).toBe("preflight-blocked");
      await expect(fs.access(markerPath)).rejects.toThrow();

      const state = await new Storage(dir).loadState();
      const episode = state.episodes["ep-1"];
      expect(episode.transcriptStatus).toBe("none");
      expect(episode.transcriptError).toBeUndefined();
      expect(episode.transcriptRetry).toBeUndefined();
      expect(episode.transcriptRecheck).toBeUndefined();
    });

    it("preflight block takes precedence over a recheckable rung: no recheck state advances while the gate is down (issue #55 review 2)", async () => {
      // Taddy is still transcribing (recheckable) AND the preflight gate
      // blocked local Whisper. Recording the recheck backoff here would
      // keep the episode deferred even after the operator fixes the
      // transcription config — the reversible policy gate must win.
      await seedReadyLowQualityEpisode();
      const taddyPending = (async (input: unknown) => {
        const url = String(input);
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
        if (url.endsWith("ep1.mp3")) return new Response("fake audio bytes", { status: 200 });
        return new Response("nope", { status: 404 });
      }) as typeof fetch;

      const result = (await fetchTranscript(
        config({
          CASTRECALL_LOCAL_WHISPER_PRESET: "fast",
          TADDY_API_KEY: "key",
          TADDY_USER_ID: "user",
        }),
        { episodeUuid: "ep-1", scheduled: true, skipLocalWhisper: true },
        { fetchImpl: taddyPending, env: { PATH: binDir } },
      )) as any;

      expect(result.status).toBe("preflight-blocked");
      const state = await new Storage(dir).loadState();
      const episode = state.episodes["ep-1"];
      expect(episode.transcriptStatus).toBe("none");
      expect(episode.transcriptRecheck).toBeUndefined();
      expect(episode.transcriptRetry).toBeUndefined();
      expect(episode.transcriptError).toBeUndefined();
    });
  });

  describe("transcriptionPreflight (issue #55)", () => {
    it("counts only episodes with transcriptStatus none, excluding already-stored ones", async () => {
      const storage = new Storage(dir);
      await storage.init();
      await storage.recordListens([
        { uuid: "ep-1", title: "One", url: "https://cdn.example.com/ep1.mp3", podcastUuid: "pod-1", podcastTitle: "Show" },
        { uuid: "ep-2", title: "Two", url: "https://cdn.example.com/ep2.mp3", podcastUuid: "pod-1", podcastTitle: "Show" },
      ]);
      await storage.updateEpisode("ep-1", { transcriptStatus: "stored" });

      const result = await transcriptionPreflight(config(), { env: { PATH: "" } });
      expect(result.episodesPendingTranscript).toBe(1);
      expect(result.corpusScale).toBe(false);
    });

    it("reports corpusScale true once pending episodes reach CORPUS_SCALE_MIN_EPISODES", async () => {
      const storage = new Storage(dir);
      await storage.init();
      await storage.recordListens(
        Array.from({ length: CORPUS_SCALE_MIN_EPISODES }, (_, i) => ({
          uuid: `ep-${i}`,
          title: `Episode ${i}`,
          url: `https://cdn.example.com/ep${i}.mp3`,
          podcastUuid: "pod-1",
          podcastTitle: "Show",
        })),
      );

      const result = await transcriptionPreflight(config(), { env: { PATH: "" } });
      expect(result.episodesPendingTranscript).toBe(CORPUS_SCALE_MIN_EPISODES);
      expect(result.corpusScale).toBe(true);
      expect(result.backend).toBeNull();
    });

    it("never mutates state — storage is byte-for-byte identical before and after", async () => {
      const storage = new Storage(dir);
      await storage.init();
      await storage.recordListens([
        { uuid: "ep-1", title: "One", url: "https://cdn.example.com/ep1.mp3", podcastUuid: "pod-1", podcastTitle: "Show" },
      ]);
      const statePath = path.join(dir, "state.json");
      const before = await fs.readFile(statePath, "utf8");
      const filesBefore = await fs.readdir(dir, { recursive: true } as any);

      await transcriptionPreflight(config({ CASTRECALL_LOCAL_WHISPER_PRESET: "fast" }), {
        env: { PATH: "" },
      });

      const after = await fs.readFile(statePath, "utf8");
      const filesAfter = await fs.readdir(dir, { recursive: true } as any);
      expect(after).toBe(before);
      expect(filesAfter.sort()).toEqual(filesBefore.sort());
    });
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

  it("fetch_transcript polls a Taddy-pending transcript on a backoff, then stores it once available", async () => {
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
    const taddyConfig = config({ TADDY_API_KEY: "key", TADDY_USER_ID: "user" });
    let clock = Date.parse("2026-01-01T00:00:00Z");
    const deps = { env: { PATH: "" }, now: () => new Date(clock) };

    const pendingFetchImpl = (async (input: any) => {
      const url = String(input);
      if (url === "https://api.taddy.org") {
        return new Response(
          JSON.stringify({
            data: {
              getPodcastEpisode: { uuid: "ep-1", transcript: null, taddyTranscribeStatus: "TRANSCRIBING" },
            },
          }),
          { status: 200 },
        );
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;

    const first = (await fetchTranscript(taddyConfig, { episodeUuid: "ep-1" }, { ...deps, fetchImpl: pendingFetchImpl })) as any;
    expect(first.status).toBe("no-transcript");
    expect(first.retry).toBeUndefined();
    expect(first.recheck).toEqual({
      attempt: 1,
      nextEligibleAt: new Date(clock + TRANSCRIPT_RECHECK_BASE_MS).toISOString(),
    });
    const afterFirst = await new Storage(dir).loadState();
    expect(afterFirst.episodes["ep-1"].transcriptStatus).toBe("none");
    expect(afterFirst.episodes["ep-1"].transcriptRecheck?.attempts).toBe(1);

    // Advance past the backoff; Taddy now has the transcript.
    clock += TRANSCRIPT_RECHECK_BASE_MS + 60_000;
    const hitFetchImpl = (async (input: any) => {
      const url = String(input);
      if (url === "https://api.taddy.org") {
        return new Response(
          JSON.stringify({ data: { getPodcastEpisode: { uuid: "ep-1", transcript: "now available" } } }),
          { status: 200 },
        );
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    const second = (await fetchTranscript(taddyConfig, { episodeUuid: "ep-1" }, { ...deps, fetchImpl: hitFetchImpl })) as any;
    expect(second.status).toBe("stored");
    const afterSecond = await new Storage(dir).loadState();
    expect(afterSecond.episodes["ep-1"].transcriptStatus).toBe("stored");
    expect(afterSecond.episodes["ep-1"].transcriptRecheck).toBeUndefined();
  });

  it("fetch_transcript gives up on a persistently Taddy-pending transcript once past the recheck horizon", async () => {
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
    const taddyConfig = config({ TADDY_API_KEY: "key", TADDY_USER_ID: "user" });
    let clock = Date.parse("2026-01-01T00:00:00Z");
    const deps = { env: { PATH: "" }, now: () => new Date(clock) };
    const pendingFetchImpl = (async (input: any) => {
      const url = String(input);
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

    await fetchTranscript(taddyConfig, { episodeUuid: "ep-1" }, { ...deps, fetchImpl: pendingFetchImpl });
    const afterFirst = await new Storage(dir).loadState();
    const firstDeferredAt = afterFirst.episodes["ep-1"].transcriptRecheck!.firstDeferredAt;

    clock = Date.parse(firstDeferredAt) + TRANSCRIPT_RECHECK_MAX_AGE_MS + 60_000;
    const last = (await fetchTranscript(taddyConfig, { episodeUuid: "ep-1" }, { ...deps, fetchImpl: pendingFetchImpl })) as any;
    expect(last.status).toBe("no-transcript");
    expect(last.recheck).toBeUndefined();
    const finalState = await new Storage(dir).loadState();
    expect(finalState.episodes["ep-1"].transcriptStatus).toBe("failed");
    expect(finalState.episodes["ep-1"].transcriptError).toContain("no transcript appeared after 14 days");
    expect(finalState.episodes["ep-1"].transcriptRecheck).toBeUndefined();
  });

  it("fetch_transcript still fails terminally on a first non-recheckable miss (no rung is recheckable)", async () => {
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
    // RSS resolves a feed but no item matches (non-recheckable per the ladder); no optional
    // providers configured; STT off.
    const fetchImpl = (async (input: any) => {
      const url = String(input);
      if (url.includes("export_feed_urls")) {
        return new Response(JSON.stringify({ result: { "pod-1": "https://example.com/feed.xml" } }), {
          status: 200,
        });
      }
      if (url === "https://example.com/feed.xml") {
        return new Response(
          `<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>`,
          { status: 200 },
        );
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    const result = (await fetchTranscript(config(), { episodeUuid: "ep-1" }, { fetchImpl, env: { PATH: "" } })) as any;
    expect(result.status).toBe("no-transcript");
    expect(result.recheck).toBeUndefined();
    const state = await new Storage(dir).loadState();
    expect(state.episodes["ep-1"].transcriptStatus).toBe("failed");
    expect(state.episodes["ep-1"].transcriptRecheck).toBeUndefined();
  });

  it("clears stale transcriptRecheck when a later attempt terminally misses before the recheck horizon", async () => {
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
    const taddyConfig = config({ TADDY_API_KEY: "key", TADDY_USER_ID: "user" });
    let clock = Date.parse("2026-01-01T00:00:00Z");
    const deps = { env: { PATH: "" }, now: () => new Date(clock) };

    const pendingFetchImpl = (async (input: any) => {
      const url = String(input);
      if (url === "https://api.taddy.org") {
        return new Response(
          JSON.stringify({
            data: {
              getPodcastEpisode: { uuid: "ep-1", transcript: null, taddyTranscribeStatus: "TRANSCRIBING" },
            },
          }),
          { status: 200 },
        );
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;

    await fetchTranscript(taddyConfig, { episodeUuid: "ep-1" }, { ...deps, fetchImpl: pendingFetchImpl });
    const afterFirst = await new Storage(dir).loadState();
    expect(afterFirst.episodes["ep-1"].transcriptRecheck?.attempts).toBe(1);

    // Well before the 14-day recheck horizon, Taddy now definitively reports no transcript
    // (no taddyTranscribeStatus at all) — a non-recheckable, terminal miss.
    clock += 60_000;
    const missFetchImpl = (async (input: any) => {
      const url = String(input);
      if (url === "https://api.taddy.org") {
        return new Response(
          JSON.stringify({ data: { getPodcastEpisode: { uuid: "ep-1", transcript: null } } }),
          { status: 200 },
        );
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    const last = (await fetchTranscript(taddyConfig, { episodeUuid: "ep-1" }, { ...deps, fetchImpl: missFetchImpl })) as any;
    expect(last.status).toBe("no-transcript");
    expect(last.recheck).toBeUndefined();
    const finalState = await new Storage(dir).loadState();
    expect(finalState.episodes["ep-1"].transcriptStatus).toBe("failed");
    expect(finalState.episodes["ep-1"].transcriptRecheck).toBeUndefined();
  });

  it("fetch_transcript prefers the retryable STT path over recheck when both apply (billing precedence)", async () => {
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
    // Taddy is pending (recheckable) AND Deepgram fails transiently (retryable).
    const bothConfig = config({
      TADDY_API_KEY: "key",
      TADDY_USER_ID: "user",
      CASTRECALL_ENABLE_STT: "true",
      CASTRECALL_STT_PROVIDER: "deepgram",
      DEEPGRAM_API_KEY: "dg-key",
    });
    const fetchImpl = (async (input: any) => {
      const url = String(input);
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
      if (url.startsWith("https://api.deepgram.com/")) {
        return new Response("bad gateway", { status: 502 });
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;

    const result = (await fetchTranscript(bothConfig, { episodeUuid: "ep-1" }, { fetchImpl, env: { PATH: "" } })) as any;
    expect(result.status).toBe("no-transcript");
    expect(result.retry).toBeDefined();
    expect(result.recheck).toBeUndefined();
    const state = await new Storage(dir).loadState();
    expect(state.episodes["ep-1"].transcriptRetry).toBeDefined();
    expect(state.episodes["ep-1"].transcriptRecheck).toBeUndefined();
  });

  it("keeps polling Taddy availability after the STT retry budget is exhausted, without re-billing STT on scheduled runs", async () => {
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
    const bothConfig = config({
      TADDY_API_KEY: "key",
      TADDY_USER_ID: "user",
      CASTRECALL_ENABLE_STT: "true",
      CASTRECALL_STT_PROVIDER: "deepgram",
      DEEPGRAM_API_KEY: "dg-key",
    });
    let sttCalls = 0;
    const pendingFetchImpl = (async (input: any) => {
      const url = String(input);
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
      if (url.startsWith("https://api.deepgram.com/")) {
        sttCalls += 1;
        return new Response("bad gateway", { status: 502 });
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;

    let last: any;
    for (let i = 0; i < TRANSCRIPT_RETRY_MAX_ATTEMPTS; i++) {
      last = await fetchTranscript(
        bothConfig,
        { episodeUuid: "ep-1", scheduled: true },
        { fetchImpl: pendingFetchImpl, env: { PATH: "" } },
      );
    }
    expect(sttCalls).toBe(TRANSCRIPT_RETRY_MAX_ATTEMPTS);
    expect(last.status).toBe("no-transcript");
    // The retry budget was just exhausted on this call, but Taddy is still
    // recheckable — the episode must stay eligible ("none") with a recheck
    // scheduled, not be marked terminally "failed".
    expect(last.recheck).toBeDefined();
    const afterExhaustion = await new Storage(dir).loadState();
    expect(afterExhaustion.episodes["ep-1"].transcriptStatus).toBe("none");
    expect(afterExhaustion.episodes["ep-1"].transcriptRecheck).toBeDefined();
    expect(afterExhaustion.episodes["ep-1"].transcriptRetry?.consecutiveFailures).toBe(
      TRANSCRIPT_RETRY_MAX_ATTEMPTS,
    );

    // A further scheduled call must not re-bill STT: its retry budget stays
    // spent for this episode once exhausted.
    await fetchTranscript(
      bothConfig,
      { episodeUuid: "ep-1", scheduled: true },
      { fetchImpl: pendingFetchImpl, env: { PATH: "" } },
    );
    expect(sttCalls).toBe(TRANSCRIPT_RETRY_MAX_ATTEMPTS);

    // Taddy later has the transcript within its own availability window; it's
    // still ingested even though STT is permanently skipped for this episode.
    const hitFetchImpl = (async (input: any) => {
      const url = String(input);
      if (url === "https://api.taddy.org") {
        return new Response(
          JSON.stringify({ data: { getPodcastEpisode: { uuid: "ep-1", transcript: "now available" } } }),
          { status: 200 },
        );
      }
      if (url.startsWith("https://api.deepgram.com/")) {
        throw new Error("STT must not be called once its retry budget is exhausted");
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    const final = (await fetchTranscript(
      bothConfig,
      { episodeUuid: "ep-1", scheduled: true },
      { fetchImpl: hitFetchImpl, env: { PATH: "" } },
    )) as any;
    expect(final.status).toBe("stored");
    const finalState = await new Storage(dir).loadState();
    expect(finalState.episodes["ep-1"].transcriptStatus).toBe("stored");
  });

  it("manual fetch_transcript re-attempts STT after the retry budget is exhausted", async () => {
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
    const bothConfig = config({
      TADDY_API_KEY: "key",
      TADDY_USER_ID: "user",
      CASTRECALL_ENABLE_STT: "true",
      CASTRECALL_STT_PROVIDER: "deepgram",
      DEEPGRAM_API_KEY: "dg-key",
    });
    let sttCalls = 0;
    const pendingFetchImpl = (async (input: any) => {
      const url = String(input);
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
      if (url.startsWith("https://api.deepgram.com/")) {
        sttCalls += 1;
        return new Response("bad gateway", { status: 502 });
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;

    // Exhaust the STT retry budget through scheduled runs.
    for (let i = 0; i < TRANSCRIPT_RETRY_MAX_ATTEMPTS; i++) {
      await fetchTranscript(
        bothConfig,
        { episodeUuid: "ep-1", scheduled: true },
        { fetchImpl: pendingFetchImpl, env: { PATH: "" } },
      );
    }
    expect(sttCalls).toBe(TRANSCRIPT_RETRY_MAX_ATTEMPTS);
    const exhausted = await new Storage(dir).loadState();
    expect(exhausted.episodes["ep-1"].transcriptRetry?.consecutiveFailures).toBe(
      TRANSCRIPT_RETRY_MAX_ATTEMPTS,
    );

    // The skipped-STT rung tells the operator to run castrecall_fetch_transcript
    // manually — so a manual (non-scheduled) call MUST actually attempt STT
    // again, not silently skip it based on the persisted spent budget.
    const manual = (await fetchTranscript(
      bothConfig,
      { episodeUuid: "ep-1" },
      { fetchImpl: pendingFetchImpl, env: { PATH: "" } },
    )) as any;
    expect(sttCalls).toBe(TRANSCRIPT_RETRY_MAX_ATTEMPTS + 1);
    expect(manual.status).toBe("no-transcript");
    // The failed manual attempt keeps the budget spent for scheduled runs.
    const afterManual = await new Storage(dir).loadState();
    expect(
      afterManual.episodes["ep-1"].transcriptRetry?.consecutiveFailures ?? 0,
    ).toBeGreaterThanOrEqual(TRANSCRIPT_RETRY_MAX_ATTEMPTS);
    expect(afterManual.episodes["ep-1"].transcriptStatus).toBe("none");

    // A manual attempt where STT succeeds stores the transcript.
    const sttHitFetchImpl = (async (input: any) => {
      const url = String(input);
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
      if (url.startsWith("https://cdn.example.com/")) {
        return new Response(new ArrayBuffer(8), { status: 200 });
      }
      if (url.startsWith("https://api.deepgram.com/")) {
        return new Response(
          JSON.stringify({
            results: {
              channels: [{ alternatives: [{ transcript: "manual retry transcript" }] }],
            },
          }),
          { status: 200 },
        );
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    const recovered = (await fetchTranscript(
      bothConfig,
      { episodeUuid: "ep-1" },
      { fetchImpl: sttHitFetchImpl, env: { PATH: "" } },
    )) as any;
    expect(recovered.status).toBe("stored");
    const recoveredState = await new Storage(dir).loadState();
    expect(recoveredState.episodes["ep-1"].transcriptStatus).toBe("stored");
    expect(recoveredState.episodes["ep-1"].transcriptRetry).toBeUndefined();
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

    const provenance = await storage.readProvenance("ep-1");
    expect(typeof provenance?.quality?.score).toBe("number");
    expect(["quote-safe", "reviewable", "search-only"]).toContain(provenance?.quality?.tier);
    expect(Array.isArray(provenance?.quality?.reasons)).toBe(true);
  });

  describe("fetch_transcript transcript cleanup pass (issue #45)", () => {
    function txtFetchImpl(transcriptText: string): typeof fetch {
      return (async (input: any) => {
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
                  <podcast:transcript url="https://cdn.example.com/ep1.txt" type="text/plain" />
                </item>
              </channel>
            </rss>`,
            { status: 200 },
          );
        }
        if (url === "https://cdn.example.com/ep1.txt") {
          return new Response(transcriptText, { status: 200, headers: { "content-type": "text/plain" } });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as typeof fetch;
    }

    async function seedEpisode() {
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
      return storage;
    }

    // Must not start with "[" — normalize.ts's format sniffing would mistake a
    // leading "[" for JSON and fail to parse this as plain text.
    const CAPTION_ARTIFACT_TEXT = "Hello there ,friend.\n[MUSIC]\nGoodbye.";
    const ALREADY_CLEAN_TEXT = "Hello there, friend.\nGoodbye.";

    it("stores cleaned text, keeps raw verbatim, and records provenance.cleanup.applied", async () => {
      const storage = await seedEpisode();
      const result = (await fetchTranscript(
        config(),
        { episodeUuid: "ep-1" },
        { fetchImpl: txtFetchImpl(CAPTION_ARTIFACT_TEXT) },
      )) as Record<string, any>;
      expect(result.status).toBe("stored");

      const storedText = await fs.readFile(path.join(storage.sourceDir("ep-1"), "transcript.txt"), "utf8");
      expect(storedText).toBe("Hello there, friend.\nGoodbye.");

      const raw = await fs.readFile(path.join(storage.sourceDir("ep-1"), "raw.txt"), "utf8");
      expect(raw).toBe(CAPTION_ARTIFACT_TEXT);

      const provenance = await storage.readProvenance("ep-1");
      expect(provenance?.cleanup?.applied).toEqual(
        expect.arrayContaining(["strip-standalone-cues", "fix-punctuation-glue"]),
      );
      expect(typeof provenance?.cleanup?.version).toBe("number");

      // The pre-cleanup text is always recoverable by re-normalizing raw.<ext>.
      expect(normalizeTranscript(raw, "txt").text).toBe(CAPTION_ARTIFACT_TEXT);
    });

    it("stores uncleaned text with provenance.cleanup absent when CASTRECALL_TRANSCRIPT_CLEANUP=0", async () => {
      const storage = await seedEpisode();
      const result = (await fetchTranscript(
        config({ CASTRECALL_TRANSCRIPT_CLEANUP: "0" }),
        { episodeUuid: "ep-1" },
        { fetchImpl: txtFetchImpl(CAPTION_ARTIFACT_TEXT) },
      )) as Record<string, any>;
      expect(result.status).toBe("stored");

      const storedText = await fs.readFile(path.join(storage.sourceDir("ep-1"), "transcript.txt"), "utf8");
      expect(storedText).toBe(CAPTION_ARTIFACT_TEXT);

      const provenance = await storage.readProvenance("ep-1");
      expect(provenance?.cleanup).toBeUndefined();
    });

    it("records an empty applied list when cleanup runs but the input was already clean", async () => {
      const storage = await seedEpisode();
      const result = (await fetchTranscript(
        config(),
        { episodeUuid: "ep-1" },
        { fetchImpl: txtFetchImpl(ALREADY_CLEAN_TEXT) },
      )) as Record<string, any>;
      expect(result.status).toBe("stored");

      const provenance = await storage.readProvenance("ep-1");
      expect(provenance?.cleanup).toEqual({ version: expect.any(Number), applied: [] });
    });
  });

  describe("fetch_transcript repetition-loop quarantine (issue #42)", () => {
    function rssFetchImpl(transcriptText: string): typeof fetch {
      return (async (input: any) => {
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
                  <podcast:transcript url="https://cdn.example.com/ep1.txt" type="text/plain" />
                </item>
              </channel>
            </rss>`,
            { status: 200 },
          );
        }
        if (url === "https://cdn.example.com/ep1.txt") {
          return new Response(transcriptText, { status: 200, headers: { "content-type": "text/plain" } });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as typeof fetch;
    }

    async function seedEpisode() {
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
      return storage;
    }

    const LOOPED_TEXT = Array.from({ length: 40 }, () => "Thank you for watching.").join(" ");
    const CLEAN_TEXT =
      "This is a normal, clean transcript with plenty of real content and no looping issues at all. " +
      "The host and guest cover several distinct topics across the episode.";

    it("quarantines a loop-corrupted transcript instead of storing it", async () => {
      const storage = await seedEpisode();
      const result = (await fetchTranscript(
        config(),
        { episodeUuid: "ep-1" },
        { fetchImpl: rssFetchImpl(LOOPED_TEXT) },
      )) as Record<string, any>;

      expect(result.status).toBe("quarantined");
      expect(result.loop.looped).toBe(true);
      expect(result.loop.phrase).toBe("thank you for watching");
      expect(result.episode.transcriptStatus).toBe("quarantined");

      const state = await storage.loadState();
      expect(state.episodes["ep-1"].transcriptStatus).toBe("quarantined");
      expect(state.episodes["ep-1"].transcriptError).toContain("thank you for watching");
      expect(await storage.hasTranscript("ep-1")).toBe(false);
      expect(await storage.readProvenance("ep-1")).toBeUndefined();

      const searchResult = (await search(config(), { query: "watching" })) as { results: unknown[] };
      expect(searchResult.results).toEqual([]);
    });

    it("reports a quarantined episode in setup_status counts and pipelineErrors", async () => {
      await seedEpisode();
      await fetchTranscript(config(), { episodeUuid: "ep-1" }, { fetchImpl: rssFetchImpl(LOOPED_TEXT) });

      const status = (await setupStatus(config(), { env: { PATH: "" } })) as Record<string, any>;
      expect(status.counts.transcriptsQuarantined).toBe(1);
      expect(status.pipelineErrors).toContainEqual(
        expect.objectContaining({ stage: "transcript", episodeUuid: "ep-1" }),
      );
    });

    it("regenerates cleanly: a quarantined episode that later ladders clean text stores normally", async () => {
      const storage = await seedEpisode();
      await fetchTranscript(config(), { episodeUuid: "ep-1" }, { fetchImpl: rssFetchImpl(LOOPED_TEXT) });
      expect((await storage.loadState()).episodes["ep-1"].transcriptStatus).toBe("quarantined");

      const result = (await fetchTranscript(
        config(),
        { episodeUuid: "ep-1" },
        { fetchImpl: rssFetchImpl(CLEAN_TEXT) },
      )) as Record<string, any>;

      expect(result.status).toBe("stored");
      const state = await storage.loadState();
      expect(state.episodes["ep-1"].transcriptStatus).toBe("stored");
      expect(state.episodes["ep-1"].transcriptError).toBeUndefined();
      expect(await storage.hasTranscript("ep-1")).toBe(true);
    });
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

  it("threads VTT cue timing through storage and export as approximate timestamps (issue #43)", async () => {
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

    const segments = await storage.readSegments("ep-1");
    expect(segments).toEqual([
      expect.objectContaining({ startSeconds: 0, endSeconds: 2, text: "A short transcript body." }),
    ]);

    const episodeDir = path.join(exportDir, "podcasts", "example-show", "episode-one-25422834");
    const indexContent = await fs.readFile(path.join(episodeDir, "index.md"), "utf8");
    expect(indexContent).toContain('approx_start: "00:00:00"');
    expect(indexContent).toContain('approx_end: "00:00:02"');
  });

  it("backfills timestamps at export time for a transcript stored before the segments.json sidecar existed (issue #43)", async () => {
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
    // Simulate an episode transcribed before segments.json existed: only the
    // raw VTT + transcript.txt + provenance.json triad is on disk, no sidecar.
    await storage.storeTranscript("ep-1", {
      raw: "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nA short transcript body.",
      ext: "vtt",
      text: "A short transcript body.",
      provenance: { ...PROVENANCE, format: "vtt" },
    });
    await storage.updateEpisode("ep-1", { transcriptStatus: "stored" });
    expect(await storage.readSegments("ep-1")).toBeUndefined();

    const result = (await fetchTranscript(
      config({ CASTRECALL_EXPORT_DIR: exportDir }),
      { episodeUuid: "ep-1" },
    )) as Record<string, any>;
    expect(result.status).toBe("already-stored");
    expect(result.export.skipped).toBe(false);

    // Still no persisted sidecar — timing was derived on the fly, not backfilled to disk.
    expect(await storage.readSegments("ep-1")).toBeUndefined();

    const episodeDir = path.join(exportDir, "podcasts", "example-show", "episode-one-25422834");
    const indexContent = await fs.readFile(path.join(episodeDir, "index.md"), "utf8");
    expect(indexContent).toContain('approx_start: "00:00:00"');
    expect(indexContent).toContain('approx_end: "00:00:02"');
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

  describe("resolveReview", () => {
    async function seedPendingReview(cfg: ReturnType<typeof config>): Promise<Storage> {
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
        text: "stored transcript text with enough words to review later, covering a durable idea.",
        provenance: PROVENANCE,
      });
      await storage.updateEpisode("ep-1", { transcriptStatus: "stored" });
      await generateReview(cfg, { episodeUuid: "ep-1" });
      return storage;
    }

    it("promote writes a note, moves the candidate, and records disposition in state", async () => {
      const notesDir = path.join(dir, "notes");
      const cfg = config({ CASTRECALL_NOTES_DIR: notesDir });
      const storage = await seedPendingReview(cfg);

      const result = (await resolveReview(
        cfg,
        { episodeUuid: "ep-1", disposition: "promote", content: "The one durable idea." },
        { now: () => new Date("2026-07-06T12:00:00.000Z") },
      )) as Record<string, any>;

      expect(result.disposition).toBe("promote");
      expect(result.promotedNotePath).toBeTruthy();
      const note = await fs.readFile(result.promotedNotePath, "utf8");
      expect(note).toContain("The one durable idea.");
      expect(note).toContain('episode: "Episode One"');
      expect(note).toContain('podcast: "Example Show"');
      expect(note).toContain("episode_uuid: ep-1");
      expect(note).toContain("transcript_source: rss");

      await expect(fs.access(storage.reviewCandidatePath("ep-1"))).rejects.toThrow();
      await expect(fs.access(result.resolvedPath)).resolves.toBeUndefined();

      const state = await storage.loadState();
      expect(state.episodes["ep-1"].reviewDisposition).toBe("promote");
      expect(state.episodes["ep-1"].reviewResolvedAt).toBe("2026-07-06T12:00:00.000Z");
      expect(state.episodes["ep-1"].promotedNotePath).toBe(result.promotedNotePath);
    });

    it("promote writes content verbatim, without trimming leading/trailing whitespace", async () => {
      const notesDir = path.join(dir, "notes");
      const cfg = config({ CASTRECALL_NOTES_DIR: notesDir });
      await seedPendingReview(cfg);
      const content = "  Keep the indentation on this line.\n\nSecond paragraph.\n  ";

      const result = (await resolveReview(
        cfg,
        { episodeUuid: "ep-1", disposition: "promote", content },
        { now: () => new Date("2026-07-06T12:00:00.000Z") },
      )) as Record<string, any>;

      const note = await fs.readFile(result.promotedNotePath, "utf8");
      expect(note).toContain(content);
    });

    it("promote auto-creates a not-yet-existing notesDir", async () => {
      const notesDir = path.join(dir, "does", "not", "exist", "yet");
      const cfg = config({ CASTRECALL_NOTES_DIR: notesDir });
      await seedPendingReview(cfg);

      const result = (await resolveReview(cfg, {
        episodeUuid: "ep-1",
        disposition: "promote",
        content: "Body.",
      })) as Record<string, any>;

      expect(result.disposition).toBe("promote");
      await expect(fs.access(result.promotedNotePath)).resolves.toBeUndefined();
    });

    it("promote never leaks secret query params from provenance", async () => {
      const notesDir = path.join(dir, "notes");
      const cfg = config({ CASTRECALL_NOTES_DIR: notesDir });
      await seedPendingReview(cfg);

      const result = (await resolveReview(cfg, {
        episodeUuid: "ep-1",
        disposition: "promote",
        content: "Body.",
      })) as Record<string, any>;

      const note = await fs.readFile(result.promotedNotePath, "utf8");
      expect(note).not.toContain("secret-audio");
      expect(note).not.toContain("secret-transcript");
    });

    it("promote without notesDir throws, writes nothing, and leaves the candidate pending", async () => {
      const cfg = config();
      const storage = await seedPendingReview(cfg);

      await expect(
        resolveReview(cfg, { episodeUuid: "ep-1", disposition: "promote", content: "Body." }),
      ).rejects.toThrow(/CASTRECALL_NOTES_DIR/);

      await expect(fs.access(storage.reviewCandidatePath("ep-1"))).resolves.toBeUndefined();
      const state = await storage.loadState();
      expect(state.episodes["ep-1"].reviewDisposition).toBeUndefined();
      await expect(fs.access(path.join(dir, "notes"))).rejects.toThrow();
    });

    it("promote with empty content throws before any write or move", async () => {
      const notesDir = path.join(dir, "notes");
      const cfg = config({ CASTRECALL_NOTES_DIR: notesDir });
      const storage = await seedPendingReview(cfg);

      await expect(
        resolveReview(cfg, { episodeUuid: "ep-1", disposition: "promote", content: "   " }),
      ).rejects.toThrow(/content/);

      await expect(fs.access(storage.reviewCandidatePath("ep-1"))).resolves.toBeUndefined();
      const state = await storage.loadState();
      expect(state.episodes["ep-1"].reviewDisposition).toBeUndefined();
    });

    it("promote throws on a note-path collision and leaves the candidate pending", async () => {
      const notesDir = path.join(dir, "notes");
      const cfg = config({ CASTRECALL_NOTES_DIR: notesDir });
      const storage = await seedPendingReview(cfg);
      const now = () => new Date("2026-07-06T12:00:00.000Z");

      // Pre-create the exact filename resolveReview will compute for this episode/date.
      await fs.mkdir(notesDir, { recursive: true });
      const collisionPath = path.join(notesDir, "2026-07-06-episode-one-ep-1.md");
      await fs.writeFile(collisionPath, "existing note", "utf8");

      await expect(
        resolveReview(cfg, { episodeUuid: "ep-1", disposition: "promote", content: "Body." }, { now }),
      ).rejects.toThrow(/already exists/);

      expect(await fs.readFile(collisionPath, "utf8")).toBe("existing note");
      await expect(fs.access(storage.reviewCandidatePath("ep-1"))).resolves.toBeUndefined();
      const state = await storage.loadState();
      expect(state.episodes["ep-1"].reviewDisposition).toBeUndefined();
    });

    it("discard moves the candidate to resolved, records disposition, and writes no note", async () => {
      const cfg = config();
      const storage = await seedPendingReview(cfg);

      const result = (await resolveReview(
        cfg,
        { episodeUuid: "ep-1", disposition: "discard" },
        { now: () => new Date("2026-07-06T12:00:00.000Z") },
      )) as Record<string, any>;

      expect(result.disposition).toBe("discard");
      await expect(fs.access(storage.reviewCandidatePath("ep-1"))).rejects.toThrow();
      await expect(fs.access(result.resolvedPath)).resolves.toBeUndefined();

      const state = await storage.loadState();
      expect(state.episodes["ep-1"].reviewDisposition).toBe("discard");
      expect(state.episodes["ep-1"].reviewResolvedAt).toBe("2026-07-06T12:00:00.000Z");
      expect(state.episodes["ep-1"].promotedNotePath).toBeUndefined();
      await expect(fs.access(path.join(dir, "notes"))).rejects.toThrow();
    });

    it("throws for an episode with no pending candidate (never generated)", async () => {
      const cfg = config();
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

      await expect(
        resolveReview(cfg, { episodeUuid: "ep-1", disposition: "discard" }),
      ).rejects.toThrow(/no pending review/i);
    });

    it("throws on a second resolve of the same episode", async () => {
      const cfg = config();
      await seedPendingReview(cfg);

      await resolveReview(cfg, { episodeUuid: "ep-1", disposition: "discard" });
      await expect(
        resolveReview(cfg, { episodeUuid: "ep-1", disposition: "discard" }),
      ).rejects.toThrow(/no pending review/i);
    });

    it("rejects re-resolving an episode whose pending candidate reappears after resolution", async () => {
      const cfg = config();
      const storage = await seedPendingReview(cfg);

      await resolveReview(cfg, { episodeUuid: "ep-1", disposition: "discard" });
      // Simulate a pending candidate reappearing for an already-resolved episode
      // (e.g. regenerated or restored out-of-band).
      await storage.writeReviewCandidate("ep-1", "# Review\n");

      await expect(
        resolveReview(cfg, { episodeUuid: "ep-1", disposition: "promote", content: "Body." }),
      ).rejects.toThrow(/already (been )?resolved|already resolved/i);

      const state = await storage.loadState();
      expect(state.episodes["ep-1"].reviewDisposition).toBe("discard");
      await expect(fs.access(storage.reviewCandidatePath("ep-1"))).resolves.toBeUndefined();
    });

    it("setup_status reports the notes destination and a reviewsResolved count from state", async () => {
      const notesDir = path.join(dir, "notes");
      const cfg = config({ CASTRECALL_NOTES_DIR: notesDir });
      await seedPendingReview(cfg);

      const before = (await setupStatus(cfg)) as Record<string, any>;
      expect(before.notes).toEqual({ notesDir });
      expect(before.counts.reviewsResolved).toBe(0);

      await resolveReview(cfg, { episodeUuid: "ep-1", disposition: "discard" });

      const after = (await setupStatus(cfg)) as Record<string, any>;
      expect(after.counts.reviewsResolved).toBe(1);
    });

    it("setup_status reports notesDir as null when unconfigured", async () => {
      const cfg = config();
      const status = (await setupStatus(cfg)) as Record<string, any>;
      expect(status.notes).toEqual({ notesDir: null });
    });

    it("discard: losing a resolve race to a concurrent promote does not overwrite the winning disposition", async () => {
      const cfg = config();
      const storage = await seedPendingReview(cfg);
      const originalResolve = Storage.prototype.resolvePendingReview;
      // Simulate a concurrent castrecall_resolve_review promote call that
      // completes its own move-and-record step in the middle of this call's
      // resolvePendingReview — i.e. it wins the race.
      const spy = vi
        .spyOn(Storage.prototype, "resolvePendingReview")
        .mockImplementationOnce(async function (this: Storage, uuid: string) {
          await originalResolve.call(this, uuid);
          await this.updateEpisode(uuid, {
            reviewDisposition: "promote",
            reviewResolvedAt: "2026-01-01T00:00:00.000Z",
            promotedNotePath: "/tmp/winner.md",
          });
          return originalResolve.call(this, uuid);
        });

      try {
        await expect(
          resolveReview(cfg, { episodeUuid: "ep-1", disposition: "discard" }),
        ).rejects.toThrow(/concurrent/i);
      } finally {
        spy.mockRestore();
      }

      const state = await storage.loadState();
      expect(state.episodes["ep-1"].reviewDisposition).toBe("promote");
      expect(state.episodes["ep-1"].promotedNotePath).toBe("/tmp/winner.md");
    });

    it("promote: losing a resolve race to a concurrent discard removes the orphaned note and does not overwrite state", async () => {
      const notesDir = path.join(dir, "notes");
      const cfg = config({ CASTRECALL_NOTES_DIR: notesDir });
      const storage = await seedPendingReview(cfg);
      const originalResolve = Storage.prototype.resolvePendingReview;
      const spy = vi
        .spyOn(Storage.prototype, "resolvePendingReview")
        .mockImplementationOnce(async function (this: Storage, uuid: string) {
          await originalResolve.call(this, uuid);
          await this.updateEpisode(uuid, {
            reviewDisposition: "discard",
            reviewResolvedAt: "2026-01-01T00:00:00.000Z",
          });
          return originalResolve.call(this, uuid);
        });

      try {
        await expect(
          resolveReview(cfg, { episodeUuid: "ep-1", disposition: "promote", content: "Body." }),
        ).rejects.toThrow(/concurrent/i);
      } finally {
        spy.mockRestore();
      }

      const state = await storage.loadState();
      expect(state.episodes["ep-1"].reviewDisposition).toBe("discard");
      expect(state.episodes["ep-1"].promotedNotePath).toBeUndefined();
      const noteFiles = await fs.readdir(notesDir).catch(() => []);
      expect(noteFiles).toHaveLength(0);
    });

    it("discard: rolls the candidate back to pending if the state write fails after the move", async () => {
      const cfg = config();
      const storage = await seedPendingReview(cfg);
      const spy = vi
        .spyOn(Storage.prototype, "updateEpisode")
        .mockImplementationOnce(async () => {
          throw new Error("simulated state write failure");
        });

      try {
        await expect(
          resolveReview(cfg, { episodeUuid: "ep-1", disposition: "discard" }),
        ).rejects.toThrow(/simulated state write failure/);
      } finally {
        spy.mockRestore();
      }

      await expect(fs.access(storage.reviewCandidatePath("ep-1"))).resolves.toBeUndefined();
      const state = await storage.loadState();
      expect(state.episodes["ep-1"].reviewDisposition).toBeUndefined();

      const result = (await resolveReview(cfg, {
        episodeUuid: "ep-1",
        disposition: "discard",
      })) as Record<string, any>;
      expect(result.disposition).toBe("discard");
    });

    it("promote: rolls the candidate back to pending and removes the note if the state write fails after the move", async () => {
      const notesDir = path.join(dir, "notes");
      const cfg = config({ CASTRECALL_NOTES_DIR: notesDir });
      const storage = await seedPendingReview(cfg);
      const spy = vi
        .spyOn(Storage.prototype, "updateEpisode")
        .mockImplementationOnce(async () => {
          throw new Error("simulated state write failure");
        });

      try {
        await expect(
          resolveReview(cfg, { episodeUuid: "ep-1", disposition: "promote", content: "Body." }),
        ).rejects.toThrow(/simulated state write failure/);
      } finally {
        spy.mockRestore();
      }

      await expect(fs.access(storage.reviewCandidatePath("ep-1"))).resolves.toBeUndefined();
      const state = await storage.loadState();
      expect(state.episodes["ep-1"].reviewDisposition).toBeUndefined();
      const noteFiles = await fs.readdir(notesDir).catch(() => []);
      expect(noteFiles).toHaveLength(0);

      const result = (await resolveReview(cfg, {
        episodeUuid: "ep-1",
        disposition: "promote",
        content: "Body.",
      })) as Record<string, any>;
      expect(result.disposition).toBe("promote");
    });
  });

  describe("digest", () => {
    function listen(uuid: string, overrides: Record<string, any> = {}) {
      return {
        uuid,
        title: `Episode ${uuid}`,
        url: `https://cdn.example.com/${uuid}.mp3`,
        podcastUuid: "pod-1",
        podcastTitle: "Example Show",
        ...overrides,
      };
    }

    function longText(marker: string): string {
      return Array.from(
        { length: 4 },
        (_, i) =>
          `Paragraph ${i} exploring ${marker} in enough depth and detail to be a substantial excerpt candidate for a human reviewer.`,
      ).join("\n\n");
    }

    it("aggregates in-window stored transcripts into one approval-gated digest", async () => {
      const storage = new Storage(dir);
      await storage.init();
      const now = () => new Date("2026-07-06T00:00:00.000Z");
      await storage.recordListens([listen("ep-1"), listen("ep-2", { podcastTitle: "Other Show" })], now);

      await storage.storeTranscript("ep-1", {
        raw: "raw",
        ext: "txt",
        text: longText("reconstructive"),
        provenance: { ...PROVENANCE, episodeUuid: "ep-1" },
      });
      await storage.updateEpisode("ep-1", { transcriptStatus: "stored", transcriptSource: "rss" }, now);

      await storage.storeTranscript("ep-2", {
        raw: "raw",
        ext: "txt",
        text: longText("marker987xyz"),
        provenance: { ...PROVENANCE, episodeUuid: "ep-2" },
      });
      await storage.updateEpisode("ep-2", { transcriptStatus: "stored", transcriptSource: "rss" }, now);

      const result = (await digest(config(), {}, { now })) as Record<string, any>;
      expect(result.episodes).toBe(2);
      expect(result.shows).toBe(2);
      expect(result.transcribed).toBe(2);
      expect(path.basename(result.path)).toBe("digest-2026-07-06-30d.md");
      expect(path.basename(result.path).match(/digest-/g)).toHaveLength(1);
      expect(result.path.startsWith(storage.reviewPendingDir())).toBe(true);

      const markdown = await fs.readFile(result.path, "utf8");
      expect(markdown).toContain("status: pending-review");
      expect(markdown).toContain("privacy: private-source");
      expect(markdown).toContain("reconstructive");
      expect(markdown).toContain("marker987xyz");
      expect(markdown).toContain("Other Show");
    });

    it("filters the window on firstSeenAt: excludes an episode 30 days ago, includes one 2 days ago", async () => {
      const storage = new Storage(dir);
      await storage.init();
      await storage.recordListens([listen("old")], () => new Date("2026-06-06T00:00:00.000Z"));
      await storage.recordListens([listen("recent")], () => new Date("2026-07-04T00:00:00.000Z"));

      const result = (await digest(
        config(),
        { days: 7 },
        { now: () => new Date("2026-07-06T00:00:00.000Z") },
      )) as Record<string, any>;
      expect(result.episodes).toBe(1);
    });

    it("counts a listened-but-not-transcribed episode in totals but excludes it from topics/excerpts", async () => {
      const storage = new Storage(dir);
      await storage.init();
      const now = () => new Date("2026-07-06T00:00:00.000Z");
      await storage.recordListens([listen("ep-1"), listen("ep-2")], now);
      await storage.storeTranscript("ep-1", {
        raw: "raw",
        ext: "txt",
        text: longText("uniqueterm42"),
        provenance: { ...PROVENANCE, episodeUuid: "ep-1" },
      });
      await storage.updateEpisode("ep-1", { transcriptStatus: "stored", transcriptSource: "rss" }, now);
      // ep-2 stays transcriptStatus "none" — listened, never transcribed.

      const result = (await digest(config(), {}, { now })) as Record<string, any>;
      expect(result.episodes).toBe(2);
      expect(result.transcribed).toBe(1);
      const markdown = await fs.readFile(result.path, "utf8");
      expect(markdown).toContain("uniqueterm42");
    });

    it("tolerates a stale stored record whose transcript file is missing: does not abort and does not count it as transcribed", async () => {
      const storage = new Storage(dir);
      await storage.init();
      const now = () => new Date("2026-07-06T00:00:00.000Z");
      await storage.recordListens([listen("ep-1"), listen("ep-2")], now);

      await storage.storeTranscript("ep-1", {
        raw: "raw",
        ext: "txt",
        text: longText("uniqueterm42"),
        provenance: { ...PROVENANCE, episodeUuid: "ep-1" },
      });
      await storage.updateEpisode("ep-1", { transcriptStatus: "stored", transcriptSource: "rss" }, now);

      // ep-2: state says "stored" but no transcript file was ever written — a stale/corrupted record.
      await storage.updateEpisode("ep-2", { transcriptStatus: "stored", transcriptSource: "rss" }, now);

      const result = (await digest(config(), {}, { now })) as Record<string, any>;
      expect(result.episodes).toBe(2);
      expect(result.transcribed).toBe(1);
      const markdown = await fs.readFile(result.path, "utf8");
      expect(markdown).toContain("uniqueterm42");
      expect(markdown).toContain("unavailable: 1");
    });

    it("is idempotent: a second run with the same window reports alreadyExists and never overwrites", async () => {
      const storage = new Storage(dir);
      await storage.init();
      const now = () => new Date("2026-07-06T00:00:00.000Z");
      await storage.recordListens([listen("ep-1")], now);
      await storage.storeTranscript("ep-1", {
        raw: "raw",
        ext: "txt",
        text: longText("firstrun"),
        provenance: { ...PROVENANCE, episodeUuid: "ep-1" },
      });
      await storage.updateEpisode("ep-1", { transcriptStatus: "stored", transcriptSource: "rss" }, now);

      const first = (await digest(config(), {}, { now })) as Record<string, any>;
      expect(first.alreadyExists).toBe(false);
      const second = (await digest(config(), {}, { now })) as Record<string, any>;
      expect(second.alreadyExists).toBe(true);
      expect(second.path).toBe(first.path);
      const markdown = await fs.readFile(first.path, "utf8");
      expect(markdown).toContain("firstrun");
    });

    it("returns a stable empty summary and writes no file on an empty corpus", async () => {
      const result = (await digest(
        config(),
        {},
        { now: () => new Date("2026-07-06T00:00:00.000Z") },
      )) as Record<string, any>;
      expect(result).toEqual({
        episodes: 0,
        shows: 0,
        transcribed: 0,
        window: { days: 30, start: "2026-06-06T00:00:00.000Z", end: "2026-07-06T00:00:00.000Z" },
        path: null,
        alreadyExists: false,
      });
      expect(await new Storage(dir).listPendingReviews()).toEqual([]);
    });

    it("returns the same empty summary shape when episodes exist but none fall in the window", async () => {
      const storage = new Storage(dir);
      await storage.init();
      await storage.recordListens([listen("old")], () => new Date("2026-01-01T00:00:00.000Z"));

      const result = (await digest(
        config(),
        { days: 7 },
        { now: () => new Date("2026-07-06T00:00:00.000Z") },
      )) as Record<string, any>;
      expect(result.episodes).toBe(0);
      expect(result.path).toBeNull();
      expect(await storage.listPendingReviews()).toEqual([]);
    });
  });
});
