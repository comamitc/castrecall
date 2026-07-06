import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { CastrecallSetupError, resolveConfig } from "../config.js";
import type { FetchLike } from "../pocketcasts/client.js";
import { segmentsToText } from "./normalize.js";
import { remoteSttHealth, transcribeWithRemoteStt } from "./remote-stt.js";
import { RetryableSttError, sttAvailability, transcribeAudio } from "./stt.js";

const AUDIO_URL = "https://example.com/episode.mp3";
const BASE_URL = "https://stt.example.com/api/";
const TOKEN = "super-secret-token";

// Isolated data dir per test file: async-job resume state lives under
// <dataDir>/.staging/remote-stt-jobs and must never touch a real data dir.
const DATA_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), "castrecall-remote-stt-data-"));

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
  // Job-resume state is keyed by (base, audioUrl), which most tests share —
  // clear it so persisted job ids never leak across tests.
  await fsp.rm(path.join(DATA_DIR, ".staging", "remote-stt-jobs"), { recursive: true, force: true });
});

async function jobStateFiles(): Promise<string[]> {
  try {
    return await fsp.readdir(path.join(DATA_DIR, ".staging", "remote-stt-jobs"));
  } catch {
    return [];
  }
}

function fakeClock() {
  let clock = 0;
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
  };
}

describe("sttAvailability for remote-stt", () => {
  it("is not ok without CASTRECALL_REMOTE_STT_BASE_URL", () => {
    const result = sttAvailability(
      resolveConfig({}, { CASTRECALL_ENABLE_STT: "true", CASTRECALL_STT_PROVIDER: "remote-stt" }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("CASTRECALL_REMOTE_STT_BASE_URL");
  });

  it("is ok once a base URL is configured", () => {
    expect(sttAvailability(config()).ok).toBe(true);
  });
});

describe("remoteSttHealth", () => {
  it("returns ok with reported implementation/model on a 200", async () => {
    const fetchImpl: FetchLike = (async () =>
      new Response(JSON.stringify({ status: "ok", implementation: "whisperx", model: "large-v3" }), {
        status: 200,
      })) as FetchLike;
    const result = await remoteSttHealth(config(), fetchImpl);
    expect(result.ok).toBe(true);
    expect(result.implementation).toBe("whisperx");
    expect(result.model).toBe("large-v3");
  });

  it("returns ok on a 200 with no body at all", async () => {
    const fetchImpl: FetchLike = (async () => new Response("", { status: 200 })) as FetchLike;
    const result = await remoteSttHealth(config(), fetchImpl);
    expect(result.ok).toBe(true);
  });

  it("never throws: returns ok:false on a non-2xx response", async () => {
    const fetchImpl: FetchLike = (async () => new Response("down", { status: 503 })) as FetchLike;
    const result = await remoteSttHealth(config(), fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("503");
  });

  it("never throws: returns ok:false on a rejected fetch", async () => {
    const fetchImpl: FetchLike = (async () => {
      throw new Error("ECONNREFUSED");
    }) as FetchLike;
    const result = await remoteSttHealth(config(), fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("ECONNREFUSED");
  });

  it("returns ok:false when no base URL is configured", async () => {
    const result = await remoteSttHealth(
      resolveConfig({}, { CASTRECALL_STT_PROVIDER: "remote-stt" }),
      (async () => new Response("", { status: 200 })) as FetchLike,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("CASTRECALL_REMOTE_STT_BASE_URL");
  });
});

describe("transcribeWithRemoteStt — sync (inline) happy path", () => {
  it("submits audio_url and normalizes an inline result", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchImpl: FetchLike = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(
        JSON.stringify({
          text: "hello world",
          model: "large-v3",
          implementation: "whisperx",
          duration: 42.5,
        }),
        { status: 200 },
      );
    }) as FetchLike;

    const result = await transcribeWithRemoteStt(config(), AUDIO_URL, { fetchImpl });

    expect(capturedUrl).toBe("https://stt.example.com/api/transcribe");
    expect(capturedInit?.method).toBe("POST");
    expect(JSON.parse(capturedInit?.body as string)).toEqual({ audio_url: AUDIO_URL });
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);

    expect(result.provider).toBe("remote-stt");
    expect(result.text).toBe("hello world");
    expect(result.model).toBe("large-v3");
    expect(result.generation?.kind).toBe("remote-stt");
    expect(result.generation?.mode).toBe("sync");
    expect(result.generation?.submittedBy).toBe("audio_url");
    expect(result.generation?.implementation).toBe("whisperx");
    expect(result.generation?.durationSeconds).toBe(42.5);
    expect(result.generation?.baseUrlHost).toBe("stt.example.com");
  });

  it("dispatches through the generic transcribeAudio() ladder entrypoint", async () => {
    const fetchImpl: FetchLike = (async () =>
      new Response(JSON.stringify({ text: "via the ladder" }), { status: 200 })) as FetchLike;
    const result = await transcribeAudio(config(), AUDIO_URL, fetchImpl);
    expect(result.provider).toBe("remote-stt");
    expect(result.text).toBe("via the ladder");
  });

  it("synthesizes text from segments when segments carry speaker/timing and text is present", async () => {
    const fetchImpl: FetchLike = (async () =>
      new Response(
        JSON.stringify({
          segments: [
            { speaker: 0, text: "hi there", start: 1, end: 2 },
            { speaker: 1, text: "hello back", start: 2, end: 4 },
          ],
        }),
        { status: 200 },
      )) as FetchLike;
    const result = await transcribeWithRemoteStt(config(), AUDIO_URL, { fetchImpl });
    expect(result.segments).toEqual([
      { speaker: "Speaker 0", text: "hi there", startSeconds: 1, endSeconds: 2, start: "1", end: "2" },
      { speaker: "Speaker 1", text: "hello back", startSeconds: 2, endSeconds: 4, start: "2", end: "4" },
    ]);
    expect(result.text).toBe(segmentsToText(result.segments!));
  });

  it("passes model through when configured", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl: FetchLike = (async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({ text: "ok" }), { status: 200 });
    }) as FetchLike;
    await transcribeWithRemoteStt(config({ CASTRECALL_REMOTE_STT_MODEL: "large-v3" }), AUDIO_URL, { fetchImpl });
    expect(JSON.parse(capturedInit?.body as string)).toEqual({ audio_url: AUDIO_URL, model: "large-v3" });
  });

  it("throws an Error mentioning empty/invalid transcript when neither text nor segments are present", async () => {
    const fetchImpl: FetchLike = (async () => new Response(JSON.stringify({}), { status: 200 })) as FetchLike;
    await expect(transcribeWithRemoteStt(config(), AUDIO_URL, { fetchImpl })).rejects.toThrow(
      /empty.*invalid transcript/i,
    );
  });
});

