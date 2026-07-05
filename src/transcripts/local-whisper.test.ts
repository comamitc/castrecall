import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../config.js";
import {
  detectLocalWhisper,
  findOnPath,
  transcribeWithLocalWhisper,
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
