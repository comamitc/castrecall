import { describe, expect, it } from "vitest";
import { CastrecallSetupError, resolveConfig } from "../config.js";
import type { FetchLike } from "../pocketcasts/client.js";
import { segmentsToText } from "./normalize.js";
import { RetryableSttError, sttAvailability, transcribeAudio } from "./stt.js";

const AUDIO_URL = "https://example.com/episode.mp3";
const noSleep = async () => {};

function config(env: NodeJS.ProcessEnv) {
  return resolveConfig({}, env);
}

describe("sttAvailability", () => {
  it("is disabled by default", () => {
    expect(sttAvailability(config({})).ok).toBe(false);
  });

  it("reports missing DEEPGRAM_API_KEY when deepgram is selected without a key", () => {
    const result = sttAvailability(
      config({ CASTRECALL_ENABLE_STT: "true", CASTRECALL_STT_PROVIDER: "deepgram" }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("DEEPGRAM_API_KEY");
  });

  it("is ok once deepgram is enabled and keyed", () => {
    const result = sttAvailability(
      config({
        CASTRECALL_ENABLE_STT: "true",
        CASTRECALL_STT_PROVIDER: "deepgram",
        DEEPGRAM_API_KEY: "key",
      }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("transcribeAudio with deepgram", () => {
  function deepgramConfig(extraEnv: NodeJS.ProcessEnv = {}) {
    return config({
      CASTRECALL_ENABLE_STT: "true",
      CASTRECALL_STT_PROVIDER: "deepgram",
      DEEPGRAM_API_KEY: "dg-key",
      ...extraEnv,
    });
  }

  it("throws CastrecallSetupError when Deepgram rejects the API key", async () => {
    const fetchImpl: FetchLike = (async () => new Response("nope", { status: 401 })) as FetchLike;
    await expect(transcribeAudio(deepgramConfig(), AUDIO_URL, fetchImpl)).rejects.toThrow(
      CastrecallSetupError,
    );
  });

  it("throws a plain, non-retrying Error mentioning the HTTP status on 5xx", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = (async () => {
      calls += 1;
      return new Response("gateway timeout", { status: 504 });
    }) as FetchLike;
    await expect(transcribeAudio(deepgramConfig(), AUDIO_URL, fetchImpl)).rejects.toThrow(/504/);
    expect(calls).toBe(1);
  });

  it("converts a rejected fetch (network-level failure) into a RetryableSttError", async () => {
    const fetchImpl: FetchLike = (async () => {
      throw new Error("socket hang up (ECONNRESET)");
    }) as FetchLike;
    const failure = transcribeAudio(deepgramConfig(), AUDIO_URL, fetchImpl);
    await expect(failure).rejects.toBeInstanceOf(RetryableSttError);
    await expect(
      transcribeAudio(deepgramConfig(), AUDIO_URL, fetchImpl),
    ).rejects.toThrow(/ECONNRESET/);
  });

  it("posts the audio URL with model, diarization, and Token auth header", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchImpl: FetchLike = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(
        JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: "hello" }] }] } }),
        { status: 200 },
      );
    }) as FetchLike;
    await transcribeAudio(deepgramConfig(), AUDIO_URL, fetchImpl);

    expect(capturedUrl).toContain("model=nova-3");
    expect(capturedUrl).toContain("diarize=true");
    expect(capturedUrl).toContain("utterances=true");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.body).toBe(JSON.stringify({ url: AUDIO_URL }));
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Token dg-key");
  });

  it("formats results.utterances into Speaker N: lines", async () => {
    const fetchImpl: FetchLike = (async () =>
      new Response(
        JSON.stringify({
          results: {
            utterances: [
              { speaker: 0, transcript: "hi there" },
              { speaker: 1, transcript: "hello back" },
            ],
          },
        }),
        { status: 200 },
      )) as FetchLike;
    const result = await transcribeAudio(deepgramConfig(), AUDIO_URL, fetchImpl);
    expect(result.text).toBe("Speaker 0: hi there\nSpeaker 1: hello back");
    expect(result.provider).toBe("deepgram");
    expect(result.model).toBe("nova-3");
  });

  it("falls back to results.channels[0].alternatives[0].transcript when there are no utterances", async () => {
    const fetchImpl: FetchLike = (async () =>
      new Response(
        JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: "plain text" }] }] } }),
        { status: 200 },
      )) as FetchLike;
    const result = await transcribeAudio(deepgramConfig(), AUDIO_URL, fetchImpl);
    expect(result.text).toBe("plain text");
    expect(result.segments).toBeUndefined();
  });

  it("throws when the transcript is empty", async () => {
    const fetchImpl: FetchLike = (async () =>
      new Response(JSON.stringify({ results: {} }), { status: 200 })) as FetchLike;
    await expect(transcribeAudio(deepgramConfig(), AUDIO_URL, fetchImpl)).rejects.toThrow(
      /empty text/,
    );
  });

  it("builds segments from utterances (issue #44): speaker 0 renders as 'Speaker 0', not dropped, with seconds already unit-correct", async () => {
    const fetchImpl: FetchLike = (async () =>
      new Response(
        JSON.stringify({
          results: {
            utterances: [
              { speaker: 0, transcript: "hi there", start: 1, end: 2 },
              { speaker: 1, transcript: "hello back", start: 2, end: 4 },
            ],
          },
        }),
        { status: 200 },
      )) as FetchLike;
    const result = await transcribeAudio(deepgramConfig(), AUDIO_URL, fetchImpl);
    expect(result.segments).toEqual([
      { speaker: "Speaker 0", text: "hi there", startSeconds: 1, endSeconds: 2, start: "1", end: "2" },
      { speaker: "Speaker 1", text: "hello back", startSeconds: 2, endSeconds: 4, start: "2", end: "4" },
    ]);
    expect(result.text).toBe(segmentsToText(result.segments!));
  });

  it("omits timing fields on a segment whose utterance carries a speaker but no start/end", async () => {
    const fetchImpl: FetchLike = (async () =>
      new Response(
        JSON.stringify({ results: { utterances: [{ speaker: 0, transcript: "hi there" }] } }),
        { status: 200 },
      )) as FetchLike;
    const result = await transcribeAudio(deepgramConfig(), AUDIO_URL, fetchImpl);
    expect(result.segments).toEqual([{ speaker: "Speaker 0", text: "hi there" }]);
  });
});

