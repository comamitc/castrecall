import { describe, expect, it } from "vitest";
import { resolveConfig } from "./config.js";
import { buildSetupPlan, classifyExportDir, detectGbrain, PRIVACY_DEFAULTS } from "./setup.js";
import type { WhisperDetection } from "./transcripts/local-whisper.js";

const NO_WHISPER: WhisperDetection = { reason: "No local Whisper CLI detected on PATH." };
const WITH_WHISPER: WhisperDetection = {
  detected: { flavor: "openai-whisper", command: "/usr/local/bin/whisper" },
};
const WITH_WHISPER_CPP_NO_MODEL: WhisperDetection = {
  detected: { flavor: "whisper.cpp", command: "/usr/local/bin/whisper-cli" },
};
const NO_GBRAIN = { detected: false as const, reason: "No ~/.gbrain directory found." };
const WITH_GBRAIN = {
  detected: true as const,
  suggestedExportDir: "/home/user/.gbrain/inbox",
};
const NO_CREDENTIALS = { source: "none" as const, configured: false };
const ENV_CREDENTIALS = { source: "env" as const, configured: true };
const KEYCHAIN_CREDENTIALS = { source: "keychain" as const, configured: true };
const NO_BACKEND = { available: false };
const MACOS_BACKEND = { available: true, kind: "macos-keychain" as const };
const LIBSECRET_BACKEND = { available: true, kind: "libsecret" as const };

function config(env: NodeJS.ProcessEnv = {}) {
  return resolveConfig({}, env);
}

