import { describe, expect, it } from "vitest";
import { CastrecallSetupError, resolveConfig } from "../config.js";
import { fetchTaddyTranscript, isTranscribingStatus, taddyConfigured } from "./taddy.js";

const noWaitSleep = async () => {};
const RETRY = { maxAttempts: 1, sleep: noWaitSleep };

const TADDY_ENDPOINT = "https://api.taddy.org";

function config(env: NodeJS.ProcessEnv = { TADDY_API_KEY: "key", TADDY_USER_ID: "user" }) {
  return resolveConfig({}, env);
}

const NOT_CONFIGURED = resolveConfig({}, {});

function episodeResponse(episode: unknown): Response {
  return new Response(JSON.stringify({ data: { getPodcastEpisode: episode } }), { status: 200 });
}

function notFoundResponse(): Response {
  return new Response(JSON.stringify({ errors: [{ message: "Episode not found" }] }), { status: 200 });
}

/** Every attempt (GUID then name) sees the same episode payload. */
function fetchImplFor(episode: unknown) {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === TADDY_ENDPOINT) return episodeResponse(episode);
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

describe("taddyConfigured", () => {
  it("is true only when both TADDY_API_KEY and TADDY_USER_ID are set", () => {
    expect(taddyConfigured(config())).toBe(true);
    expect(taddyConfigured(NOT_CONFIGURED)).toBe(false);
    expect(taddyConfigured(resolveConfig({}, { TADDY_API_KEY: "key" }))).toBe(false);
  });
});

describe("isTranscribingStatus", () => {
  it("matches PROCESSING and TRANSCRIBING (case-insensitive)", () => {
    expect(isTranscribingStatus("PROCESSING")).toBe(true);
    expect(isTranscribingStatus("TRANSCRIBING")).toBe(true);
    expect(isTranscribingStatus("processing")).toBe(true);
    expect(isTranscribingStatus("transcribing")).toBe(true);
  });

  it("does not treat NOT_TRANSCRIBING as in-progress despite containing the substring TRANSCRIBING", () => {
    expect(isTranscribingStatus("NOT_TRANSCRIBING")).toBe(false);
    expect(isTranscribingStatus("not_transcribing")).toBe(false);
  });

  it("does not treat COMPLETED, absent, or unknown values as in-progress", () => {
    expect(isTranscribingStatus("COMPLETED")).toBe(false);
    expect(isTranscribingStatus(undefined)).toBe(false);
    expect(isTranscribingStatus("")).toBe(false);
    expect(isTranscribingStatus("SOME_FUTURE_STATUS")).toBe(false);
  });
});

describe("fetchTaddyTranscript", () => {
  it("throws CastrecallSetupError when not configured", async () => {
    await expect(
      fetchTaddyTranscript(NOT_CONFIGURED, { guid: "g1", title: "Episode One" }),
    ).rejects.toThrowError(CastrecallSetupError);
  });

  it("returns a hit when the episode has transcript text", async () => {
    const fetchImpl = fetchImplFor({
      uuid: "ep-uuid",
      transcript: ["line one", "line two"],
      taddyTranscribeStatus: "COMPLETED",
    });
    const result = await fetchTaddyTranscript(
      config(),
      { guid: "guid-1", title: "Episode One" },
      fetchImpl,
      RETRY,
    );
    expect(result).toEqual({
      status: "hit",
      transcript: { text: "line one\nline two", episodeUuid: "ep-uuid" },
    });
  });

  it("returns pending when there is no transcript text but taddyTranscribeStatus is PROCESSING", async () => {
    const fetchImpl = fetchImplFor({
      uuid: "ep-uuid",
      transcript: null,
      taddyTranscribeStatus: "PROCESSING",
    });
    const result = await fetchTaddyTranscript(
      config(),
      { guid: "guid-1", title: "Episode One" },
      fetchImpl,
      RETRY,
    );
    expect(result).toEqual({ status: "pending" });
  });

  it("returns pending when there is no transcript text but taddyTranscribeStatus is TRANSCRIBING", async () => {
    const fetchImpl = fetchImplFor({
      uuid: "ep-uuid",
      transcript: null,
      taddyTranscribeStatus: "TRANSCRIBING",
    });
    const result = await fetchTaddyTranscript(
      config(),
      { guid: "guid-1", title: "Episode One" },
      fetchImpl,
      RETRY,
    );
    expect(result).toEqual({ status: "pending" });
  });

  it("returns pending for a lowercase in-progress status (tolerant case matching)", async () => {
    const fetchImpl = fetchImplFor({
      uuid: "ep-uuid",
      transcript: "",
      taddyTranscribeStatus: "processing",
    });
    const result = await fetchTaddyTranscript(
      config(),
      { guid: "guid-1", title: "Episode One" },
      fetchImpl,
      RETRY,
    );
    expect(result).toEqual({ status: "pending" });
  });

  it("returns miss (not pending) for NOT_TRANSCRIBING despite the TRANSCRIBING substring", async () => {
    const fetchImpl = fetchImplFor({
      uuid: "ep-uuid",
      transcript: null,
      taddyTranscribeStatus: "NOT_TRANSCRIBING",
    });
    const result = await fetchTaddyTranscript(
      config(),
      { guid: "guid-1", title: "Episode One" },
      fetchImpl,
      RETRY,
    );
    expect(result).toEqual({ status: "miss" });
  });

  it("returns miss when taddyTranscribeStatus is COMPLETED but no transcript text is present", async () => {
    const fetchImpl = fetchImplFor({
      uuid: "ep-uuid",
      transcript: null,
      taddyTranscribeStatus: "COMPLETED",
    });
    const result = await fetchTaddyTranscript(
      config(),
      { guid: "guid-1", title: "Episode One" },
      fetchImpl,
      RETRY,
    );
    expect(result).toEqual({ status: "miss" });
  });

  it("returns miss when taddyTranscribeStatus is absent or unrecognized", async () => {
    const fetchImpl = fetchImplFor({ uuid: "ep-uuid", transcript: null });
    const result = await fetchTaddyTranscript(
      config(),
      { guid: "guid-1", title: "Episode One" },
      fetchImpl,
      RETRY,
    );
    expect(result).toEqual({ status: "miss" });
  });

  it("returns miss on a not-found GraphQL error for every attempt", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === TADDY_ENDPOINT) return notFoundResponse();
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    const result = await fetchTaddyTranscript(
      config(),
      { guid: "guid-1", title: "Episode One" },
      fetchImpl,
      RETRY,
    );
    expect(result).toEqual({ status: "miss" });
  });
});
