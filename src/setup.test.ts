import { describe, expect, it } from "vitest";
import { resolveConfig } from "./config.js";
import { buildSetupPlan, classifyExportDir, detectGbrain, PRIVACY_DEFAULTS } from "./setup.js";
import type { WhisperDetection } from "./transcripts/local-whisper.js";

const NO_WHISPER: WhisperDetection = { reason: "No local Whisper CLI detected on PATH." };
const WITH_WHISPER: WhisperDetection = {
  detected: { flavor: "whisper.cpp", command: "/usr/local/bin/whisper-cli" },
};
const NO_GBRAIN = { detected: false as const, reason: "No ~/.gbrain directory found." };
const WITH_GBRAIN = {
  detected: true as const,
  suggestedExportDir: "/home/user/.gbrain/inbox",
};

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

describe("buildSetupPlan", () => {
  it("orders steps and includes both Pocket Casts caveats when nothing is configured", () => {
    const steps = buildSetupPlan(config({}), { whisper: NO_WHISPER, gbrain: NO_GBRAIN });
    expect(steps.map((s) => s.id)).toEqual([
      "pocketcasts",
      "storage",
      "privacy",
      "providers.taddy",
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
    const steps = buildSetupPlan(
      config({ POCKETCASTS_EMAIL: "a@b.c", POCKETCASTS_PASSWORD: "pw" }),
      { whisper: NO_WHISPER, gbrain: NO_GBRAIN },
    );
    expect(steps.find((s) => s.id === "pocketcasts")!.status).toBe("configured");
  });

  it("flips the taddy step to configured only when both env vars are set", () => {
    const partial = buildSetupPlan(config({ TADDY_API_KEY: "k" }), {
      whisper: NO_WHISPER,
      gbrain: NO_GBRAIN,
    });
    expect(partial.find((s) => s.id === "providers.taddy")!.status).toBe("optional-off");

    const full = buildSetupPlan(config({ TADDY_API_KEY: "k", TADDY_USER_ID: "u" }), {
      whisper: NO_WHISPER,
      gbrain: NO_GBRAIN,
    });
    expect(full.find((s) => s.id === "providers.taddy")!.status).toBe("configured");
  });

  it("reflects an injected WhisperDetection for the localWhisper step", () => {
    const detected = buildSetupPlan(config({}), { whisper: WITH_WHISPER, gbrain: NO_GBRAIN });
    const step = detected.find((s) => s.id === "providers.localWhisper")!;
    expect(step.status).toBe("configured");
    expect(step.explanation).toContain("whisper.cpp");

    const missing = buildSetupPlan(config({}), { whisper: NO_WHISPER, gbrain: NO_GBRAIN });
    expect(missing.find((s) => s.id === "providers.localWhisper")!.status).toBe("optional-off");
  });

  it("flips the stt step to configured only once enabled and a provider key is set", () => {
    const off = buildSetupPlan(config({}), { whisper: NO_WHISPER, gbrain: NO_GBRAIN });
    expect(off.find((s) => s.id === "providers.stt")!.status).toBe("optional-off");

    const on = buildSetupPlan(
      config({ CASTRECALL_ENABLE_STT: "true", ASSEMBLYAI_API_KEY: "key" }),
      { whisper: NO_WHISPER, gbrain: NO_GBRAIN },
    );
    expect(on.find((s) => s.id === "providers.stt")!.status).toBe("configured");
  });

  it("surfaces a detected gbrain inbox suggestion when export is unset", () => {
    const steps = buildSetupPlan(config({}), { whisper: NO_WHISPER, gbrain: WITH_GBRAIN });
    const exportStep = steps.find((s) => s.id === "export")!;
    expect(exportStep.status).toBe("optional-off");
    expect(exportStep.explanation).toContain("/home/user/.gbrain/inbox");
  });

  it("has no suggestion (only a reason) when no gbrain install is detected", () => {
    const steps = buildSetupPlan(config({}), { whisper: NO_WHISPER, gbrain: NO_GBRAIN });
    const exportStep = steps.find((s) => s.id === "export")!;
    expect(exportStep.explanation).not.toContain("suggested");
    expect(exportStep.explanation).toContain(NO_GBRAIN.reason);
  });

  it("reports export as configured with the correct mode when CASTRECALL_EXPORT_DIR is set", () => {
    const steps = buildSetupPlan(config({ CASTRECALL_EXPORT_DIR: "/home/user/.gbrain/inbox" }), {
      whisper: NO_WHISPER,
      gbrain: NO_GBRAIN,
    });
    const exportStep = steps.find((s) => s.id === "export")!;
    expect(exportStep.status).toBe("configured");
    expect(exportStep.explanation).toContain("gbrain-inbox");
  });

  it("never includes secret values anywhere in the plan", () => {
    const steps = buildSetupPlan(
      config({ POCKETCASTS_EMAIL: "secret@example.com", POCKETCASTS_PASSWORD: "hunter2" }),
      { whisper: NO_WHISPER, gbrain: NO_GBRAIN },
    );
    const serialized = JSON.stringify(steps);
    expect(serialized).not.toContain("secret@example.com");
    expect(serialized).not.toContain("hunter2");
  });
});

describe("PRIVACY_DEFAULTS", () => {
  it("states export is off by default and memory is never durable", () => {
    expect(PRIVACY_DEFAULTS.exportDefault).toContain("off");
    expect(PRIVACY_DEFAULTS.durableMemory).toContain("never");
  });
});
