import { describe, expect, it } from "vitest";
import {
  fetchHistory,
  login,
  parseTokenExpiry,
  PocketCastsApiError,
  PocketCastsAuthError,
  type FetchLike,
} from "./client.js";

const noWaitSleep = async () => {};

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("parseTokenExpiry", () => {
  it("decodes a JWT's exp claim (seconds) into milliseconds", () => {
    const exp = 1_800_000_000;
    expect(parseTokenExpiry(makeJwt({ exp }))).toBe(exp * 1000);
  });

  it("returns undefined for a non-JWT token", () => {
    expect(parseTokenExpiry("plain-opaque-token")).toBeUndefined();
  });

  it("returns undefined for a JWT with no exp claim", () => {
    expect(parseTokenExpiry(makeJwt({ sub: "user-1" }))).toBeUndefined();
  });

  it("returns undefined for an unparseable middle segment", () => {
    expect(parseTokenExpiry("header.not-base64url-json.sig")).toBeUndefined();
  });
});

describe("login retry behavior", () => {
  it("retries HTTP 500s and resolves the token on eventual success", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = (async () => {
      calls++;
      if (calls < 3) return new Response("err", { status: 500 });
      return new Response(JSON.stringify({ token: "tok-1" }), { status: 200 });
    }) as FetchLike;
    const token = await login("a@example.com", "pw", fetchImpl, { sleep: noWaitSleep });
    expect(token).toBe("tok-1");
    expect(calls).toBe(3);
  });

  it("never retries a 401 and throws PocketCastsAuthError after exactly one call", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = (async () => {
      calls++;
      return new Response("nope", { status: 401 });
    }) as FetchLike;
    await expect(
      login("a@example.com", "wrong", fetchImpl, { sleep: noWaitSleep }),
    ).rejects.toThrow(PocketCastsAuthError);
    expect(calls).toBe(1);
  });

  it("does not leak a secret-bearing response body into the thrown error", async () => {
    const secret = "sk-super-secret-marker";
    const fetchImpl: FetchLike = (async () => new Response(secret, { status: 500 })) as FetchLike;
    await expect(
      login("a@example.com", "pw", fetchImpl, { sleep: noWaitSleep, maxAttempts: 1 }),
    ).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return !message.includes(secret);
    });
  });
});

describe("fetchHistory retry behavior", () => {
  it("retries a network error then returns the parsed episodes", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = (async () => {
      calls++;
      if (calls < 3) throw new Error("ECONNRESET");
      return new Response(JSON.stringify({ episodes: [] }), { status: 200 });
    }) as FetchLike;
    const episodes = await fetchHistory("tok", fetchImpl, { sleep: noWaitSleep });
    expect(episodes).toEqual([]);
    expect(calls).toBe(3);
  });

  it("throws PocketCastsApiError after exactly RETRY_MAX_ATTEMPTS network failures", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = (async () => {
      calls++;
      throw new Error("ECONNRESET");
    }) as FetchLike;
    await expect(fetchHistory("tok", fetchImpl, { sleep: noWaitSleep })).rejects.toThrow(
      PocketCastsApiError,
    );
    expect(calls).toBe(3);
  });

  it("never retries a 403 and throws PocketCastsAuthError after exactly one call", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = (async () => {
      calls++;
      return new Response("nope", { status: 403 });
    }) as FetchLike;
    await expect(fetchHistory("tok", fetchImpl, { sleep: noWaitSleep })).rejects.toThrow(
      PocketCastsAuthError,
    );
    expect(calls).toBe(1);
  });
});
