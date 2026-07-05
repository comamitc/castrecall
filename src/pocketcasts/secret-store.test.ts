import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../config.js";
import {
  deleteSecret,
  detectSecretBackend,
  readSecret,
  writeSecret,
  type ExecImpl,
  type SecretBackend,
} from "./secret-store.js";

describe("detectSecretBackend", () => {
  let binDir: string;

  beforeEach(async () => {
    binDir = await fs.mkdtemp(path.join(os.tmpdir(), "castrecall-bin-"));
  });

  afterEach(async () => {
    await fs.rm(binDir, { recursive: true, force: true });
  });

  it("reports disabled when CASTRECALL_DISABLE_KEYCHAIN is set, even with a real binary on PATH", async () => {
    await fs.writeFile(path.join(binDir, "security"), "#!/bin/sh\n", { mode: 0o755 });
    const config = resolveConfig({}, { CASTRECALL_DISABLE_KEYCHAIN: "1" });
    const detection = await detectSecretBackend(config, { env: { PATH: binDir }, platform: "darwin" });
    expect(detection.backend).toBeUndefined();
    expect(detection.reason).toContain("CASTRECALL_DISABLE_KEYCHAIN");
  });

  it("detects the macOS 'security' CLI on darwin", async () => {
    const bin = path.join(binDir, "security");
    await fs.writeFile(bin, "#!/bin/sh\n", { mode: 0o755 });
    const config = resolveConfig({}, {});
    const detection = await detectSecretBackend(config, { env: { PATH: binDir }, platform: "darwin" });
    expect(detection.backend).toEqual({ kind: "macos-keychain", bin });
  });

  it("reports a reason when 'security' is missing on darwin", async () => {
    const config = resolveConfig({}, {});
    const detection = await detectSecretBackend(config, { env: { PATH: "" }, platform: "darwin" });
    expect(detection.backend).toBeUndefined();
    expect(detection.reason).toContain("security");
  });

  it("detects 'secret-tool' on linux", async () => {
    const bin = path.join(binDir, "secret-tool");
    await fs.writeFile(bin, "#!/bin/sh\n", { mode: 0o755 });
    const config = resolveConfig({}, {});
    const detection = await detectSecretBackend(config, { env: { PATH: binDir }, platform: "linux" });
    expect(detection.backend).toEqual({ kind: "libsecret", bin });
  });

  it("reports a reason when 'secret-tool' is missing on linux", async () => {
    const config = resolveConfig({}, {});
    const detection = await detectSecretBackend(config, { env: { PATH: "" }, platform: "linux" });
    expect(detection.backend).toBeUndefined();
    expect(detection.reason).toContain("secret-tool");
  });

  it("reports no backend on an unsupported platform", async () => {
    const config = resolveConfig({}, {});
    const detection = await detectSecretBackend(config, { env: { PATH: binDir }, platform: "win32" });
    expect(detection.backend).toBeUndefined();
    expect(detection.reason).toContain("win32");
  });
});

function fakeExec(
  handler: (argv: string[], options: { timeoutMs: number; stdin?: string }) => ExecResultLike,
): { execImpl: ExecImpl; calls: Array<{ argv: string[]; stdin?: string }> } {
  const calls: Array<{ argv: string[]; stdin?: string }> = [];
  const execImpl: ExecImpl = async (argv, options) => {
    calls.push({ argv, stdin: options.stdin });
    return handler(argv, options);
  };
  return { execImpl, calls };
}

type ExecResultLike = { code: number | null; stdout: string; stderr: string };

const MACOS: SecretBackend = { kind: "macos-keychain", bin: "/usr/bin/security" };
const LIBSECRET: SecretBackend = { kind: "libsecret", bin: "/usr/bin/secret-tool" };