describe("detectGbrain", () => {
  it("suggests an export dir ending in .gbrain/inbox when ~/.gbrain exists", async () => {
    const result = await detectGbrain({
      homedir: () => "/home/user",
      access: async () => undefined,
    });
    expect(result.detected).toBe(true);
    expect(result.suggestedExportDir).toBe("/home/user/.gbrain/inbox");
  });

  it("reports not detected with a reason when ~/.gbrain does not exist", async () => {
    const result = await detectGbrain({
      homedir: () => "/home/user",
      access: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(result.detected).toBe(false);
    expect(result.suggestedExportDir).toBeUndefined();
    expect(result.reason).toContain("~/.gbrain");
  });

  it("detects gbrain via CASTRECALL_GBRAIN_INSTALLED even when ~/.gbrain is absent", async () => {
    const result = await detectGbrain({
      homedir: () => "/home/user",
      access: async () => {
        throw new Error("ENOENT");
      },
      env: { CASTRECALL_GBRAIN_INSTALLED: "1" },
    });
    expect(result.detected).toBe(true);
    expect(result.suggestedExportDir).toBe("/home/user/.gbrain/inbox");
  });

  it("ignores a falsy CASTRECALL_GBRAIN_INSTALLED and falls back to the directory check", async () => {
    const result = await detectGbrain({
      homedir: () => "/home/user",
      access: async () => {
        throw new Error("ENOENT");
      },
      env: { CASTRECALL_GBRAIN_INSTALLED: "0" },
    });
    expect(result.detected).toBe(false);
  });

  it("defaults to the real filesystem and homedir when no deps are injected", async () => {
    // No injected access/homedir: exercises the real fs.access path. This machine's home
    // directory almost certainly has no ~/.gbrain, so we only assert the shape is well-formed
    // — the point is that calling with zero deps does not throw.
    const result = await detectGbrain();
    expect(typeof result.detected).toBe("boolean");
  });
});

describe("classifyExportDir", () => {
  it("is off when unset", () => {
    expect(classifyExportDir(undefined)).toEqual({ exportDir: null, mode: "off" });
  });

  it("classifies a .gbrain/inbox path as gbrain-inbox", () => {
    expect(classifyExportDir("/home/user/.gbrain/inbox")).toEqual({
      exportDir: "/home/user/.gbrain/inbox",
      mode: "gbrain-inbox",
    });
  });

  it("classifies any other path as custom", () => {
    expect(classifyExportDir("/home/user/brain/sources")).toEqual({
      exportDir: "/home/user/brain/sources",
      mode: "custom",
    });
  });
});

function plan(
  cfg: ReturnType<typeof config>,
  overrides: Partial<Parameters<typeof buildSetupPlan>[1]> = {},
) {
  return buildSetupPlan(cfg, {
    whisper: NO_WHISPER,
    gbrain: NO_GBRAIN,
    credentials: NO_CREDENTIALS,
    secretBackend: NO_BACKEND,
    ...overrides,
  });
}

describe("buildSetupPlan", () => {
  it("orders steps and includes both Pocket Casts caveats when nothing is configured", () => {
    const steps = plan(config({}));
    expect(steps.map((s) => s.id)).toEqual([
      "pocketcasts",
      "storage",
      "privacy",
      "providers.taddy",
      "providers.podchaser",
      "providers.localWhisper",
      "providers.stt",
      "export",
    ]);
    const pocketcasts = steps.find((s) => s.id === "pocketcasts")!;
    expect(pocketcasts.status).toBe("missing");
    expect(pocketcasts.explanation).toContain("Read-only");
    expect(pocketcasts.caveat).toContain("Unofficial API");
    expect(pocketcasts.caveat).toContain("Sign in with Google/Apple");
  });

  it("flips pocketcasts to configured when both credentials are set", () => {
    const steps = plan(config({ POCKETCASTS_EMAIL: "a@b.c", POCKETCASTS_PASSWORD: "pw" }), {
      credentials: ENV_CREDENTIALS,
    });
    expect(steps.find((s) => s.id === "pocketcasts")!.status).toBe("configured");
  });

  it("flips the taddy step to configured only when both env vars are set", () => {
    const partial = plan(config({ TADDY_API_KEY: "k" }));
    expect(partial.find((s) => s.id === "providers.taddy")!.status).toBe("optional-off");

    const full = plan(config({ TADDY_API_KEY: "k", TADDY_USER_ID: "u" }));
    expect(full.find((s) => s.id === "providers.taddy")!.status).toBe("configured");
  });

  it("flips the podchaser step to configured only when PODCHASER_API_KEY is set", () => {
    const off = plan(config({}));
    expect(off.find((s) => s.id === "providers.podchaser")!.status).toBe("optional-off");

    const on = plan(config({ PODCHASER_API_KEY: "pk_x" }));
    expect(on.find((s) => s.id === "providers.podchaser")!.status).toBe("configured");
  });

  it("reflects an injected WhisperDetection for the localWhisper step", () => {
    const detected = plan(config({}), { whisper: WITH_WHISPER });
    const step = detected.find((s) => s.id === "providers.localWhisper")!;
    expect(step.status).toBe("configured");
    expect(step.explanation).toContain("openai-whisper");

    const missing = plan(config({}));
    expect(missing.find((s) => s.id === "providers.localWhisper")!.status).toBe("optional-off");
  });

  it("does not mark whisper.cpp ready until CASTRECALL_WHISPER_MODEL is set", () => {
    const noModel = plan(config({}), { whisper: WITH_WHISPER_CPP_NO_MODEL });
    const noModelStep = noModel.find((s) => s.id === "providers.localWhisper")!;
    expect(noModelStep.status).toBe("optional-off");
    expect(noModelStep.explanation).toContain("CASTRECALL_WHISPER_MODEL");

    const withModel = plan(config({ CASTRECALL_WHISPER_MODEL: "/models/ggml-base.bin" }), {
      whisper: WITH_WHISPER_CPP_NO_MODEL,
    });
    const withModelStep = withModel.find((s) => s.id === "providers.localWhisper")!;
    expect(withModelStep.status).toBe("configured");
    expect(withModelStep.explanation).toContain("whisper.cpp");
  });

  it("flips the stt step to configured only once enabled and a provider key is set", () => {
    const off = plan(config({}));
    expect(off.find((s) => s.id === "providers.stt")!.status).toBe("optional-off");

    const on = plan(config({ CASTRECALL_ENABLE_STT: "true", ASSEMBLYAI_API_KEY: "key" }));
    expect(on.find((s) => s.id === "providers.stt")!.status).toBe("configured");
  });

  it("flips the stt step to configured for deepgram once enabled and keyed", () => {
    const step = plan(
      config({
        CASTRECALL_ENABLE_STT: "true",
        CASTRECALL_STT_PROVIDER: "deepgram",
        DEEPGRAM_API_KEY: "key",
      }),
    ).find((s) => s.id === "providers.stt")!;
    expect(step.status).toBe("configured");
    expect(step.envVars).toContain("DEEPGRAM_API_KEY");
    expect(step.envVars).toContain("CASTRECALL_DEEPGRAM_STT_MODEL");
  });

  it("surfaces a detected gbrain inbox suggestion when export is unset", () => {
    const steps = plan(config({}), { gbrain: WITH_GBRAIN });
    const exportStep = steps.find((s) => s.id === "export")!;
    expect(exportStep.status).toBe("optional-off");
    expect(exportStep.explanation).toContain("/home/user/.gbrain/inbox");
  });

  it("has no suggestion (only a reason) when no gbrain install is detected", () => {
    const steps = plan(config({}));
    const exportStep = steps.find((s) => s.id === "export")!;
    expect(exportStep.explanation).not.toContain("suggested");
    expect(exportStep.explanation).toContain(NO_GBRAIN.reason);
  });

  it("reports export as configured with the correct mode when CASTRECALL_EXPORT_DIR is set", () => {
    const steps = plan(config({ CASTRECALL_EXPORT_DIR: "/home/user/.gbrain/inbox" }));
    const exportStep = steps.find((s) => s.id === "export")!;
    expect(exportStep.status).toBe("configured");
    expect(exportStep.explanation).toContain("gbrain-inbox");
  });

  it("never includes secret values anywhere in the plan", () => {
    const steps = plan(config({ POCKETCASTS_EMAIL: "secret@example.com", POCKETCASTS_PASSWORD: "hunter2" }), {
      credentials: ENV_CREDENTIALS,
    });
    const serialized = JSON.stringify(steps);
    expect(serialized).not.toContain("secret@example.com");
    expect(serialized).not.toContain("hunter2");
  });

  it("keeps today's env-only guidance when no secret backend is available", () => {
    const steps = plan(config({}));
    const pocketcasts = steps.find((s) => s.id === "pocketcasts")!;
    expect(pocketcasts.explanation).not.toContain("security add-generic-password");
    expect(pocketcasts.explanation).not.toContain("secret-tool store");
  });

  it("recommends the macOS keychain store recipe when a macos-keychain backend is available", () => {
    const steps = plan(config({}), { secretBackend: MACOS_BACKEND });
    const pocketcasts = steps.find((s) => s.id === "pocketcasts")!;
    expect(pocketcasts.explanation).toContain("security add-generic-password");
    expect(pocketcasts.explanation).toContain("fallback");
  });

  it("recommends the secret-tool store recipe when a libsecret backend is available", () => {
    const steps = plan(config({}), { secretBackend: LIBSECRET_BACKEND });
    const pocketcasts = steps.find((s) => s.id === "pocketcasts")!;
    expect(pocketcasts.explanation).toContain("secret-tool store");
    expect(pocketcasts.explanation).toContain("fallback");
  });

  it("notes credentials are currently sourced from the keychain when applicable", () => {
    const steps = plan(config({}), { credentials: KEYCHAIN_CREDENTIALS, secretBackend: MACOS_BACKEND });
    const pocketcasts = steps.find((s) => s.id === "pocketcasts")!;
    expect(pocketcasts.status).toBe("configured");
    expect(pocketcasts.explanation).toContain("OS keychain");
  });
});

describe("PRIVACY_DEFAULTS", () => {
  it("states export is off by default and memory is never durable", () => {
    expect(PRIVACY_DEFAULTS.exportDefault).toContain("off");
    expect(PRIVACY_DEFAULTS.durableMemory).toContain("never");
  });
});
