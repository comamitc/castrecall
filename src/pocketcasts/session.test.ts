import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../config.js";
import { PocketCastsAuthError } from "./client.js";
import type { ExecImpl } from "./secret-store.js";
import {
  DEFAULT_TOKEN_TTL_MS,
  TOKEN_EXPIRY_SKEW_MS,
  clearPocketCastsSessionCache,
  fetchHistoryWithSession,
  getPocketCastsToken,
  resolvePocketCastsCredentials,
} from "./session.js";

function envConfig(env: NodeJS.ProcessEnv = {}) {
  return resolveConfig({}, env);
}

function makeJwt(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  return `${header}.${payload}.sig`;
}

function loginFetch() {
  const counts = { login: 0, history: 0 };
  const fetchImpl = (async (input: unknown) => {
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

function createKeychainExec(initial: Record<string, string> = {}): {
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
      const value = argv[argv.indexOf("-w") + 1];
      store.set(account, value);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (action === "delete-generic-password") {
      const existed = store.delete(account);
      return { code: existed ? 0 : 44, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected argv: ${argv.join(" ")}`);
  };
  return { execImpl, calls };
}

describe("session", () => {
  let binDir: string;

  beforeEach(async () => {
    clearPocketCastsSessionCache();
    binDir = await fs.mkdtemp(path.join(os.tmpdir(), "castrecall-keychain-bin-"));
    await fs.writeFile(path.join(binDir, "security"), "#!/bin/sh\n", { mode: 0o755 });
  });

  afterEach(async () => {
    await fs.rm(binDir, { recursive: true, force: true });
  });

  describe("resolvePocketCastsCredentials", () => {
    it("prefers the keychain over env vars even when both are set", async () => {
      const { execImpl } = createKeychainExec({
        "pocketcasts-email": "keychain@example.com",
        "pocketcasts-password": "kpw",
      });
      const config = envConfig({ POCKETCASTS_EMAIL: "env@example.com", POCKETCASTS_PASSWORD: "envpw" });
      const result = await resolvePocketCastsCredentials(config, {
        execImpl,
        env: { PATH: binDir },
        platform: "darwin",
      });
      expect(result).toEqual({ source: "keychain", email: "keychain@example.com", password: "kpw" });
    });

    it("falls back to env vars when the keychain has no entry", async () => {
      const { execImpl } = createKeychainExec({});
      const config = envConfig({ POCKETCASTS_EMAIL: "env@example.com", POCKETCASTS_PASSWORD: "envpw" });
      const result = await resolvePocketCastsCredentials(config, {
        execImpl,
        env: { PATH: binDir },
        platform: "darwin",
      });
      expect(result).toEqual({ source: "env", email: "env@example.com", password: "envpw" });
    });

    it("reports none when neither keychain nor env has credentials", async () => {
      const { execImpl } = createKeychainExec({});
      const config = envConfig({});
      const result = await resolvePocketCastsCredentials(config, {
        execImpl,
        env: { PATH: binDir },
        platform: "darwin",
      });
      expect(result).toEqual({ source: "none" });
    });

    it("degrades to env credentials when a keychain read throws", async () => {
      const execImpl: ExecImpl = async (argv) => {
        if (argv[1] === "find-generic-password") throw new Error("keychain locked");
        return { code: 0, stdout: "", stderr: "" };
      };
      const config = envConfig({ POCKETCASTS_EMAIL: "a@b.c", POCKETCASTS_PASSWORD: "pw" });
      const result = await resolvePocketCastsCredentials(config, {
        execImpl,
        env: { PATH: binDir },
        platform: "darwin",
      });
      expect(result).toEqual({ source: "env", email: "a@b.c", password: "pw" });
    });
  });

  it("getPocketCastsToken throws naming both env vars and the keychain option when unconfigured", async () => {
    const config = envConfig({});
    await expect(getPocketCastsToken(config, { env: { PATH: "" } })).rejects.toThrowError(
      /POCKETCASTS_EMAIL/,
    );
    await expect(getPocketCastsToken(config, { env: { PATH: "" } })).rejects.toThrowError(
      /POCKETCASTS_PASSWORD/,
    );
    await expect(getPocketCastsToken(config, { env: { PATH: "" } })).rejects.toThrowError(/keychain/i);
  });

  it("with no backend, authenticates from env vars and never touches execImpl", async () => {
    const execImpl: ExecImpl = async () => {
      throw new Error("execImpl should never be called with no backend detected");
    };
    const config = envConfig({ POCKETCASTS_EMAIL: "a@b.c", POCKETCASTS_PASSWORD: "pw" });
    const { fetchImpl, counts } = loginFetch();
    const episodes = await fetchHistoryWithSession(config, { fetchImpl, execImpl, env: { PATH: "" } });
    expect(episodes).toEqual([]);
    expect(counts.login).toBe(1);
  });

  it("reuses a cached token across two fetchHistoryWithSession calls (logs in once)", async () => {
    const config = envConfig({ POCKETCASTS_EMAIL: "a@b.c", POCKETCASTS_PASSWORD: "pw" });
    const { fetchImpl, counts } = loginFetch();
    await fetchHistoryWithSession(config, { fetchImpl, env: { PATH: "" } });
    await fetchHistoryWithSession(config, { fetchImpl, env: { PATH: "" } });
    expect(counts.login).toBe(1);
    expect(counts.history).toBe(2);
  });

  it("does not re-login for a token safely inside the default TTL", async () => {
    const config = envConfig({ POCKETCASTS_EMAIL: "a@b.c", POCKETCASTS_PASSWORD: "pw" });
    const { fetchImpl, counts } = loginFetch();
    let now = new Date("2026-07-05T00:00:00Z");
    await fetchHistoryWithSession(config, { fetchImpl, env: { PATH: "" }, now: () => now });
    now = new Date(now.getTime() + 60_000);
    await fetchHistoryWithSession(config, { fetchImpl, env: { PATH: "" }, now: () => now });
    expect(counts.login).toBe(1);
  });

  it("re-logs in once a non-JWT token's default-TTL expiry has passed", async () => {
    const config = envConfig({ POCKETCASTS_EMAIL: "a@b.c", POCKETCASTS_PASSWORD: "pw" });
    const { fetchImpl, counts } = loginFetch();
    let now = new Date("2026-07-05T00:00:00Z");
    await fetchHistoryWithSession(config, { fetchImpl, env: { PATH: "" }, now: () => now });
    expect(counts.login).toBe(1);
    now = new Date(now.getTime() + DEFAULT_TOKEN_TTL_MS + 1000);
    await fetchHistoryWithSession(config, { fetchImpl, env: { PATH: "" }, now: () => now });
    expect(counts.login).toBe(2);
  });

  it("treats a token within the expiry skew window as already expired", async () => {
    const config = envConfig({ POCKETCASTS_EMAIL: "a@b.c", POCKETCASTS_PASSWORD: "pw" });
    const { fetchImpl, counts } = loginFetch();
    let now = new Date("2026-07-05T00:00:00Z");
    await fetchHistoryWithSession(config, { fetchImpl, env: { PATH: "" }, now: () => now });
    // Nominally still in the future, but inside TOKEN_EXPIRY_SKEW_MS of expiry.
    now = new Date(now.getTime() + DEFAULT_TOKEN_TTL_MS - TOKEN_EXPIRY_SKEW_MS / 2);
    await fetchHistoryWithSession(config, { fetchImpl, env: { PATH: "" }, now: () => now });
    expect(counts.login).toBe(2);
  });

  it("uses a JWT's own exp instead of the default TTL when present", async () => {
    const startMs = new Date("2026-07-05T00:00:00Z").getTime();
    const jwt = makeJwt(Math.floor(startMs / 1000) + 5);
    let loginCalls = 0;
    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/user/login")) {
        loginCalls += 1;
        return new Response(JSON.stringify({ token: jwt }), { status: 200 });
      }
      if (url.endsWith("/user/history")) {
        return new Response(JSON.stringify({ episodes: [] }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    const config = envConfig({ POCKETCASTS_EMAIL: "a@b.c", POCKETCASTS_PASSWORD: "pw" });
    let now = new Date(startMs);
    await fetchHistoryWithSession(config, { fetchImpl, env: { PATH: "" }, now: () => now });
    expect(loginCalls).toBe(1);
    // 10s later: well inside DEFAULT_TOKEN_TTL_MS, but past the JWT's own 5s exp.
    now = new Date(startMs + 10_000);
    await fetchHistoryWithSession(config, { fetchImpl, env: { PATH: "" }, now: () => now });
    expect(loginCalls).toBe(2);
  });

  it("ignores a cached token whose credentials have since changed (password rotation)", async () => {
    const { fetchImpl, counts } = loginFetch();
    const config = envConfig({ POCKETCASTS_EMAIL: "a@b.c", POCKETCASTS_PASSWORD: "old-pw" });
    await fetchHistoryWithSession(config, { fetchImpl, env: { PATH: "" } });
    expect(counts.login).toBe(1);

    const rotated = envConfig({ POCKETCASTS_EMAIL: "a@b.c", POCKETCASTS_PASSWORD: "new-pw" });
    await fetchHistoryWithSession(rotated, { fetchImpl, env: { PATH: "" } });
    expect(counts.login).toBe(2);
  });

  it("shares one in-flight login across concurrent callers", async () => {
    const config = envConfig({ POCKETCASTS_EMAIL: "a@b.c", POCKETCASTS_PASSWORD: "pw" });
    let loginCalls = 0;
    let resolveLogin!: (response: Response) => void;
    const loginResponse = new Promise<Response>((resolve) => {
      resolveLogin = resolve;
    });
    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/user/login")) {
        loginCalls += 1;
        return loginResponse;
      }
      if (url.endsWith("/user/history")) {
        return new Response(JSON.stringify({ episodes: [] }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const call1 = fetchHistoryWithSession(config, { fetchImpl, env: { PATH: "" } });
    const call2 = fetchHistoryWithSession(config, { fetchImpl, env: { PATH: "" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveLogin(new Response(JSON.stringify({ token: "shared-tok" }), { status: 200 }));
    await Promise.all([call1, call2]);
    expect(loginCalls).toBe(1);
  });

  it("does not share an in-flight login across different credentials (rotation mid-login)", async () => {
    const configA = envConfig({ POCKETCASTS_EMAIL: "a@b.c", POCKETCASTS_PASSWORD: "pw-a" });
    const configB = envConfig({ POCKETCASTS_EMAIL: "a@b.c", POCKETCASTS_PASSWORD: "pw-b" });
    const loginCalls: Record<string, number> = { "pw-a": 0, "pw-b": 0 };
    let resolveA!: (response: Response) => void;
    let resolveB!: (response: Response) => void;
    const responseA = new Promise<Response>((resolve) => {
      resolveA = resolve;
    });
    const responseB = new Promise<Response>((resolve) => {
      resolveB = resolve;
    });
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/user/login")) {
        const { password } = JSON.parse(String(init?.body)) as { password: string };
        loginCalls[password] = (loginCalls[password] ?? 0) + 1;
        return password === "pw-a" ? responseA : responseB;
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const tokenA = getPocketCastsToken(configA, { fetchImpl, env: { PATH: "" } });
    const tokenB = getPocketCastsToken(configB, { fetchImpl, env: { PATH: "" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveA(new Response(JSON.stringify({ token: "tok-a" }), { status: 200 }));
    resolveB(new Response(JSON.stringify({ token: "tok-b" }), { status: 200 }));

    expect(await tokenA).toBe("tok-a");
    expect(await tokenB).toBe("tok-b");
    expect(loginCalls["pw-a"]).toBe(1);
    expect(loginCalls["pw-b"]).toBe(1);
  });

  describe("401 invalidation", () => {
    function authFlipFetch() {
      const counts = { login: 0, history: 0 };
      let historyCalls = 0;
      const fetchImpl = (async (input: unknown) => {
        const url = String(input);
        if (url.endsWith("/user/login")) {
          counts.login += 1;
          return new Response(JSON.stringify({ token: `tok-${counts.login}` }), { status: 200 });
        }
        if (url.endsWith("/user/history")) {
          counts.history += 1;
          historyCalls += 1;
          if (historyCalls === 1) return new Response(JSON.stringify({}), { status: 401 });
          return new Response(JSON.stringify({ episodes: [] }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as typeof fetch;
      return { fetchImpl, counts };
    }

    it("invalidates and logs in exactly once more after a 401, then succeeds", async () => {
      const config = envConfig({ POCKETCASTS_EMAIL: "a@b.c", POCKETCASTS_PASSWORD: "pw" });
      const { fetchImpl, counts } = authFlipFetch();
      const episodes = await fetchHistoryWithSession(config, { fetchImpl, env: { PATH: "" } });
      expect(episodes).toEqual([]);
      expect(counts.login).toBe(2);
      expect(counts.history).toBe(2);
    });

    it("propagates a second consecutive 401 without a third login", async () => {
      const config = envConfig({ POCKETCASTS_EMAIL: "a@b.c", POCKETCASTS_PASSWORD: "pw" });
      let loginCalls = 0;
      let historyCalls = 0;
      const fetchImpl = (async (input: unknown) => {
        const url = String(input);
        if (url.endsWith("/user/login")) {
          loginCalls += 1;
          return new Response(JSON.stringify({ token: `tok-${loginCalls}` }), { status: 200 });
        }
        if (url.endsWith("/user/history")) {
          historyCalls += 1;
          return new Response(JSON.stringify({}), { status: 401 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as typeof fetch;

      await expect(fetchHistoryWithSession(config, { fetchImpl, env: { PATH: "" } })).rejects.toThrow(
        PocketCastsAuthError,
      );
      expect(loginCalls).toBe(2);
      expect(historyCalls).toBe(2);
    });

    it("swallows a keychain delete failure during invalidation — the retry login still happens", async () => {
      const config = envConfig({ POCKETCASTS_EMAIL: "a@b.c", POCKETCASTS_PASSWORD: "pw" });
      const { fetchImpl, counts } = authFlipFetch();
      const execImpl: ExecImpl = async (argv) => {
        if (argv[1] === "find-generic-password") return { code: 44, stdout: "", stderr: "" };
        if (argv[1] === "delete-generic-password") {
          return { code: 1, stdout: "", stderr: "no such keychain item" };
        }
        return { code: 0, stdout: "", stderr: "" };
      };
      const episodes = await fetchHistoryWithSession(config, {
        fetchImpl,
        execImpl,
        env: { PATH: binDir },
        platform: "darwin",
      });
      expect(episodes).toEqual([]);
      expect(counts.login).toBe(2);
    });
  });

  describe("keychain token persistence", () => {
    it("writes the token to the keychain with the resolved service/account and -U on macOS", async () => {
      const { execImpl, calls } = createKeychainExec({});
      const config = envConfig({ POCKETCASTS_EMAIL: "a@b.c", POCKETCASTS_PASSWORD: "pw" });
      const { fetchImpl } = loginFetch();
      await fetchHistoryWithSession(config, {
        fetchImpl,
        execImpl,
        env: { PATH: binDir },
        platform: "darwin",
      });
      const writeCall = calls.find((c) => c[1] === "add-generic-password");
      expect(writeCall?.slice(0, 8)).toEqual([
        path.join(binDir, "security"),
        "add-generic-password",
        "-U",
        "-s",
        "castrecall",
        "-a",
        "pocketcasts-token",
        "-w",
      ]);
      const record = JSON.parse(writeCall![8]);
      expect(record.token).toBe("tok-1");
      expect(typeof record.expiresAt).toBe("number");
      expect(typeof record.credentialHash).toBe("string");
    });

    it("persists a verification-seeded cached token on the first real sync (skipTokenPersist)", async () => {
      const { execImpl, calls } = createKeychainExec({});
      const config = envConfig({ POCKETCASTS_EMAIL: "a@b.c", POCKETCASTS_PASSWORD: "pw" });
      const { fetchImpl, counts } = loginFetch();

      // Setup verification: logs in but must NOT write the token durably.
      await getPocketCastsToken(config, {
        fetchImpl,
        execImpl,
        env: { PATH: binDir },
        platform: "darwin",
        skipTokenPersist: true,
      });
      expect(counts.login).toBe(1);
      const tokenWrites = () =>
        calls.filter((c) => c[1] === "add-generic-password" && c.includes("pocketcasts-token"));
      expect(tokenWrites()).toHaveLength(0);

      // First real sync in the SAME process: hits the in-memory cache (no
      // second login) but must still persist the token durably, or a process
      // restart would force a fresh password login.
      await fetchHistoryWithSession(config, {
        fetchImpl,
        execImpl,
        env: { PATH: binDir },
        platform: "darwin",
      });
      expect(counts.login).toBe(1);
      expect(tokenWrites()).toHaveLength(1);

      // Restart: the durable record is reusable — still no new login.
      clearPocketCastsSessionCache();
      await fetchHistoryWithSession(config, {
        fetchImpl,
        execImpl,
        env: { PATH: binDir },
        platform: "darwin",
      });
      expect(counts.login).toBe(1);
    });

    it("a sync joining an in-flight verification login still persists the token durably", async () => {
      const { execImpl, calls } = createKeychainExec({});
      const config = envConfig({ POCKETCASTS_EMAIL: "a@b.c", POCKETCASTS_PASSWORD: "pw" });
      // A login endpoint that hangs until released, so both callers join one flight.
      let releaseLogin!: () => void;
      const gate = new Promise<void>((resolve) => (releaseLogin = resolve));
      const counts = { login: 0 };
      const fetchImpl = (async (input: unknown) => {
        const url = String(input);
        if (url.endsWith("/user/login")) {
          counts.login += 1;
          await gate;
          return new Response(JSON.stringify({ token: "tok-shared" }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as typeof fetch;
      const deps = { fetchImpl, execImpl, env: { PATH: binDir }, platform: "darwin" as const };

      // Verification starts the flight with skipTokenPersist...
      const verify = getPocketCastsToken(config, { ...deps, skipTokenPersist: true });
      // ...and a real sync joins the SAME flight before it resolves. Give the
      // joiner time to pass its (fast, local) credential/keychain awaits and
      // reach the flight map before the login gate opens.
      const sync = getPocketCastsToken(config, deps);
      await new Promise((resolve) => setTimeout(resolve, 50));
      releaseLogin();
      expect(await verify).toBe("tok-shared");
      expect(await sync).toBe("tok-shared");
      expect(counts.login).toBe(1); // single-flight held

      // The non-skip joiner upgraded the shared token to durable persistence.
      const tokenWrites = calls.filter(
        (c) => c[1] === "add-generic-password" && c.includes("pocketcasts-token"),
      );
      expect(tokenWrites).toHaveLength(1);
    });

    it("cache invalidation during the persistence await neither throws nor misdirects", async () => {
      const config = envConfig({ POCKETCASTS_EMAIL: "a@b.c", POCKETCASTS_PASSWORD: "pw" });
      const { fetchImpl } = loginFetch();
      // Keychain writes hang until released, so we can clear the cache mid-persist.
      let releaseWrite!: () => void;
      const writeGate = new Promise<void>((resolve) => (releaseWrite = resolve));
      let notifyWriteStarted!: () => void;
      const writeStarted = new Promise<void>((resolve) => (notifyWriteStarted = resolve));
      const store = new Map<string, string>();
      const execImpl: ExecImpl = async (argv) => {
        if (argv[1] === "find-generic-password") {
          const account = argv[argv.indexOf("-a") + 1];
          const value = store.get(account);
          return value === undefined
            ? { code: 44, stdout: "", stderr: "" }
            : { code: 0, stdout: `${value}\n`, stderr: "" };
        }
        if (argv[1] === "add-generic-password") {
          notifyWriteStarted();
          await writeGate;
          store.set(argv[argv.indexOf("-a") + 1], argv[argv.indexOf("-w") + 1]);
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      };
      const deps = { fetchImpl, execImpl, env: { PATH: binDir }, platform: "darwin" as const };

      // Seed an unpersisted cached token via verification (no keychain write attempted).
      await getPocketCastsToken(config, { ...deps, skipTokenPersist: true });

      // A real call enters the persistence await...
      const pending = getPocketCastsToken(config, deps);
      await writeStarted; // it is now inside the keychain write
      // ...and the cache is invalidated underneath it (as a 401 handler would).
      clearPocketCastsSessionCache();
      releaseWrite();
      // The captured entry keeps the call safe: original token, no throw.
      expect(await pending).toBe("tok-1");
    });

    it("a delayed persist can never resurrect a token that a 401 invalidation deleted", async () => {
      const config = envConfig({ POCKETCASTS_EMAIL: "a@b.c", POCKETCASTS_PASSWORD: "pw" });
      // login-1 → tok-1; first history call 401s (invalidating tok-1);
      // login-2 → tok-2; second history call succeeds.
      const counts = { login: 0, history: 0 };
      const fetchImpl = (async (input: unknown) => {
        const url = String(input);
        if (url.endsWith("/user/login")) {
          counts.login += 1;
          return new Response(JSON.stringify({ token: `tok-${counts.login}` }), { status: 200 });
        }
        if (url.endsWith("/user/history")) {
          counts.history += 1;
          return new Response(
            counts.history === 1 ? JSON.stringify({}) : JSON.stringify({ episodes: [] }),
            { status: counts.history === 1 ? 401 : 200 },
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as typeof fetch;
      // Keychain whose token writes hang until released, so the tok-1
      // persist is still in flight when the 401 invalidation arrives.
      let releaseWrite!: () => void;
      const writeGate = new Promise<void>((resolve) => (releaseWrite = resolve));
      let gated = true;
      const store = new Map<string, string>();
      const execImpl: ExecImpl = async (argv) => {
        if (argv[1] === "find-generic-password") {
          const value = store.get(argv[argv.indexOf("-a") + 1]);
          return value === undefined
            ? { code: 44, stdout: "", stderr: "" }
            : { code: 0, stdout: `${value}\n`, stderr: "" };
        }
        if (argv[1] === "add-generic-password") {
          if (gated) {
            gated = false; // only the first (tok-1) write is delayed
            await writeGate;
          }
          store.set(argv[argv.indexOf("-a") + 1], argv[argv.indexOf("-w") + 1]);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (argv[1] === "delete-generic-password") {
          store.delete(argv[argv.indexOf("-a") + 1]);
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      };
      const deps = { fetchImpl, execImpl, env: { PATH: binDir }, platform: "darwin" as const };

      // Seed the unpersisted tok-1 (verification), then start the delayed persist.
      await getPocketCastsToken(config, { ...deps, skipTokenPersist: true });
      const upgrading = getPocketCastsToken(config, deps); // enters gated tok-1 write
      // 401 flow: invalidation (serialized behind the in-flight write) +
      // forced re-login to tok-2, persisted.
      const syncing = fetchHistoryWithSession(config, deps);
      await new Promise((resolve) => setTimeout(resolve, 30));
      releaseWrite();
      await upgrading;
      await syncing;

      // The durable record must be tok-2 — the delayed tok-1 write must not
      // have survived past the invalidation's delete.
      const record = JSON.parse(store.get("pocketcasts-token") ?? "{}");
      expect(record.token).toBe("tok-2");
      expect(counts.login).toBe(2);
    });

    it("reuses a token record from the keychain across process-lifetime cache misses", async () => {
      const { execImpl, calls } = createKeychainExec({});
      const config = envConfig({ POCKETCASTS_EMAIL: "a@b.c", POCKETCASTS_PASSWORD: "pw" });
      const { fetchImpl, counts } = loginFetch();
      await fetchHistoryWithSession(config, {
        fetchImpl,
        execImpl,
        env: { PATH: binDir },
        platform: "darwin",
      });
      expect(counts.login).toBe(1);

      // Simulate a fresh process: clear the in-memory cache but keep the keychain store.
      clearPocketCastsSessionCache();
      await fetchHistoryWithSession(config, {
        fetchImpl,
        execImpl,
        env: { PATH: binDir },
        platform: "darwin",
      });
      expect(counts.login).toBe(1); // still 1 — the keychain token record was reused
      expect(calls.filter((c) => c[1] === "find-generic-password" && c.includes("pocketcasts-token")).length).toBe(2);
    });

    it("swallows a keychain write failure after a successful login — sync still succeeds", async () => {
      const config = envConfig({ POCKETCASTS_EMAIL: "a@b.c", POCKETCASTS_PASSWORD: "pw" });
      const { fetchImpl } = loginFetch();
      const execImpl: ExecImpl = async (argv) => {
        if (argv[1] === "find-generic-password") return { code: 44, stdout: "", stderr: "" };
        if (argv[1] === "add-generic-password") return { code: 1, stdout: "", stderr: "keychain locked" };
        return { code: 0, stdout: "", stderr: "" };
      };
      const episodes = await fetchHistoryWithSession(config, {
        fetchImpl,
        execImpl,
        env: { PATH: binDir },
        platform: "darwin",
      });
      expect(episodes).toEqual([]);
    });
  });

  it("CASTRECALL_DISABLE_KEYCHAIN=1 skips all keychain reads/writes yet still reuses the in-memory token", async () => {
    const calls: string[][] = [];
    const execImpl: ExecImpl = async (argv) => {
      calls.push(argv);
      throw new Error("execImpl should never be called when the keychain is disabled");
    };
    const config = envConfig({
      POCKETCASTS_EMAIL: "a@b.c",
      POCKETCASTS_PASSWORD: "pw",
      CASTRECALL_DISABLE_KEYCHAIN: "1",
    });
    const { fetchImpl, counts } = loginFetch();
    await fetchHistoryWithSession(config, { fetchImpl, execImpl, env: { PATH: binDir }, platform: "darwin" });
    await fetchHistoryWithSession(config, { fetchImpl, execImpl, env: { PATH: binDir }, platform: "darwin" });
    expect(calls).toHaveLength(0);
    expect(counts.login).toBe(1);
  });
});
