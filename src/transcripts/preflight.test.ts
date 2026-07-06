import { describe, expect, it } from "vitest";
import { resolveConfig } from "../config.js";
import {
  buildTranscriptionPreflight,
  classifyWhisperModelQuality,
  CORPUS_SCALE_MIN_EPISODES,
  estimateRuntimeClass,
} from "./preflight.js";
import { resolveWhisperModel, type WhisperDetection } from "./local-whisper.js";

function config(env: NodeJS.ProcessEnv = {}) {
  return resolveConfig({}, env);
}

const NO_WHISPER: WhisperDetection = { reason: "No local Whisper CLI detected on PATH." };
const MLX_DETECTED: WhisperDetection = {
  detected: { flavor: "mlx-whisper", command: "/usr/local/bin/mlx_whisper" },
};
const WHISPER_CPP_DETECTED: WhisperDetection = {
  detected: { flavor: "whisper.cpp", command: "/usr/local/bin/whisper-cli" },
};
const CUSTOM_DETECTED: WhisperDetection = {
  detected: { flavor: "custom", command: "my-whisper {input}" },
};

describe("classifyWhisperModelQuality", () => {
  it("approves preset best/balanced (resolves to large-v3-turbo)", () => {
    const best = resolveWhisperModel("mlx-whisper", { preset: "best" });
    const balanced = resolveWhisperModel("mlx-whisper", { preset: "balanced" });
    expect(classifyWhisperModelQuality("mlx-whisper", best)).toBe("approved");
    expect(classifyWhisperModelQuality("mlx-whisper", balanced)).toBe("approved");
  });

  it("approves an explicit large-v3-turbo family model", () => {
    const resolved = resolveWhisperModel("openai-whisper", { model: "large-v3-turbo" });
    expect(classifyWhisperModelQuality("openai-whisper", resolved)).toBe("approved");
  });

  it("marks preset fast (resolves to small-mlx) as low-quality", () => {
    const resolved = resolveWhisperModel("mlx-whisper", { preset: "fast" });
    expect(classifyWhisperModelQuality("mlx-whisper", resolved)).toBe("low-quality");
  });

  it.each(["tiny", "tiny.en", "ggml-base.en.bin", "whisper-small"])(
    "marks explicit model %s as low-quality",
    (model) => {
      const resolved = resolveWhisperModel("whisper.cpp", { model });
      expect(classifyWhisperModelQuality("whisper.cpp", resolved)).toBe("low-quality");
    },
  );

  it("marks mlx-whisper's backend default (no model, no preset) as low-quality", () => {
    const resolved = resolveWhisperModel("mlx-whisper", {});
    expect(classifyWhisperModelQuality("mlx-whisper", resolved)).toBe("low-quality");
  });

  it("marks an unrecognized explicit model as unknown, never a wrong approved", () => {
    const resolved = resolveWhisperModel("openai-whisper", { model: "some-community-finetune" });
    expect(classifyWhisperModelQuality("openai-whisper", resolved)).toBe("unknown");
  });

  it("marks a custom command with no explicit model as unknown", () => {
    const resolved = resolveWhisperModel("custom", {});
    expect(classifyWhisperModelQuality("custom", resolved)).toBe("unknown");
  });

  it("marks another backend's un-pinned default (whisper.cpp, no model) as unknown, not low-quality", () => {
    const resolved = resolveWhisperModel("whisper.cpp", {});
    expect(classifyWhisperModelQuality("whisper.cpp", resolved)).toBe("unknown");
  });
});

describe("estimateRuntimeClass", () => {
  it("is unknown with no backend detected", () => {
    expect(estimateRuntimeClass(10, null).runtimeClass).toContain("unknown");
  });

  it("is none with zero episodes pending", () => {
    expect(estimateRuntimeClass(0, "mlx-whisper").runtimeClass).toContain("none");
  });

  it("scales up through buckets as pending count grows", () => {
    const small = estimateRuntimeClass(CORPUS_SCALE_MIN_EPISODES - 1, "mlx-whisper").runtimeClass;
    const medium = estimateRuntimeClass(CORPUS_SCALE_MIN_EPISODES, "mlx-whisper").runtimeClass;
    const large = estimateRuntimeClass(25, "mlx-whisper").runtimeClass;
    expect(new Set([small, medium, large]).size).toBe(3);
  });

  it("always carries a rough-estimate caveat", () => {
    expect(estimateRuntimeClass(10, "mlx-whisper").runtimeCaveat).toMatch(/rough/i);
  });
});

