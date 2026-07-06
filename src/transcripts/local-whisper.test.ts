import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../config.js";
import {
  WHISPER_PRESET_NON_MLX_MESSAGE,
  WHISPER_PRESET_UNKNOWN_MESSAGE,
  detectLocalWhisper,
  findOnPath,
  localWhisperReadiness,
  resolveWhisperModel,
  transcribeWithLocalWhisper,
  type WhisperDetection,
} from "./local-whisper.js";

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
