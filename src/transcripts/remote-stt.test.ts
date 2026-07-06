import { describe, expect, it } from "vitest";
import { CastrecallSetupError, resolveConfig } from "../config.js";
import type { FetchLike } from "../pocketcasts/client.js";
import { segmentsToText } from "./normalize.js";
import { remoteSttHealth, transcribeWithRemoteStt } from "./remote-stt.js";
import { RetryableSttError, sttAvailability, transcribeAudio } from "./stt.js";

const AUDIO_URL = "https://example.com/episode.mp3";
const BASE_URL = "https://stt.example.com/api/";
const TOKEN = "super-secret-token";

function config(extraEnv: NodeJS.ProcessEnv = {}) {
  return resolveConfig(
    {},
    {
      CASTRECALL_ENABLE_STT: "true",
      CASTRECALL_STT_PROVIDER: "remote-stt",
      CASTRECALL_REMOTE_STT_BASE_URL: BASE_URL,
      CASTRECALL_REMOTE_STT_TOKEN: TOKEN,
      ...extraEnv,
    },
  );
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

  it("throws a terminal Error when the poll deadline elapses while the job stays processing, without hanging", async () => {
    const fetchImpl: FetchLike = (async (url: string) => {
      if (String(url).endsWith("/transcribe")) {
        return new Response(JSON.stringify({ job_id: "job-1", status: "queued" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "processing" }), { status: 200 });
    }) as FetchLike;
    const { now, sleep } = fakeClock();
    await expect(
      transcribeWithRemoteStt(config(), AUDIO_URL, {
        fetchImpl,
        sleep,
        now,
        pollIntervalMs: 1_000,
        timeoutMs: 3_000,
      }),
    ).rejects.toThrow(/did not complete/);
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