describe("transcribeWithRemoteStt — async job flow", () => {
  it("polls queued -> processing -> completed and returns the normalized result", async () => {
    let pollCount = 0;
    const fetchImpl: FetchLike = (async (url: string) => {
      if (String(url).endsWith("/transcribe")) {
        return new Response(JSON.stringify({ job_id: "job-1", status: "queued" }), { status: 200 });
      }
      pollCount += 1;
      if (pollCount === 1) {
        return new Response(JSON.stringify({ status: "processing" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ status: "completed", result: { text: "async transcript" } }),
        { status: 200 },
      );
    }) as FetchLike;
    const { now, sleep } = fakeClock();
    const result = await transcribeWithRemoteStt(config(), AUDIO_URL, {
      fetchImpl,
      sleep,
      now,
      pollIntervalMs: 100,
      timeoutMs: 10_000,
    });
    expect(result.text).toBe("async transcript");
    expect(result.generation?.mode).toBe("async");
    expect(pollCount).toBe(2);
  });

  it("reads the result from the job body itself when no `result` field is present", async () => {
    const fetchImpl: FetchLike = (async (url: string) => {
      if (String(url).endsWith("/transcribe")) {
        return new Response(JSON.stringify({ job_id: "job-1", status: "queued" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "completed", text: "inline in job body" }), {
        status: 200,
      });
    }) as FetchLike;
    const { now, sleep } = fakeClock();
    const result = await transcribeWithRemoteStt(config(), AUDIO_URL, { fetchImpl, sleep, now });
    expect(result.text).toBe("inline in job body");
  });

  it("throws a plain Error when the job status is failed", async () => {
    const fetchImpl: FetchLike = (async (url: string) => {
      if (String(url).endsWith("/transcribe")) {
        return new Response(JSON.stringify({ job_id: "job-1", status: "queued" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "failed", error: "model crashed" }), { status: 200 });
    }) as FetchLike;
    const { now, sleep } = fakeClock();
    const failure = transcribeWithRemoteStt(config(), AUDIO_URL, { fetchImpl, sleep, now });
    await expect(failure).rejects.toThrow(/model crashed/);
    await expect(failure.catch((e) => e)).resolves.not.toBeInstanceOf(RetryableSttError);
  });

  it("throws RetryableSttError when the poll deadline elapses while the job stays processing — a slow job is not a failed job (issue #61 review)", async () => {
    const fetchImpl: FetchLike = (async (url: string) => {
      if (String(url).endsWith("/transcribe")) {
        return new Response(JSON.stringify({ job_id: "job-1", status: "queued" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "processing" }), { status: 200 });
    }) as FetchLike;
    const { now, sleep } = fakeClock();
    const attempt = transcribeWithRemoteStt(config(), AUDIO_URL, {
      fetchImpl,
      sleep,
      now,
      pollIntervalMs: 1_000,
      timeoutMs: 3_000,
    });
    await expect(attempt).rejects.toThrow(RetryableSttError);
    await expect(
      transcribeWithRemoteStt(config(), AUDIO_URL, {
        fetchImpl,
        sleep,
        now,
        pollIntervalMs: 1_000,
        timeoutMs: 3_000,
      }),
    ).rejects.toThrow(/may still finish/);
  });
});

describe("transcribeWithRemoteStt — async job resume (issue #61 review)", () => {
  it("resumes a timed-out job on the next attempt instead of enqueuing a duplicate", async () => {
    let submits = 0;
    const slowFetch: FetchLike = (async (url: string) => {
      if (String(url).endsWith("/transcribe")) {
        submits += 1;
        return new Response(JSON.stringify({ job_id: "job-slow", status: "queued" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "processing" }), { status: 200 });
    }) as FetchLike;
    const clock1 = fakeClock();
    await expect(
      transcribeWithRemoteStt(config(), AUDIO_URL, {
        fetchImpl: slowFetch,
        sleep: clock1.sleep,
        now: clock1.now,
        pollIntervalMs: 1_000,
        timeoutMs: 3_000,
      }),
    ).rejects.toThrow(RetryableSttError);
    expect(submits).toBe(1);
    expect(await jobStateFiles()).toHaveLength(1);

    // Next attempt: the job finished server-side. It must be observed via
    // GET /jobs/job-slow with NO new /transcribe submit.
    const doneFetch: FetchLike = (async (url: string) => {
      if (String(url).endsWith("/transcribe")) {
        submits += 1;
        return new Response(JSON.stringify({ job_id: "job-dup", status: "queued" }), { status: 200 });
      }
      expect(String(url)).toContain("/jobs/job-slow");
      return new Response(
        JSON.stringify({ status: "completed", result: { text: "resumed transcript" } }),
        { status: 200 },
      );
    }) as FetchLike;
    const clock2 = fakeClock();
    const result = await transcribeWithRemoteStt(config(), AUDIO_URL, {
      fetchImpl: doneFetch,
      sleep: clock2.sleep,
      now: clock2.now,
      pollIntervalMs: 1_000,
      timeoutMs: 3_000,
    });
    expect(result.text).toBe("resumed transcript");
    expect(submits).toBe(1); // never resubmitted
    expect(await jobStateFiles()).toHaveLength(0);
  });

  it("forgets a job the remote no longer recognizes and submits fresh", async () => {
    let submits = 0;
    const slowFetch: FetchLike = (async (url: string) => {
      if (String(url).endsWith("/transcribe")) {
        submits += 1;
        return new Response(JSON.stringify({ job_id: "job-gone", status: "queued" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "processing" }), { status: 200 });
    }) as FetchLike;
    const clock1 = fakeClock();
    await expect(
      transcribeWithRemoteStt(config(), AUDIO_URL, {
        fetchImpl: slowFetch,
        sleep: clock1.sleep,
        now: clock1.now,
        pollIntervalMs: 1_000,
        timeoutMs: 3_000,
      }),
    ).rejects.toThrow(RetryableSttError);

    const goneFetch: FetchLike = (async (url: string) => {
      if (String(url).includes("/jobs/job-gone")) return new Response("unknown job", { status: 404 });
      if (String(url).endsWith("/transcribe")) {
        submits += 1;
        return new Response(JSON.stringify({ text: "fresh transcript" }), { status: 200 });
      }
      return new Response("nope", { status: 404 });
    }) as FetchLike;
    const clock2 = fakeClock();
    const result = await transcribeWithRemoteStt(config(), AUDIO_URL, {
      fetchImpl: goneFetch,
      sleep: clock2.sleep,
      now: clock2.now,
      pollIntervalMs: 1_000,
      timeoutMs: 3_000,
    });
    expect(result.text).toBe("fresh transcript");
    expect(submits).toBe(2);
    expect(await jobStateFiles()).toHaveLength(0);
  });

  it("surfaces a resumed job's terminal failure instead of silently resubmitting (issue #61 review 2)", async () => {
    let submits = 0;
    const slowFetch: FetchLike = (async (url: string) => {
      if (String(url).endsWith("/transcribe")) {
        submits += 1;
        return new Response(JSON.stringify({ job_id: "job-doomed", status: "queued" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "processing" }), { status: 200 });
    }) as FetchLike;
    const clock1 = fakeClock();
    await expect(
      transcribeWithRemoteStt(config(), AUDIO_URL, {
        fetchImpl: slowFetch, sleep: clock1.sleep, now: clock1.now, pollIntervalMs: 1_000, timeoutMs: 3_000,
      }),
    ).rejects.toThrow(RetryableSttError);

    // The resumed job reports a terminal failure: that failure must surface
    // — never be swallowed into a duplicate /transcribe submission.
    const failedFetch: FetchLike = (async (url: string) => {
      if (String(url).endsWith("/transcribe")) {
        submits += 1;
        return new Response(JSON.stringify({ text: "should never happen" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "failed", error: "GPU OOM" }), { status: 200 });
    }) as FetchLike;
    const clock2 = fakeClock();
    await expect(
      transcribeWithRemoteStt(config(), AUDIO_URL, {
        fetchImpl: failedFetch, sleep: clock2.sleep, now: clock2.now, pollIntervalMs: 1_000, timeoutMs: 30_000,
      }),
    ).rejects.toThrow(/GPU OOM/);
    expect(submits).toBe(1);
    expect(await jobStateFiles()).toHaveLength(0);
  });

  it("surfaces a resumed job's malformed completed result instead of resubmitting (issue #61 review 2)", async () => {
    let submits = 0;
    const slowFetch: FetchLike = (async (url: string) => {
      if (String(url).endsWith("/transcribe")) {
        submits += 1;
        return new Response(JSON.stringify({ job_id: "job-empty", status: "queued" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "processing" }), { status: 200 });
    }) as FetchLike;
    const clock1 = fakeClock();
    await expect(
      transcribeWithRemoteStt(config(), AUDIO_URL, {
        fetchImpl: slowFetch, sleep: clock1.sleep, now: clock1.now, pollIntervalMs: 1_000, timeoutMs: 3_000,
      }),
    ).rejects.toThrow(RetryableSttError);

    const emptyFetch: FetchLike = (async (url: string) => {
      if (String(url).endsWith("/transcribe")) {
        submits += 1;
        return new Response(JSON.stringify({ text: "should never happen" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "completed", result: {} }), { status: 200 });
    }) as FetchLike;
    const clock2 = fakeClock();
    await expect(
      transcribeWithRemoteStt(config(), AUDIO_URL, {
        fetchImpl: emptyFetch, sleep: clock2.sleep, now: clock2.now, pollIntervalMs: 1_000, timeoutMs: 30_000,
      }),
    ).rejects.toThrow(/empty.*invalid transcript/i);
    expect(submits).toBe(1);
  });

  it("does not resume a job when request-shaping config changed (issue #61 review 2)", async () => {
    let submits = 0;
    const slowFetch: FetchLike = (async (url: string) => {
      if (String(url).endsWith("/transcribe")) {
        submits += 1;
        return new Response(JSON.stringify({ job_id: "job-old-model", status: "queued" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "processing" }), { status: 200 });
    }) as FetchLike;
    const clock1 = fakeClock();
    await expect(
      transcribeWithRemoteStt(config(), AUDIO_URL, {
        fetchImpl: slowFetch, sleep: clock1.sleep, now: clock1.now, pollIntervalMs: 1_000, timeoutMs: 3_000,
      }),
    ).rejects.toThrow(RetryableSttError);
    expect(await jobStateFiles()).toHaveLength(1);

    // Retrying with a DIFFERENT model must submit fresh — resuming the old
    // job would attribute an old-model transcript to the new configuration.
    const freshFetch: FetchLike = (async (url: string) => {
      expect(String(url)).not.toContain("/jobs/job-old-model");
      if (String(url).endsWith("/transcribe")) {
        submits += 1;
        return new Response(JSON.stringify({ text: "new model transcript", model: "large-v3" }), { status: 200 });
      }
      return new Response("nope", { status: 404 });
    }) as FetchLike;
    const result = await transcribeWithRemoteStt(
      config({ CASTRECALL_REMOTE_STT_MODEL: "large-v3" }),
      AUDIO_URL,
      { fetchImpl: freshFetch },
    );
    expect(result.text).toBe("new model transcript");
    expect(submits).toBe(2);
  });

  it("keeps the saved job id when a resumed poll fails auth (401/403) so a fixed token can still resume (issue #61 review 3)", async () => {
    const slowFetch: FetchLike = (async (url: string) => {
      if (String(url).endsWith("/transcribe")) {
        return new Response(JSON.stringify({ job_id: "job-auth", status: "queued" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "processing" }), { status: 200 });
    }) as FetchLike;
    const clock1 = fakeClock();
    await expect(
      transcribeWithRemoteStt(config(), AUDIO_URL, {
        fetchImpl: slowFetch, sleep: clock1.sleep, now: clock1.now, pollIntervalMs: 1_000, timeoutMs: 3_000,
      }),
    ).rejects.toThrow(RetryableSttError);
    expect(await jobStateFiles()).toHaveLength(1);

    for (const status of [401, 403]) {
      // GLOBAL auth failure: the health endpoint rejects the same token, so
      // the job handle survives — once the operator fixes the token, the
      // running remote job is resumed, not duplicated.
      const authFail: FetchLike = (async (url: string) => {
        if (String(url).endsWith("/transcribe")) {
          throw new Error("must not resubmit while auth is broken");
        }
        return new Response("forbidden", { status });
      }) as FetchLike;
      const clock = fakeClock();
      await expect(
        transcribeWithRemoteStt(config(), AUDIO_URL, {
          fetchImpl: authFail, sleep: clock.sleep, now: clock.now, pollIntervalMs: 1_000, timeoutMs: 3_000,
        }),
      ).rejects.toThrow(CastrecallSetupError);
      expect(await jobStateFiles()).toHaveLength(1);
    }

    // The ambiguity is BOUNDED: after MAX_RESUME_AUTH_FAILURES consecutive
    // auth-failed resume attempts (2 above + 1 below), the handle is
    // forgotten with a terminal error so a job-scoped denial (rotated
    // account/ACL) can never strand the episode indefinitely.
    const authFail3: FetchLike = (async (url: string) => {
      if (String(url).endsWith("/transcribe")) throw new Error("must not resubmit in the same call");
      return new Response("forbidden", { status: 403 });
    }) as FetchLike;
    const clock3 = fakeClock();
    await expect(
      transcribeWithRemoteStt(config(), AUDIO_URL, {
        fetchImpl: authFail3, sleep: clock3.sleep, now: clock3.now, pollIntervalMs: 1_000, timeoutMs: 3_000,
      }),
    ).rejects.toThrow(/forgotten/);
    expect(await jobStateFiles()).toHaveLength(0);
  });

  it("clears job state when the job fails terminally", async () => {
    const failFetch: FetchLike = (async (url: string) => {
      if (String(url).endsWith("/transcribe")) {
        return new Response(JSON.stringify({ job_id: "job-fail", status: "queued" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "failed", error: "GPU OOM" }), { status: 200 });
    }) as FetchLike;
    const clock = fakeClock();
    await expect(
      transcribeWithRemoteStt(config(), AUDIO_URL, {
        fetchImpl: failFetch,
        sleep: clock.sleep,
        now: clock.now,
        pollIntervalMs: 1_000,
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow(/GPU OOM/);
    expect(await jobStateFiles()).toHaveLength(0);
  });
});

describe("transcribeWithRemoteStt — error classification", () => {
  it("throws CastrecallSetupError on a 401 submit response", async () => {
    const fetchImpl: FetchLike = (async () => new Response("nope", { status: 401 })) as FetchLike;
    await expect(transcribeWithRemoteStt(config(), AUDIO_URL, { fetchImpl })).rejects.toThrow(
      CastrecallSetupError,
    );
  });

  it("throws CastrecallSetupError on a 401 poll response", async () => {
    const fetchImpl: FetchLike = (async (url: string) => {
      if (String(url).endsWith("/transcribe")) {
        return new Response(JSON.stringify({ job_id: "job-1", status: "queued" }), { status: 200 });
      }
      return new Response("nope", { status: 401 });
    }) as FetchLike;
    const { now, sleep } = fakeClock();
    await expect(
      transcribeWithRemoteStt(config(), AUDIO_URL, { fetchImpl, sleep, now }),
    ).rejects.toThrow(CastrecallSetupError);
  });

  it("throws RetryableSttError on a 503 submit response", async () => {
    const fetchImpl: FetchLike = (async () => new Response("down", { status: 503 })) as FetchLike;
    await expect(transcribeWithRemoteStt(config(), AUDIO_URL, { fetchImpl })).rejects.toBeInstanceOf(
      RetryableSttError,
    );
  });

  it("throws RetryableSttError on a 429 submit response", async () => {
    const fetchImpl: FetchLike = (async () => new Response("slow down", { status: 429 })) as FetchLike;
    await expect(transcribeWithRemoteStt(config(), AUDIO_URL, { fetchImpl })).rejects.toBeInstanceOf(
      RetryableSttError,
    );
  });

  it("throws RetryableSttError on a rejected submit fetch (network failure)", async () => {
    const fetchImpl: FetchLike = (async () => {
      throw new Error("socket hang up");
    }) as FetchLike;
    await expect(transcribeWithRemoteStt(config(), AUDIO_URL, { fetchImpl })).rejects.toBeInstanceOf(
      RetryableSttError,
    );
  });

  it("throws RetryableSttError on a 500 poll response", async () => {
    const fetchImpl: FetchLike = (async (url: string) => {
      if (String(url).endsWith("/transcribe")) {
        return new Response(JSON.stringify({ job_id: "job-1", status: "queued" }), { status: 200 });
      }
      return new Response("boom", { status: 500 });
    }) as FetchLike;
    const { now, sleep } = fakeClock();
    await expect(
      transcribeWithRemoteStt(config(), AUDIO_URL, { fetchImpl, sleep, now }),
    ).rejects.toBeInstanceOf(RetryableSttError);
  });

  it("throws a plain, non-retrying Error on a 400 submit response", async () => {
    const fetchImpl: FetchLike = (async () => new Response("bad request", { status: 400 })) as FetchLike;
    const failure = transcribeWithRemoteStt(config(), AUDIO_URL, { fetchImpl });
    await expect(failure).rejects.toThrow(/400/);
    await expect(failure.catch((e) => e)).resolves.not.toBeInstanceOf(RetryableSttError);
  });
});

describe("transcribeWithRemoteStt — upload mode", () => {
  function uploadConfig(extraEnv: NodeJS.ProcessEnv = {}) {
    return config({ CASTRECALL_REMOTE_STT_UPLOAD: "true", ...extraEnv });
  }

  it("downloads the audio first, then POSTs a multipart file field with no audio_url", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url) === AUDIO_URL) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      return new Response(JSON.stringify({ text: "uploaded transcript" }), { status: 200 });
    }) as FetchLike;

    const result = await transcribeWithRemoteStt(uploadConfig(), AUDIO_URL, { fetchImpl });

    expect(calls[0].url).toBe(AUDIO_URL);
    expect(calls[1].url).toBe("https://stt.example.com/api/transcribe");
    const form = calls[1].init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("file")).toBeTruthy();
    expect(form.get("audio_url")).toBeNull();
    expect(result.generation?.submittedBy).toBe("upload");
  });

  it("spools the upload to a temp file (no full-episode buffering) and cleans it up after submit", async () => {
    const os = await import("node:os");
    const fsp = await import("node:fs/promises");
    const before = new Set(await fsp.readdir(os.tmpdir()));
    const fetchImpl: FetchLike = (async (url: string) => {
      if (String(url) === AUDIO_URL) return new Response("fake audio bytes", { status: 200 });
      return new Response(JSON.stringify({ text: "uploaded transcript" }), { status: 200 });
    }) as FetchLike;

    const result = await transcribeWithRemoteStt(uploadConfig(), AUDIO_URL, { fetchImpl });
    expect(result.text).toBe("uploaded transcript");

    // Every castrecall-remote-stt-* spool file created during the call was
    // removed once the submit request completed.
    const after = await fsp.readdir(os.tmpdir());
    const leftover = after.filter(
      (name) => name.startsWith("castrecall-remote-stt-") && !before.has(name),
    );
    expect(leftover).toEqual([]);
  });

  it("sends the configured model alongside the uploaded file", async () => {
    let uploadInit: RequestInit | undefined;
    const fetchImpl: FetchLike = (async (url: string, init?: RequestInit) => {
      if (String(url) === AUDIO_URL) return new Response(new Uint8Array([1]), { status: 200 });
      uploadInit = init;
      return new Response(JSON.stringify({ text: "ok" }), { status: 200 });
    }) as FetchLike;
    await transcribeWithRemoteStt(uploadConfig({ CASTRECALL_REMOTE_STT_MODEL: "large-v3" }), AUDIO_URL, {
      fetchImpl,
    });
    const form = uploadInit?.body as FormData;
    expect(form.get("model")).toBe("large-v3");
  });

  it("converts a rejected audio download into a RetryableSttError", async () => {
    const fetchImpl: FetchLike = (async (url: string) => {
      if (String(url) === AUDIO_URL) throw new Error("DNS failure");
      throw new Error("should not reach /transcribe");
    }) as FetchLike;
    await expect(transcribeWithRemoteStt(uploadConfig(), AUDIO_URL, { fetchImpl })).rejects.toBeInstanceOf(
      RetryableSttError,
    );
  });

  it("converts a non-OK audio download status into a classified error", async () => {
    const fetchImpl: FetchLike = (async (url: string) => {
      if (String(url) === AUDIO_URL) return new Response("nope", { status: 503 });
      throw new Error("should not reach /transcribe");
    }) as FetchLike;
    await expect(transcribeWithRemoteStt(uploadConfig(), AUDIO_URL, { fetchImpl })).rejects.toBeInstanceOf(
      RetryableSttError,
    );
  });
});

describe("transcribeWithRemoteStt — secret-free provenance", () => {
  it("never serializes the token or the full base URL — only the host", async () => {
    const secretConfig = config({
      CASTRECALL_REMOTE_STT_BASE_URL: "https://audio-stt.internal.example.com/v2/",
      CASTRECALL_REMOTE_STT_TOKEN: "supersecret123",
    });
    const fetchImpl: FetchLike = (async () =>
      new Response(JSON.stringify({ text: "hello", implementation: "whisperx" }), { status: 200 })) as FetchLike;
    const result = await transcribeWithRemoteStt(secretConfig, AUDIO_URL, { fetchImpl });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("supersecret123");
    expect(serialized).not.toContain("/v2");
    expect(result.generation?.baseUrlHost).toBe("audio-stt.internal.example.com");
  });
});