describe("buildTranscriptionPreflight", () => {
  it("blocks a corpus-scale run with preset=fast (ready, low-quality, no opt-in)", () => {
    const result = buildTranscriptionPreflight({
      config: config({ CASTRECALL_LOCAL_WHISPER_PRESET: "fast" }),
      whisper: MLX_DETECTED,
      episodesPendingTranscript: CORPUS_SCALE_MIN_EPISODES,
    });
    expect(result).toMatchObject({
      blocked: true,
      quality: "low-quality",
      ready: true,
      corpusScale: true,
      lowQualityOptIn: false,
    });
    expect(result.remediation).toBeDefined();
    expect(result.remediation!.join(" ")).toContain("CASTRECALL_WHISPER_ALLOW_LOW_QUALITY");
    expect(result.remediation!.join(" ")).toContain("CASTRECALL_LOCAL_WHISPER_PRESET=best");
    expect(result.reason).toBeDefined();
  });

  it("does not block the same config below the corpus-scale threshold (single-episode test run)", () => {
    const result = buildTranscriptionPreflight({
      config: config({ CASTRECALL_LOCAL_WHISPER_PRESET: "fast" }),
      whisper: MLX_DETECTED,
      episodesPendingTranscript: 1,
    });
    expect(result.blocked).toBe(false);
    expect(result.corpusScale).toBe(false);
  });

  it("does not block a corpus-scale run once CASTRECALL_WHISPER_ALLOW_LOW_QUALITY opts in", () => {
    const result = buildTranscriptionPreflight({
      config: config({
        CASTRECALL_LOCAL_WHISPER_PRESET: "fast",
        CASTRECALL_WHISPER_ALLOW_LOW_QUALITY: "true",
      }),
      whisper: MLX_DETECTED,
      episodesPendingTranscript: CORPUS_SCALE_MIN_EPISODES,
    });
    expect(result.blocked).toBe(false);
    expect(result.lowQualityOptIn).toBe(true);
  });

  it("does not double-block an mlx config with no model/preset — the ladder already skips it (reported, not blocked)", () => {
    const result = buildTranscriptionPreflight({
      config: config({}),
      whisper: MLX_DETECTED,
      episodesPendingTranscript: CORPUS_SCALE_MIN_EPISODES,
    });
    expect(result.blocked).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.readinessReason).toContain("CASTRECALL_WHISPER_MODEL");
    expect(result.corpusScale).toBe(true);
  });

  it("never blocks an unknown-quality config (custom command, corpus-scale)", () => {
    const result = buildTranscriptionPreflight({
      config: config({}),
      whisper: CUSTOM_DETECTED,
      episodesPendingTranscript: CORPUS_SCALE_MIN_EPISODES,
    });
    expect(result.quality).toBe("unknown");
    expect(result.blocked).toBe(false);
  });

  it("never blocks an approved-quality config (preset=best, corpus-scale)", () => {
    const result = buildTranscriptionPreflight({
      config: config({ CASTRECALL_LOCAL_WHISPER_PRESET: "best" }),
      whisper: MLX_DETECTED,
      episodesPendingTranscript: CORPUS_SCALE_MIN_EPISODES,
    });
    expect(result.quality).toBe("approved");
    expect(result.blocked).toBe(false);
  });

  it("reports backend null and runtimeClass unknown with no local Whisper CLI detected", () => {
    const result = buildTranscriptionPreflight({
      config: config({}),
      whisper: NO_WHISPER,
      episodesPendingTranscript: CORPUS_SCALE_MIN_EPISODES,
    });
    expect(result.backend).toBeNull();
    expect(result.model).toBeNull();
    expect(result.blocked).toBe(false);
    expect(result.runtimeClass).toContain("unknown");
  });

  it("reports zero pending episodes as not corpus-scale even with a low-quality config", () => {
    const result = buildTranscriptionPreflight({
      config: config({ CASTRECALL_LOCAL_WHISPER_PRESET: "fast" }),
      whisper: MLX_DETECTED,
      episodesPendingTranscript: 0,
    });
    expect(result.corpusScale).toBe(false);
    expect(result.blocked).toBe(false);
  });

  it("derives timestamps.segments from a non-txt output format and timestamps.words from applied word timestamps", () => {
    const result = buildTranscriptionPreflight({
      config: config({
        CASTRECALL_WHISPER_MODEL: "/path/to/ggml.bin",
        CASTRECALL_WHISPER_OUTPUT_FORMAT: "json",
        CASTRECALL_WHISPER_WORD_TIMESTAMPS: "true",
      }),
      whisper: WHISPER_CPP_DETECTED,
      episodesPendingTranscript: 1,
    });
    expect(result.timestamps).toEqual({ segments: true, words: true });
  });

  it("reports timestamps as false/false for the default txt output format", () => {
    const result = buildTranscriptionPreflight({
      config: config({ CASTRECALL_WHISPER_MODEL: "/path/to/ggml.bin" }),
      whisper: WHISPER_CPP_DETECTED,
      episodesPendingTranscript: 1,
    });
    expect(result.timestamps).toEqual({ segments: false, words: false });
  });

  it("always reports audio retention as temporary", () => {
    const result = buildTranscriptionPreflight({
      config: config({}),
      whisper: MLX_DETECTED,
      episodesPendingTranscript: 1,
    });
    expect(result.audioRetention).toBe("temporary");
  });

  it("surfaces lowQualityOptIn straight from CASTRECALL_WHISPER_ALLOW_LOW_QUALITY regardless of blocking", () => {
    const result = buildTranscriptionPreflight({
      config: config({ CASTRECALL_WHISPER_ALLOW_LOW_QUALITY: "true" }),
      whisper: NO_WHISPER,
      episodesPendingTranscript: 1,
    });
    expect(result.lowQualityOptIn).toBe(true);
  });
});
