import { describe, expect, it } from "vitest";
import { fetchWithRetry, isRetryableStatus, RETRY_CAP_MS, type FetchLike } from "./retry.js";

function noWaitSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

describe("isRetryableStatus", () => {
  it.each([429, 500, 503])("treats %i as retryable", (status) => {
    expect(isRetryableStatus(status)).toBe(true);
  });

  it.each([200, 401, 403, 404])("treats %i as non-retryable", (status) => {
    expect(isRetryableStatus(status)).toBe(false);
  });
});

describe("fetchWithRetry", () => {
  it("returns immediately on success with no sleeps", async () => {
    const { sleep, delays } = noWaitSleep();
    let calls = 0;
    const fetchImpl: FetchLike = (async () => {
      calls++;
      return new Response("ok", { status: 200 });
    }) as FetchLike;
    const response = await fetchWithRetry(fetchImpl, "https://example.test", undefined, { sleep });
    expect(response.status).toBe(200);
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it("retries a retryable status then succeeds", async () => {
    const { sleep, delays } = noWaitSleep();
    let calls = 0;
    const fetchImpl: FetchLike = (async () => {
      calls++;
      return calls < 3 ? new Response("err", { status: 500 }) : new Response("ok", { status: 200 });
    }) as FetchLike;
    const response = await fetchWithRetry(fetchImpl, "https://example.test", undefined, { sleep });
    expect(response.status).toBe(200);
    expect(calls).toBe(3);
    expect(delays).toEqual([250, 500]);
  });

  it("retries a thrown network error then succeeds", async () => {
    const { sleep } = noWaitSleep();
    let calls = 0;
    const fetchImpl: FetchLike = (async () => {
      calls++;
      if (calls < 3) throw new Error("ECONNRESET");
      return new Response("ok", { status: 200 });
    }) as FetchLike;
    const response = await fetchWithRetry(fetchImpl, "https://example.test", undefined, { sleep });
    expect(response.status).toBe(200);
    expect(calls).toBe(3);
  });

  it("re-throws the original error after exhausting retries on network failure", async () => {
    const { sleep } = noWaitSleep();
    let calls = 0;
    const original = new Error("still down");
    const fetchImpl: FetchLike = (async () => {
      calls++;
      throw original;
    }) as FetchLike;
    await expect(
      fetchWithRetry(fetchImpl, "https://example.test", undefined, { sleep }),
    ).rejects.toBe(original);
    expect(calls).toBe(3);
  });

  it("returns the final response after exhausting retries on a retryable status", async () => {
    const { sleep } = noWaitSleep();
    let calls = 0;
    const fetchImpl: FetchLike = (async () => {
      calls++;
      return new Response("still failing", { status: 503 });
    }) as FetchLike;
    const response = await fetchWithRetry(fetchImpl, "https://example.test", undefined, { sleep });
    expect(response.status).toBe(503);
    expect(calls).toBe(3);
  });

  it("returns a 401 immediately with no retries and no sleeps", async () => {
    const { sleep, delays } = noWaitSleep();
    let calls = 0;
    const fetchImpl: FetchLike = (async () => {
      calls++;
      return new Response("nope", { status: 401 });
    }) as FetchLike;
    const response = await fetchWithRetry(fetchImpl, "https://example.test", undefined, { sleep });
    expect(response.status).toBe(401);
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it("calls fetchImpl exactly once when maxAttempts is 1, regardless of status", async () => {
    const { sleep } = noWaitSleep();
    let calls = 0;
    const fetchImpl: FetchLike = (async () => {
      calls++;
      return new Response("err", { status: 500 });
    }) as FetchLike;
    const response = await fetchWithRetry(fetchImpl, "https://example.test", undefined, {
      sleep,
      maxAttempts: 1,
    });
    expect(response.status).toBe(500);
    expect(calls).toBe(1);
  });

  it("honors a numeric Retry-After header on 429 instead of the exponential delay", async () => {
    const { sleep, delays } = noWaitSleep();
    let calls = 0;
    const fetchImpl: FetchLike = (async () => {
      calls++;
      if (calls === 1) {
        return new Response("slow down", { status: 429, headers: { "retry-after": "1" } });
      }
      return new Response("ok", { status: 200 });
    }) as FetchLike;
    await fetchWithRetry(fetchImpl, "https://example.test", undefined, { sleep });
    expect(delays).toEqual([1000]);
  });

  it("falls back to exponential backoff when Retry-After is non-numeric", async () => {
    const { sleep, delays } = noWaitSleep();
    let calls = 0;
    const fetchImpl: FetchLike = (async () => {
      calls++;
      if (calls === 1) {
        return new Response("slow down", { status: 429, headers: { "retry-after": "soon" } });
      }
      return new Response("ok", { status: 200 });
    }) as FetchLike;
    await fetchWithRetry(fetchImpl, "https://example.test", undefined, { sleep });
    expect(delays).toEqual([250]);
  });

  it("caps backoff delays and keeps them non-decreasing across attempts", async () => {
    const { sleep, delays } = noWaitSleep();
    const fetchImpl: FetchLike = (async () => new Response("err", { status: 500 })) as FetchLike;
    await fetchWithRetry(fetchImpl, "https://example.test", undefined, {
      sleep,
      maxAttempts: 5,
      baseMs: 250,
      capMs: RETRY_CAP_MS,
    });
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
    }
    for (const delay of delays) {
      expect(delay).toBeLessThanOrEqual(RETRY_CAP_MS);
    }
  });

  it("never leaks a secret-bearing response body into a thrown error", async () => {
    const { sleep } = noWaitSleep();
    const secret = "sk-super-secret-marker";
    const fetchImpl: FetchLike = (async () => new Response(secret, { status: 500 })) as FetchLike;
    let thrownMessage = "";
    try {
      const response = await fetchWithRetry(fetchImpl, "https://example.test", undefined, {
        sleep,
        maxAttempts: 1,
      });
      // fetchWithRetry itself never reads the body; a caller-level failure
      // path would compose the message. Simulate that here to prove the body
      // is never touched by the helper by asserting it's still unread.
      expect(response.bodyUsed).toBe(false);
    } catch (error) {
      thrownMessage = error instanceof Error ? error.message : String(error);
    }
    expect(thrownMessage).not.toContain(secret);
  });
});