describe("readSecret", () => {
  it("returns trimmed stdout on a successful macOS lookup", async () => {
    const { execImpl } = fakeExec(() => ({ code: 0, stdout: "hunter2\n", stderr: "" }));
    const value = await readSecret(MACOS, "castrecall", "pocketcasts-password", { execImpl });
    expect(value).toBe("hunter2");
  });

  it("returns undefined on a non-zero exit (entry absent)", async () => {
    const { execImpl } = fakeExec(() => ({ code: 44, stdout: "", stderr: "not found" }));
    const value = await readSecret(MACOS, "castrecall", "pocketcasts-password", { execImpl });
    expect(value).toBeUndefined();
  });

  it("returns undefined when the exec itself throws", async () => {
    const execImpl: ExecImpl = async () => {
      throw new Error("ENOENT");
    };
    const value = await readSecret(LIBSECRET, "castrecall", "pocketcasts-password", { execImpl });
    expect(value).toBeUndefined();
  });

  it("builds libsecret lookup argv", async () => {
    const { execImpl, calls } = fakeExec(() => ({ code: 0, stdout: "value", stderr: "" }));
    await readSecret(LIBSECRET, "castrecall", "pocketcasts-email", { execImpl });
    expect(calls[0].argv).toEqual([
      "/usr/bin/secret-tool",
      "lookup",
      "service",
      "castrecall",
      "account",
      "pocketcasts-email",
    ]);
  });
});

describe("writeSecret", () => {
  it("includes -U (update-in-place) in the macOS write argv, value in argv", async () => {
    const { execImpl, calls } = fakeExec(() => ({ code: 0, stdout: "", stderr: "" }));
    await writeSecret(MACOS, "castrecall", "pocketcasts-token", "the-token", { execImpl });
    expect(calls[0].argv).toEqual([
      "/usr/bin/security",
      "add-generic-password",
      "-U",
      "-s",
      "castrecall",
      "-a",
      "pocketcasts-token",
      "-w",
      "the-token",
    ]);
  });

  it("sends the value via stdin for libsecret, never in argv", async () => {
    const { execImpl, calls } = fakeExec(() => ({ code: 0, stdout: "", stderr: "" }));
    await writeSecret(LIBSECRET, "castrecall", "pocketcasts-token", "the-token", { execImpl });
    expect(calls[0].argv.join(" ")).not.toContain("the-token");
    expect(calls[0].stdin).toBe("the-token");
    expect(calls[0].argv).toEqual([
      "/usr/bin/secret-tool",
      "store",
      "--label",
      "CastRecall pocketcasts-token",
      "service",
      "castrecall",
      "account",
      "pocketcasts-token",
    ]);
  });

  it("throws with exit code and stderr on failure", async () => {
    const { execImpl } = fakeExec(() => ({ code: 1, stdout: "", stderr: "keychain locked" }));
    await expect(
      writeSecret(MACOS, "castrecall", "pocketcasts-token", "x", { execImpl }),
    ).rejects.toThrowError(/code 1.*keychain locked/s);
  });
});

describe("deleteSecret", () => {
  it("builds macOS delete argv", async () => {
    const { execImpl, calls } = fakeExec(() => ({ code: 0, stdout: "", stderr: "" }));
    await deleteSecret(MACOS, "castrecall", "pocketcasts-token", { execImpl });
    expect(calls[0].argv).toEqual([
      "/usr/bin/security",
      "delete-generic-password",
      "-s",
      "castrecall",
      "-a",
      "pocketcasts-token",
    ]);
  });

  it("builds libsecret clear argv", async () => {
    const { execImpl, calls } = fakeExec(() => ({ code: 0, stdout: "", stderr: "" }));
    await deleteSecret(LIBSECRET, "castrecall", "pocketcasts-token", { execImpl });
    expect(calls[0].argv).toEqual([
      "/usr/bin/secret-tool",
      "clear",
      "service",
      "castrecall",
      "account",
      "pocketcasts-token",
    ]);
  });

  it("throws on a non-zero exit", async () => {
    const { execImpl } = fakeExec(() => ({ code: 1, stdout: "", stderr: "no such entry" }));
    await expect(deleteSecret(MACOS, "castrecall", "pocketcasts-token", { execImpl })).rejects.toThrowError(
      /no such entry/,
    );
  });
});
