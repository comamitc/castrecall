import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig, type WhisperDecodeConfig } from "../config.js";
import {
  WHISPER_PRESET_NON_MLX_MESSAGE,
  WHISPER_PRESET_UNKNOWN_MESSAGE,
  detectLocalWhisper,
  findOnPath,
  localWhisperReadiness,
  resolveWhisperDecodeArgs,
  resolveWhisperModel,
  transcribeWithLocalWhisper,
  type WhisperDetection,
} from "./local-whisper.js";

const DEFAULT_DECODE: WhisperDecodeConfig = {
  conditionOnPreviousText: false,
  outputFormat: "txt",
};

describe("detectLocalWhisper", () => {
  let binDir: string;

  beforeEach(async () => {
    binDir = await fs.mkdtemp(path.join(os.tmpdir(), "castrecall-bin-"));
  });

  afterEach(async () => {
    await fs.rm(binDir, { recursive: true, force: true });
  });

  it("reports disabled when CASTRECALL_DISABLE_LOCAL_WHISPER is set", async () => {
    const config = resolveConfig({}, { CASTRECALL_DISABLE_LOCAL_WHISPER: "true" });
    const detection = await detectLocalWhisper(config, { PATH: binDir });
    expect(detection.detected).toBeUndefined();
    expect(detection.reason).toContain("CASTRECALL_DISABLE_LOCAL_WHISPER");
  });

  it("uses a custom command when it has an {input} placeholder", async () => {
    const config = resolveConfig({}, { CASTRECALL_WHISPER_COMMAND: "my-whisper {input}" });
    const detection = await detectLocalWhisper(config, { PATH: "" });
    expect(detection.detected).toEqual({ flavor: "custom", command: "my-whisper {input}" });
  });

  it("rejects a custom command without {input}", async () => {
    const config = resolveConfig({}, { CASTRECALL_WHISPER_COMMAND: "my-whisper" });
    const detection = await detectLocalWhisper(config, { PATH: "" });
    expect(detection.reason).toContain("{input}");
  });

  it("detects a whisper.cpp binary on PATH", async () => {
    const binary = path.join(binDir, "whisper-cli");
    await fs.writeFile(binary, "#!/bin/sh\n", { mode: 0o755 });
    const config = resolveConfig({}, {});
    const detection = await detectLocalWhisper(config, { PATH: binDir });
    expect(detection.detected).toEqual({ flavor: "whisper.cpp", command: binary });
  });

  it("gives install hints when nothing is detected", async () => {
    const config = resolveConfig({}, {});
    const detection = await detectLocalWhisper(config, { PATH: binDir });
    expect(detection.reason).toContain("whisper-cli");
    expect(detection.reason).toContain("brew install whisper-cpp");
    expect(detection.reason).toContain("CASTRECALL_WHISPER_COMMAND");
  });
});

