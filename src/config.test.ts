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
