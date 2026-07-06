import { describe, expect, it } from "vitest";
import { CastrecallSetupError, resolveConfig } from "../config.js";
import type { FetchLike } from "../pocketcasts/client.js";
import { sttAvailability, transcribeAudio } from "./stt.js";

const AUDIO_URL = "https://example.com/episode.mp3";

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
  });

  it("throws when the transcript is empty", async () => {
    const fetchImpl: FetchLike = (async () =>
      new Response(JSON.stringify({ results: {} }), { status: 200 })) as FetchLike;
    await expect(transcribeAudio(deepgramConfig(), AUDIO_URL, fetchImpl)).rejects.toThrow(
      /empty text/,
    );
  });
});