describe("findOnPath", () => {
  it("only matches executable regular files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "castrecall-path-"));
    try {
      await fs.writeFile(path.join(dir, "not-executable"), "", { mode: 0o644 });
      await fs.mkdir(path.join(dir, "whisper")); // directory with a binary's name
      expect(await findOnPath("not-executable", dir)).toBeUndefined();
      expect(await findOnPath("whisper", dir)).toBeUndefined();
      await fs.writeFile(path.join(dir, "whisper-cli"), "#!/bin/sh\n", { mode: 0o755 });
      expect(await findOnPath("whisper-cli", dir)).toBe(path.join(dir, "whisper-cli"));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveWhisperModel", () => {
  it("resolves best to the #51-approved large-v3-turbo model", () => {
    expect(resolveWhisperModel("mlx-whisper", { preset: "best" })).toEqual({
      model: "mlx-community/whisper-large-v3-turbo",
      source: "preset",
      preset: "best",
    });
  });

  it("resolves balanced and fast to concrete mlx-community models", () => {
    expect(resolveWhisperModel("mlx-whisper", { preset: "balanced" })).toMatchObject({
      model: "mlx-community/whisper-large-v3-turbo",
      source: "preset",
    });
    expect(resolveWhisperModel("mlx-whisper", { preset: "fast" })).toMatchObject({
      model: "mlx-community/whisper-small-mlx",
      source: "preset",
    });
  });

  it("lets an explicit CASTRECALL_WHISPER_MODEL override the preset", () => {
    expect(
      resolveWhisperModel("mlx-whisper", { model: "custom/model", preset: "best" }),
    ).toEqual({ model: "custom/model", source: "explicit" });
  });

  it("reports an unknown preset with a reason naming valid values", () => {
    const result = resolveWhisperModel("mlx-whisper", { preset: "bogus" });
    expect(result.model).toBeUndefined();
    expect(result.reason).toBe(WHISPER_PRESET_UNKNOWN_MESSAGE);
    expect(result.reason).toContain("fast");
    expect(result.reason).toContain("balanced");
    expect(result.reason).toContain("best");
  });

  it("rejects a known preset for non-mlx flavors (whisper.cpp, whisper-ctranslate2)", () => {
    const cpp = resolveWhisperModel("whisper.cpp", { preset: "best" });
    expect(cpp.model).toBeUndefined();
    expect(cpp.reason).toBe(WHISPER_PRESET_NON_MLX_MESSAGE);

    const ctranslate2 = resolveWhisperModel("whisper-ctranslate2", { preset: "best" });
    expect(ctranslate2.model).toBeUndefined();
    expect(ctranslate2.reason).toBe(WHISPER_PRESET_NON_MLX_MESSAGE);
  });

  it("returns source none with no model and no reason when nothing is set", () => {
    expect(resolveWhisperModel("mlx-whisper", {})).toEqual({ source: "none" });
  });

  it("does not error for the custom flavor even with a preset set (explicit user override)", () => {
    const result = resolveWhisperModel("custom", { preset: "best" });
    expect(result).toEqual({ source: "none", preset: "best" });
    expect(result.reason).toBeUndefined();
  });
});

describe("resolveWhisperDecodeArgs", () => {
  it("defaults to disabling condition-on-previous-text (loop prevention) with no other flags", () => {
    const mlx = resolveWhisperDecodeArgs("mlx-whisper", DEFAULT_DECODE);
    expect(mlx.args).toEqual(["--condition-on-previous-text", "False"]);
    expect(mlx.applied).toEqual(["conditionOnPreviousText"]);
    expect(mlx.ignored).toEqual([]);
    expect(mlx.outputFormat).toBe("txt");

    const cpp = resolveWhisperDecodeArgs("whisper.cpp", DEFAULT_DECODE);
    expect(cpp.args).toEqual(["-mc", "0"]);

    const openai = resolveWhisperDecodeArgs("openai-whisper", DEFAULT_DECODE);
    expect(openai.args).toEqual(["--condition_on_previous_text", "False"]);
  });

  it("maps language and thresholds to the right per-flavor flag spelling", () => {
    const decode: WhisperDecodeConfig = {
      ...DEFAULT_DECODE,
      language: "en",
      noSpeechThreshold: 0.6,
    };
    const mlx = resolveWhisperDecodeArgs("mlx-whisper", decode);
    expect(mlx.args).toEqual(
      expect.arrayContaining(["--language", "en", "--no-speech-threshold", "0.6"]),
    );
    expect(mlx.applied).toEqual(
      expect.arrayContaining(["language", "conditionOnPreviousText", "noSpeechThreshold"]),
    );

    const cpp = resolveWhisperDecodeArgs("whisper.cpp", decode);
    expect(cpp.args).toEqual(expect.arrayContaining(["-l", "en", "-nth", "0.6"]));

    const openai = resolveWhisperDecodeArgs("openai-whisper", decode);
    expect(openai.args).toEqual(
      expect.arrayContaining(["--language", "en", "--no_speech_threshold", "0.6"]),
    );
  });

  it("ignores whisper.cpp-unsupported options with a reason instead of dropping them silently", () => {
    const decode: WhisperDecodeConfig = {
      ...DEFAULT_DECODE,
      wordTimestamps: true,
      logprobThreshold: -1,
      compressionRatioThreshold: 2.4,
      hallucinationSilenceThreshold: 2,
    };
    const cpp = resolveWhisperDecodeArgs("whisper.cpp", decode);
    expect(cpp.args).not.toEqual(expect.arrayContaining(["--word_timestamps"]));
    const ignoredOptions = cpp.ignored.map((i) => i.option);
    expect(ignoredOptions).toEqual(
      expect.arrayContaining([
        "wordTimestamps",
        "logprobThreshold",
        "compressionRatioThreshold",
        "hallucinationSilenceThreshold",
      ]),
    );
    for (const ignored of cpp.ignored) {
      expect(ignored.reason).toMatch(/whisper\.cpp/);
    }
  });

  it("falls back to txt and reports the ignored option for an unrecognized output format", () => {
    const resolved = resolveWhisperDecodeArgs("mlx-whisper", { ...DEFAULT_DECODE, outputFormat: "josn" });
    expect(resolved.outputFormat).toBe("txt");
    expect(resolved.ignored).toEqual([
      {
        option: "outputFormat",
        reason: expect.stringContaining("josn"),
      },
    ]);
  });

  it("returns empty args/applied for the custom flavor regardless of configured decode options", () => {
    const decode: WhisperDecodeConfig = {
      ...DEFAULT_DECODE,
      language: "en",
      wordTimestamps: true,
      outputFormat: "json",
    };
    const result = resolveWhisperDecodeArgs("custom", decode);
    expect(result.args).toEqual([]);
    expect(result.applied).toEqual([]);
    expect(result.outputFormat).toBe("txt");
  });
});

describe("localWhisperReadiness", () => {
  const MLX_DETECTED: WhisperDetection = {
    detected: { flavor: "mlx-whisper", command: "/usr/local/bin/mlx_whisper" },
  };
  const WHISPER_CPP_DETECTED: WhisperDetection = {
    detected: { flavor: "whisper.cpp", command: "/usr/local/bin/whisper-cli" },
  };

  it("is not ready for mlx-whisper with no model and no opt-in", () => {
    const result = localWhisperReadiness(MLX_DETECTED, {});
    expect(result).toMatchObject({ ready: false, needsModel: true, detected: true });
    expect(result.reason).toContain("CASTRECALL_WHISPER_MODEL=mlx-community/whisper-large-v3-turbo");
  });

  it("is ready for mlx-whisper once a model is set", () => {
    const result = localWhisperReadiness(MLX_DETECTED, {
      model: "mlx-community/whisper-large-v3-turbo",
    });
    expect(result).toMatchObject({ ready: true, needsModel: false, detected: true });
  });

  it("is ready for mlx-whisper with no model when low quality is explicitly allowed", () => {
    const result = localWhisperReadiness(MLX_DETECTED, { allowLowQuality: true });
    expect(result).toMatchObject({ ready: true, needsModel: false, detected: true });
  });

  it("still requires a model for whisper.cpp regardless of the mlx opt-in (regression)", () => {
    const result = localWhisperReadiness(WHISPER_CPP_DETECTED, { allowLowQuality: true });
    expect(result).toMatchObject({ ready: false, needsModel: true, detected: true });
    expect(result.reason).toContain("CASTRECALL_WHISPER_MODEL");
  });

  it("is ready for mlx-whisper via a valid preset with no explicit model", () => {
    const result = localWhisperReadiness(MLX_DETECTED, { preset: "best" });
    expect(result).toMatchObject({ ready: true, needsModel: false, detected: true });
  });

  it("is not ready for mlx-whisper with an unknown preset, and reports the unknown-preset reason", () => {
    const result = localWhisperReadiness(MLX_DETECTED, { preset: "bogus" });
    expect(result).toMatchObject({ ready: false, needsModel: true, detected: true });
    expect(result.reason).toBe(WHISPER_PRESET_UNKNOWN_MESSAGE);
  });

  it("does not let allowLowQuality bypass an unknown preset (regression)", () => {
    const result = localWhisperReadiness(MLX_DETECTED, {
      preset: "bogus",
      allowLowQuality: true,
    });
    expect(result).toMatchObject({ ready: false, needsModel: true, detected: true });
    expect(result.reason).toBe(WHISPER_PRESET_UNKNOWN_MESSAGE);
  });

  it("is not ready for a non-mlx flavor with a preset set, and reports the non-mlx reason (regression)", () => {
    const ctranslate2Detected: WhisperDetection = {
      detected: { flavor: "whisper-ctranslate2", command: "/usr/local/bin/whisper-ctranslate2" },
    };
    const result = localWhisperReadiness(ctranslate2Detected, { preset: "best" });
    expect(result).toMatchObject({ ready: false, needsModel: true, detected: true });
    expect(result.reason).toBe(WHISPER_PRESET_NON_MLX_MESSAGE);
  });

  it("is ready for a custom command even with a leftover preset set (explicit override wins)", () => {
    const customDetected: WhisperDetection = {
      detected: { flavor: "custom", command: "my-whisper {input}" },
    };
    const result = localWhisperReadiness(customDetected, { preset: "best" });
    expect(result).toMatchObject({ ready: true, needsModel: false, detected: true });
    expect(result.reason).toBeUndefined();
  });
});

describe("transcribeWithLocalWhisper", () => {
  const audioFetch = (async () =>
    new Response("fake audio bytes standing in for a transcript", { status: 200 })) as typeof fetch;

  it("runs a custom command and returns its stdout (real subprocess)", async () => {
    const config = resolveConfig({}, { CASTRECALL_WHISPER_COMMAND: "cat {input}" });
    const result = await transcribeWithLocalWhisper(config, "https://cdn.example.com/ep.mp3", {
      fetchImpl: audioFetch,
      env: { PATH: "" },
    });
    expect(result.text).toBe("fake audio bytes standing in for a transcript");
    expect(result.provider).toBe("local-whisper:custom");
  });

  it("surfaces the exit code and stderr when the command fails", async () => {
    const config = resolveConfig(
      {},
      { CASTRECALL_WHISPER_COMMAND: "cat {input} > /dev/null; echo boom >&2; exit 3" },
    );
    await expect(
      transcribeWithLocalWhisper(config, "https://cdn.example.com/ep.mp3", {
        fetchImpl: audioFetch,
        env: { PATH: "" },
      }),
    ).rejects.toThrowError(/code 3.*boom/s);
  });

  it("fails with an empty-transcript error rather than storing nothing", async () => {
    const config = resolveConfig({}, { CASTRECALL_WHISPER_COMMAND: "true {input}" });
    await expect(
      transcribeWithLocalWhisper(config, "https://cdn.example.com/ep.mp3", {
        fetchImpl: audioFetch,
        env: { PATH: "" },
      }),
    ).rejects.toThrowError(/empty transcript/);
  });

  it("requires CASTRECALL_WHISPER_MODEL for whisper.cpp", async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "castrecall-bin-"));
    try {
      await fs.writeFile(path.join(binDir, "whisper-cli"), "#!/bin/sh\n", { mode: 0o755 });
      const config = resolveConfig({}, {});
      await expect(
        transcribeWithLocalWhisper(config, "https://cdn.example.com/ep.mp3", {
          fetchImpl: audioFetch,
          env: { PATH: binDir },
        }),
      ).rejects.toThrowError(/CASTRECALL_WHISPER_MODEL/);
    } finally {
      await fs.rm(binDir, { recursive: true, force: true });
    }
  });

  it("requires CASTRECALL_WHISPER_MODEL for mlx-whisper and never invokes the executable", async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "castrecall-bin-"));
    try {
      await fs.writeFile(path.join(binDir, "mlx_whisper"), "#!/bin/sh\n", { mode: 0o755 });
      const config = resolveConfig({}, {});
      await expect(
        transcribeWithLocalWhisper(config, "https://cdn.example.com/ep.mp3", {
          fetchImpl: audioFetch,
          env: { PATH: binDir },
          execImpl: () => {
            throw new Error("exec must not run when the MLX model is unset");
          },
        }),
      ).rejects.toThrowError(/CASTRECALL_WHISPER_MODEL/);
    } finally {
      await fs.rm(binDir, { recursive: true, force: true });
    }
  });

  it("runs mlx-whisper with no model when CASTRECALL_WHISPER_ALLOW_LOW_QUALITY is set", async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "castrecall-bin-"));
    try {
      await fs.writeFile(path.join(binDir, "mlx_whisper"), "#!/bin/sh\n", { mode: 0o755 });
      const config = resolveConfig({}, { CASTRECALL_WHISPER_ALLOW_LOW_QUALITY: "true" });
      const result = await transcribeWithLocalWhisper(config, "https://cdn.example.com/ep.mp3", {
        fetchImpl: audioFetch,
        env: { PATH: binDir },
        execImpl: async (argv) => {
          const workDir = argv[argv.indexOf("--output-dir") + 1];
          await fs.writeFile(path.join(workDir, "episode.txt"), "low-quality but private transcript");
          return { code: 0, stdout: "", stderr: "" };
        },
      });
      expect(result.provider).toBe("local-whisper:mlx-whisper");
      expect(result.text).toBe("low-quality but private transcript");
    } finally {
      await fs.rm(binDir, { recursive: true, force: true });
    }
  });

  it("resolves CASTRECALL_LOCAL_WHISPER_PRESET=best to the concrete mlx model in exec argv", async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "castrecall-bin-"));
    try {
      await fs.writeFile(path.join(binDir, "mlx_whisper"), "#!/bin/sh\n", { mode: 0o755 });
      const config = resolveConfig({}, { CASTRECALL_LOCAL_WHISPER_PRESET: "best" });
      let seenArgv: string[] = [];
      const result = await transcribeWithLocalWhisper(config, "https://cdn.example.com/ep.mp3", {
        fetchImpl: audioFetch,
        env: { PATH: binDir },
        execImpl: async (argv) => {
          seenArgv = argv;
          const workDir = argv[argv.indexOf("--output-dir") + 1];
          await fs.writeFile(path.join(workDir, "episode.txt"), "high-quality transcript");
          return { code: 0, stdout: "", stderr: "" };
        },
      });
      expect(seenArgv).toContain("--model");
      expect(seenArgv).toContain("mlx-community/whisper-large-v3-turbo");
      expect(result.provider).toBe("local-whisper:mlx-whisper:whisper-large-v3-turbo");
    } finally {
      await fs.rm(binDir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown preset with the unknown-preset message and never invokes exec", async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "castrecall-bin-"));
    try {
      await fs.writeFile(path.join(binDir, "mlx_whisper"), "#!/bin/sh\n", { mode: 0o755 });
      const config = resolveConfig({}, { CASTRECALL_LOCAL_WHISPER_PRESET: "bogus" });
      await expect(
        transcribeWithLocalWhisper(config, "https://cdn.example.com/ep.mp3", {
          fetchImpl: audioFetch,
          env: { PATH: binDir },
          execImpl: () => {
            throw new Error("exec must not run for an unknown preset");
          },
        }),
      ).rejects.toThrowError(/must be one of: fast, balanced, best/);
    } finally {
      await fs.rm(binDir, { recursive: true, force: true });
    }
  });

  it("throws the detection reason when no whisper is available", async () => {
    const config = resolveConfig({}, {});
    await expect(
      transcribeWithLocalWhisper(config, "https://cdn.example.com/ep.mp3", {
        fetchImpl: audioFetch,
        env: { PATH: "" },
      }),
    ).rejects.toThrowError(/No local Whisper CLI detected/);
  });
});

