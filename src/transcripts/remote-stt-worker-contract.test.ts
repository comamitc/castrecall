/**
 * Consumer contract test (issue #62): replays committed response fixtures
 * from the optional `castrecall-whisperx-worker` reference implementation
 * (worker/whisperx/fixtures/*.json) through the real remote-stt client, via
 * the same DI `fetchImpl` seam `remote-stt.test.ts` uses. Proves CastRecall
 * actually parses this worker's response shapes — no Python, no GPU, no
 * network. If the worker's normalized output ever drifts from what
 * `remote-stt.ts` can parse, this test fails.
 */
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../config.js";
import type { FetchLike } from "../pocketcasts/client.js";
import { segmentsToText } from "./normalize.js";
import { remoteSttHealth, transcribeWithRemoteStt } from "./remote-stt.js";

const AUDIO_URL = "https://example.com/episode.mp3";
const BASE_URL = "https://worker.example.com";
const TOKEN = "worker-bearer-token";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "worker", "whisperx", "fixtures");

async function fixture(name: string): Promise<unknown> {
  const raw = await fsp.readFile(path.join(FIXTURES_DIR, name), "utf8");
  return JSON.parse(raw);
}

// Isolated data dir per test file — async-job resume state must never touch
// a real data dir (same isolation `remote-stt.test.ts` uses).
const DATA_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), "castrecall-worker-contract-data-"));

function config(extraEnv: NodeJS.ProcessEnv = {}) {
  return resolveConfig(
    {},
    {
      CASTRECALL_ENABLE_STT: "true",
      CASTRECALL_STT_PROVIDER: "remote-stt",
      CASTRECALL_REMOTE_STT_BASE_URL: BASE_URL,
      CASTRECALL_REMOTE_STT_TOKEN: TOKEN,
      CASTRECALL_DATA_DIR: DATA_DIR,
      ...extraEnv,
    },
  );
}

beforeEach(async () => {
  await fsp.rm(path.join(DATA_DIR, ".staging", "remote-stt-jobs"), { recursive: true, force: true });
});

function fakeClock() {
  let clock = 0;
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
  };
}

describe("worker contract: remoteSttHealth", () => {
  it("parses the worker's health.json fixture", async () => {
    const body = await fixture("health.json");
    const fetchImpl: FetchLike = (async () => new Response(JSON.stringify(body), { status: 200 })) as FetchLike;
    const result = await remoteSttHealth(config(), fetchImpl);
    expect(result).toEqual({ ok: true, implementation: "whisperx", model: "large-v3" });
  });
});

describe("worker contract: sync (inline) result", () => {
  it("parses sync_result.json — text synthesized from segments, numeric speaker 0 preserved", async () => {
    const body = await fixture("sync_result.json");
    const fetchImpl: FetchLike = (async (url: string) => {
      expect(String(url)).toBe(`${BASE_URL}/transcribe`);
      return new Response(JSON.stringify(body), { status: 200 });
    }) as FetchLike;

    const result = await transcribeWithRemoteStt(config(), AUDIO_URL, { fetchImpl });

    expect(result.provider).toBe("remote-stt");
    expect(result.model).toBe("large-v3");
    expect(result.segments).toEqual([
      { speaker: "Speaker 0", text: "Welcome to the show.", startSeconds: 0, endSeconds: 3.2, start: "0", end: "3.2" },
      { speaker: "Speaker 1", text: "Thanks for having me.", startSeconds: 3.2, endSeconds: 5.8, start: "3.2", end: "5.8" },
    ]);
    expect(result.text).toBe(segmentsToText(result.segments!));
    expect(result.generation).toMatchObject({
      kind: "remote-stt",
      implementation: "whisperx",
      model: "large-v3",
      baseUrlHost: "worker.example.com",
      mode: "sync",
      submittedBy: "audio_url",
      durationSeconds: 812.4,
    });
  });
});

describe("worker contract: async job flow", () => {
  it("parses async_submit.json + job_completed.json — model falls back to CASTRECALL_REMOTE_STT_MODEL when the worker omits it", async () => {
    const submit = await fixture("async_submit.json");
    const completed = await fixture("job_completed.json");
    const fetchImpl: FetchLike = (async (url: string) => {
      if (String(url).endsWith("/transcribe")) return new Response(JSON.stringify(submit), { status: 200 });
      expect(String(url)).toBe(`${BASE_URL}/jobs/job-abc123`);
      return new Response(JSON.stringify(completed), { status: 200 });
    }) as FetchLike;
    const { now, sleep } = fakeClock();

    const result = await transcribeWithRemoteStt(
      config({ CASTRECALL_REMOTE_STT_MODEL: "configured-fallback-model" }),
      AUDIO_URL,
      { fetchImpl, sleep, now },
    );

    expect(result.text).toBe(segmentsToText(result.segments!));
    expect(result.text).toContain("Async transcript body.");
    expect(result.model).toBe("configured-fallback-model");
    expect(result.generation).toMatchObject({
      implementation: "whisperx",
      mode: "async",
      durationSeconds: 4.5,
    });
  });

  it("parses job_failed.json as a terminal, non-retryable error", async () => {
    const submit = await fixture("async_submit.json");
    const failed = await fixture("job_failed.json");
    const fetchImpl: FetchLike = (async (url: string) => {
      if (String(url).endsWith("/transcribe")) return new Response(JSON.stringify(submit), { status: 200 });
      return new Response(JSON.stringify(failed), { status: 200 });
    }) as FetchLike;
    const { now, sleep } = fakeClock();

    const attempt = transcribeWithRemoteStt(config(), AUDIO_URL, { fetchImpl, sleep, now });
    await expect(attempt).rejects.toThrow(/GPU OOM/);
  });

  it("parses job_completed_trailing_slash.json when the configured base URL has a trailing slash", async () => {
    const submit = await fixture("async_submit.json");
    const completed = await fixture("job_completed_trailing_slash.json");
    const fetchImpl: FetchLike = (async (url: string) => {
      if (String(url).endsWith("/transcribe")) return new Response(JSON.stringify(submit), { status: 200 });
      return new Response(JSON.stringify(completed), { status: 200 });
    }) as FetchLike;
    const { now, sleep } = fakeClock();

    const result = await transcribeWithRemoteStt(config({ CASTRECALL_REMOTE_STT_BASE_URL: `${BASE_URL}/` }), AUDIO_URL, {
      fetchImpl,
      sleep,
      now,
    });

    expect(result.text).toBe(segmentsToText(result.segments!));
    expect(result.text).toContain("Trailing-slash base transcript.");
    expect(result.generation?.baseUrlHost).toBe("worker.example.com");
  });
});

describe("worker contract: empty result", () => {
  it("parses empty_result.json (no text, no segments) as an empty/invalid transcript error", async () => {
    const body = await fixture("empty_result.json");
    const fetchImpl: FetchLike = (async () => new Response(JSON.stringify(body), { status: 200 })) as FetchLike;
    await expect(transcribeWithRemoteStt(config(), AUDIO_URL, { fetchImpl })).rejects.toThrow(
      /empty.*invalid transcript/i,
    );
  });
});
