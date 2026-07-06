import { describe, expect, it } from "vitest";
import {
  CastrecallSetupError,
  requirePocketCastsCredentials,
  resolveConfig,
} from "./config.js";

describe("resolveConfig", () => {
  it("defaults to ~/.openclaw/castrecall with STT off", () => {
    const config = resolveConfig({}, {});
    expect(config.dataDir.endsWith("/.openclaw/castrecall")).toBe(true);
    expect(config.historyLimit).toBe(100);
    expect(config.stt.enabled).toBe(false);
    expect(config.stt.provider).toBe("assemblyai");
  });

  it("lets env vars override plugin settings", () => {
    const config = resolveConfig(
      { dataDir: "/from/settings", sttEnabled: false, sttProvider: "assemblyai" },
      {
        CASTRECALL_DATA_DIR: "/from/env",
        CASTRECALL_ENABLE_STT: "true",
        CASTRECALL_STT_PROVIDER: "openai",
        CASTRECALL_HISTORY_LIMIT: "25",
      },
    );
    expect(config.dataDir).toBe("/from/env");
    expect(config.stt.enabled).toBe(true);
    expect(config.stt.provider).toBe("openai");
    expect(config.historyLimit).toBe(25);
  });

  it("uses plugin settings when env is empty", () => {
    const config = resolveConfig({ dataDir: "/from/settings", historyLimit: 7 }, {});
    expect(config.dataDir).toBe("/from/settings");
    expect(config.historyLimit).toBe(7);
  });

  it("treats blank env credentials as unset", () => {
    const config = resolveConfig({}, { POCKETCASTS_EMAIL: "  ", POCKETCASTS_PASSWORD: "" });
    expect(config.pocketcasts.email).toBeUndefined();
    expect(config.pocketcasts.password).toBeUndefined();
  });

  it("leaves corpus export off (undefined) by default", () => {
    const config = resolveConfig({}, {});
    expect(config.exportDir).toBeUndefined();
  });

  it("lets CASTRECALL_EXPORT_DIR override the exportDir plugin setting", () => {
    const config = resolveConfig(
      { exportDir: "/from/settings" },
      { CASTRECALL_EXPORT_DIR: "/from/env" },
    );
    expect(config.exportDir).toBe("/from/env");
  });

  it("uses the exportDir plugin setting when the env var is unset", () => {
    const config = resolveConfig({ exportDir: "/from/settings" }, {});
    expect(config.exportDir).toBe("/from/settings");
  });

  it("defaults listenFilter to a 0.8 ratio, 300s floor, and recordUnknown off", () => {
    const config = resolveConfig({}, {});
    expect(config.listenFilter).toEqual({ minRatio: 0.8, minSeconds: 300, recordUnknown: false });
  });

  it("reads listenFilter knobs from the environment", () => {
    const config = resolveConfig(
      {},
      {
        CASTRECALL_MIN_LISTEN_RATIO: "0.5",
        CASTRECALL_MIN_LISTEN_SECONDS: "120",
        CASTRECALL_RECORD_UNKNOWN_LISTENS: "1",
      },
    );
    expect(config.listenFilter).toEqual({ minRatio: 0.5, minSeconds: 120, recordUnknown: true });
  });

  it("falls back to listenFilter defaults on invalid or out-of-range env values", () => {
    const config = resolveConfig(
      {},
      {
        CASTRECALL_MIN_LISTEN_RATIO: "abc",
        CASTRECALL_MIN_LISTEN_SECONDS: "0",
        CASTRECALL_RECORD_UNKNOWN_LISTENS: "",
      },
    );
    expect(config.listenFilter).toEqual({ minRatio: 0.8, minSeconds: 300, recordUnknown: false });

    const overRatio = resolveConfig({}, { CASTRECALL_MIN_LISTEN_RATIO: "2" });
    expect(overRatio.listenFilter.minRatio).toBe(0.8);
  });
});

describe("requirePocketCastsCredentials", () => {
  it("throws an actionable, secret-free error when credentials are missing", () => {
    const config = resolveConfig({}, {});
    expect(() => requirePocketCastsCredentials(config)).toThrowError(CastrecallSetupError);
    expect(() => requirePocketCastsCredentials(config)).toThrowError(/POCKETCASTS_EMAIL/);
  });

  it("returns credentials when both are set", () => {
    const config = resolveConfig(
      {},
      { POCKETCASTS_EMAIL: "a@b.c", POCKETCASTS_PASSWORD: "hunter2" },
    );
    expect(requirePocketCastsCredentials(config)).toEqual({
      email: "a@b.c",
      password: "hunter2",
    });
  });
});