describe("transcribeWithLocalWhisper decode options (issue #53)", () => {
  const audioFetch = (async () =>
    new Response("fake audio bytes standing in for a transcript", { status: 200 })) as typeof fetch;
  const wavFetch = (async () => new Response("fake wav bytes", { status: 200 })) as typeof fetch;

  it("passes the language and condition-on-previous-text-off flags to mlx-whisper argv by default (regression)", async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "castrecall-bin-"));
    try {
      await fs.writeFile(path.join(binDir, "mlx_whisper"), "#!/bin/sh\n", { mode: 0o755 });
      const config = resolveConfig(
        {},
        {
          CASTRECALL_WHISPER_MODEL: "mlx-community/whisper-large-v3-turbo",
          CASTRECALL_WHISPER_LANGUAGE: "en",
        },
      );
      let seenArgv: string[] = [];
      const result = await transcribeWithLocalWhisper(config, "https://cdn.example.com/ep.mp3", {
        fetchImpl: audioFetch,
        env: { PATH: binDir },
        execImpl: async (argv) => {
          seenArgv = argv;
          const workDir = argv[argv.indexOf("--output-dir") + 1];
          await fs.writeFile(path.join(workDir, "episode.txt"), "transcribed with language hint");
          return { code: 0, stdout: "", stderr: "" };
        },
      });
      expect(seenArgv).toEqual(
        expect.arrayContaining(["--language", "en", "--condition-on-previous-text", "False"]),
      );
      expect(seenArgv).toContain("--output-format");
      expect(seenArgv[seenArgv.indexOf("--output-format") + 1]).toBe("txt");
      expect(result.text).toBe("transcribed with language hint");
      expect(result.format).toBe("txt");
    } finally {
      await fs.rm(binDir, { recursive: true, force: true });
    }
  });

  it("requests JSON output from mlx-whisper and normalizes the produced segments to text", async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "castrecall-bin-"));
    try {
      await fs.writeFile(path.join(binDir, "mlx_whisper"), "#!/bin/sh\n", { mode: 0o755 });
      const config = resolveConfig(
        {},
        {
          CASTRECALL_WHISPER_MODEL: "mlx-community/whisper-large-v3-turbo",
          CASTRECALL_WHISPER_OUTPUT_FORMAT: "json",
        },
      );
      const jsonBody = JSON.stringify({
        text: "Hello world.",
        segments: [{ start: 0, end: 1.2, text: "Hello world." }],
      });
      const result = await transcribeWithLocalWhisper(config, "https://cdn.example.com/ep.mp3", {
        fetchImpl: audioFetch,
        env: { PATH: binDir },
        execImpl: async (argv) => {
          const workDir = argv[argv.indexOf("--output-dir") + 1];
          await fs.writeFile(path.join(workDir, "episode.json"), jsonBody);
          return { code: 0, stdout: "", stderr: "" };
        },
      });
      expect(result.format).toBe("json");
      expect(result.raw).toBe(jsonBody);
      expect(result.text).toContain("Hello world.");
    } finally {
      await fs.rm(binDir, { recursive: true, force: true });
    }
  });

  it("requests structured JSON output from whisper.cpp via -oj/-of and parses the transcription array", async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "castrecall-bin-"));
    try {
      await fs.writeFile(path.join(binDir, "whisper-cli"), "#!/bin/sh\n", { mode: 0o755 });
      const config = resolveConfig(
        {},
        { CASTRECALL_WHISPER_MODEL: "/path/to/ggml.bin", CASTRECALL_WHISPER_OUTPUT_FORMAT: "json" },
      );
      let seenArgv: string[] = [];
      const jsonBody = JSON.stringify({
        transcription: [{ text: "Hello from whisper.cpp.", offsets: { from: 0, to: 1200 } }],
      });
      const result = await transcribeWithLocalWhisper(config, "https://cdn.example.com/ep.wav", {
        fetchImpl: wavFetch,
        env: { PATH: binDir },
        execImpl: async (argv) => {
          seenArgv = argv;
          const outBase = argv[argv.indexOf("-of") + 1];
          await fs.writeFile(`${outBase}.json`, jsonBody);
          return { code: 0, stdout: "", stderr: "" };
        },
      });
      expect(seenArgv).toContain("-oj");
      expect(seenArgv[seenArgv.indexOf("-of") + 1]).toMatch(/episode$/);
      expect(result.format).toBe("json");
      expect(result.raw).toBe(jsonBody);
      expect(result.text).toContain("Hello from whisper.cpp.");
    } finally {
      await fs.rm(binDir, { recursive: true, force: true });
    }
  });

  it("throws a clear 'produced no json output' error when whisper.cpp exits 0 but writes no file (no stale fallback)", async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "castrecall-bin-"));
    try {
      await fs.writeFile(path.join(binDir, "whisper-cli"), "#!/bin/sh\n", { mode: 0o755 });
      const config = resolveConfig(
        {},
        { CASTRECALL_WHISPER_MODEL: "/path/to/ggml.bin", CASTRECALL_WHISPER_OUTPUT_FORMAT: "json" },
      );
      await expect(
        transcribeWithLocalWhisper(config, "https://cdn.example.com/ep.wav", {
          fetchImpl: wavFetch,
          env: { PATH: binDir },
          execImpl: async () => ({ code: 0, stdout: "", stderr: "" }),
        }),
      ).rejects.toThrowError(/produced no json output/);
    } finally {
      await fs.rm(binDir, { recursive: true, force: true });
    }
  });

  it("falls back to txt and surfaces the ignored option when CASTRECALL_WHISPER_OUTPUT_FORMAT is unrecognized", async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "castrecall-bin-"));
    try {
      await fs.writeFile(path.join(binDir, "whisper-cli"), "#!/bin/sh\n", { mode: 0o755 });
      const config = resolveConfig(
        {},
        { CASTRECALL_WHISPER_MODEL: "/path/to/ggml.bin", CASTRECALL_WHISPER_OUTPUT_FORMAT: "josn" },
      );
      const result = await transcribeWithLocalWhisper(config, "https://cdn.example.com/ep.wav", {
        fetchImpl: wavFetch,
        env: { PATH: binDir },
        execImpl: async () => ({ code: 0, stdout: "plain text transcript", stderr: "" }),
      });
      expect(result.format).toBe("txt");
      expect(result.text).toBe("plain text transcript");
      expect(result.ignoredOptions).toEqual(
        expect.arrayContaining([expect.objectContaining({ option: "outputFormat" })]),
      );
      expect(result.ignoredOptions.find((o) => o.option === "outputFormat")?.reason).toContain("josn");
    } finally {
      await fs.rm(binDir, { recursive: true, force: true });
    }
  });

  it("ignores hallucinationSilenceThreshold on whisper.cpp (unsupported), omitting it from argv but naming it in ignoredOptions", async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "castrecall-bin-"));
    try {
      await fs.writeFile(path.join(binDir, "whisper-cli"), "#!/bin/sh\n", { mode: 0o755 });
      const config = resolveConfig(
        {},
        {
          CASTRECALL_WHISPER_MODEL: "/path/to/ggml.bin",
          CASTRECALL_WHISPER_HALLUCINATION_SILENCE_THRESHOLD: "2",
        },
      );
      let seenArgv: string[] = [];
      const result = await transcribeWithLocalWhisper(config, "https://cdn.example.com/ep.wav", {
        fetchImpl: wavFetch,
        env: { PATH: binDir },
        execImpl: async (argv) => {
          seenArgv = argv;
          return { code: 0, stdout: "plain transcript", stderr: "" };
        },
      });
      expect(seenArgv).not.toEqual(expect.arrayContaining(["--hallucination_silence_threshold"]));
      expect(result.ignoredOptions).toEqual(
        expect.arrayContaining([expect.objectContaining({ option: "hallucinationSilenceThreshold" })]),
      );
    } finally {
      await fs.rm(binDir, { recursive: true, force: true });
    }
  });

  it("resolveWhisperDecodeArgs custom no-op still lets the existing custom command test pass unchanged", async () => {
    const config = resolveConfig(
      {},
      {
        CASTRECALL_WHISPER_COMMAND: "cat {input}",
        CASTRECALL_WHISPER_LANGUAGE: "en",
        CASTRECALL_WHISPER_OUTPUT_FORMAT: "json",
      },
    );
    const result = await transcribeWithLocalWhisper(config, "https://cdn.example.com/ep.mp3", {
      fetchImpl: audioFetch,
      env: { PATH: "" },
    });
    expect(result.text).toBe("fake audio bytes standing in for a transcript");
    expect(result.format).toBe("txt");
    expect(result.ignoredOptions).toEqual([]);
  });
});