describe("transcribeAudio with assemblyai", () => {
  function assemblyAiConfig(extraEnv: NodeJS.ProcessEnv = {}) {
    return config({
      CASTRECALL_ENABLE_STT: "true",
      CASTRECALL_STT_PROVIDER: "assemblyai",
      ASSEMBLYAI_API_KEY: "aai-key",
      ...extraEnv,
    });
  }

  function fetchImplFor(utterances: Array<{ speaker?: string; text?: string; start?: number; end?: number }>) {
    return (async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/transcript")) {
        return new Response(JSON.stringify({ id: "tx-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "completed", utterances }), { status: 200 });
    }) as FetchLike;
  }

  it("builds segments from utterances, converting millisecond start/end to seconds", async () => {
    const fetchImpl = fetchImplFor([
      { speaker: "A", text: "hi there", start: 1000, end: 2000 },
      { speaker: "B", text: "hello back", start: 2000, end: 4000 },
    ]);
    const result = await transcribeAudio(assemblyAiConfig(), AUDIO_URL, fetchImpl, noSleep);
    expect(result.provider).toBe("assemblyai");
    expect(result.segments).toEqual([
      { speaker: "Speaker A", text: "hi there", startSeconds: 1, endSeconds: 2, start: "1", end: "2" },
      { speaker: "Speaker B", text: "hello back", startSeconds: 2, endSeconds: 4, start: "2", end: "4" },
    ]);
    expect(result.text).toBe(segmentsToText(result.segments!));
  });

  it("returns segments: undefined and falls back to status.text when there are no utterances", async () => {
    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/transcript")) {
        return new Response(JSON.stringify({ id: "tx-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "completed", text: "plain fallback text" }), {
        status: 200,
      });
    }) as FetchLike;
    const result = await transcribeAudio(assemblyAiConfig(), AUDIO_URL, fetchImpl, noSleep);
    expect(result.text).toBe("plain fallback text");
    expect(result.segments).toBeUndefined();
  });
});
