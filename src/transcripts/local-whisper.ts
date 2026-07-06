/**
 * Rung 3 of the transcript ladder: local Whisper — free and fully private.
 *
 * Nothing is bundled: this rung auto-detects a Whisper CLI the user already
 * has installed (whisper.cpp, openai-whisper, whisper-ctranslate2, or
 * mlx-whisper) and is skipped with an actionable message when none is found.
 * A custom command can be supplied via CASTRECALL_WHISPER_COMMAND with an
 * {input} placeholder; its stdout is treated as the transcript.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CastrecallSetupError, type ResolvedConfig } from "../config.js";
import type { FetchLike } from "../pocketcasts/client.js";

const TRANSCRIBE_TIMEOUT_MS = 60 * 60_000; // long episodes on CPU take a while
const KNOWN_BINARIES = [
  { name: "whisper-cli", flavor: "whisper.cpp" },
  { name: "whisper-cpp", flavor: "whisper.cpp" },
  { name: "mlx_whisper", flavor: "mlx-whisper" },
  { name: "whisper-ctranslate2", flavor: "whisper-ctranslate2" },
  { name: "whisper", flavor: "openai-whisper" },
] as const;

export type WhisperFlavor = (typeof KNOWN_BINARIES)[number]["flavor"] | "custom";

export type DetectedWhisper = {
  flavor: WhisperFlavor;
  /** Absolute binary path, or the raw command template for the custom flavor. */
  command: string;
};

export type WhisperDetection =
  | { detected: DetectedWhisper; reason?: undefined }
  | { detected?: undefined; reason: string };

export const WHISPER_CPP_MODEL_MISSING_MESSAGE =
  "whisper.cpp needs a ggml model file. Set CASTRECALL_WHISPER_MODEL=/path/to/ggml-<size>.bin " +
  "(download one with whisper.cpp's models script or from Hugging Face ggerganov/whisper.cpp).";

export const MLX_WHISPER_MODEL_MISSING_MESSAGE =
  "mlx_whisper defaults to the tiny model, too weak for a transcript corpus. Set " +
  "CASTRECALL_WHISPER_MODEL=mlx-community/whisper-large-v3-turbo (or another model), set " +
  "CASTRECALL_LOCAL_WHISPER_PRESET=best (or balanced/fast), or set " +
  "CASTRECALL_WHISPER_ALLOW_LOW_QUALITY=true to accept low-quality/fast transcription.";

/**
 * CastRecall-managed quality presets for Apple Silicon local transcription
 * (mlx-whisper only). `best` is the only #51-quality-approved model; `balanced`
 * aliases it today and can diverge to a validated mid-tier model later with no
 * env/API change; `fast` is an explicit, lower-quality opt-in — never an
 * accidental default.
 */
export const WHISPER_PRESETS = {
  best: "mlx-community/whisper-large-v3-turbo",
  balanced: "mlx-community/whisper-large-v3-turbo",
  fast: "mlx-community/whisper-small-mlx",
} as const;

export type WhisperPreset = keyof typeof WHISPER_PRESETS;

export const WHISPER_PRESET_UNKNOWN_MESSAGE =
  "CASTRECALL_LOCAL_WHISPER_PRESET must be one of: fast, balanced, best.";

export const WHISPER_PRESET_NON_MLX_MESSAGE =
  "CASTRECALL_LOCAL_WHISPER_PRESET only resolves a model on Apple Silicon (mlx-whisper); " +
  "mlx-community models are not valid on other Whisper CLIs/CUDA hosts. Set " +
  "CASTRECALL_WHISPER_MODEL directly for this flavor instead.";

export type WhisperModelResolution = {
  model?: string;
  source: "explicit" | "preset" | "none";
  preset?: string;
  reason?: string;
};

/**
 * Single source of truth for which concrete model a local Whisper run uses:
 * an explicit CASTRECALL_WHISPER_MODEL always wins; otherwise a
 * CASTRECALL_LOCAL_WHISPER_PRESET resolves to a concrete mlx-community model,
 * but only for the mlx-whisper flavor (the presence of the mlx_whisper binary
 * IS the Apple-Silicon signal here — no separate platform probe). Every
 * consumer that needs to know or show the concrete model — readiness, setup
 * output, the provider label, and exec argv — must call this, never read
 * config.localWhisper.model directly.
 */
export function resolveWhisperModel(
  flavor: WhisperFlavor | undefined,
  localWhisperConfig: { model?: string; preset?: string },
): WhisperModelResolution {
  if (localWhisperConfig.model) {
    return { model: localWhisperConfig.model, source: "explicit" };
  }
  const preset = localWhisperConfig.preset;
  if (!preset) return { source: "none" };
  if (flavor !== "mlx-whisper") {
    return { source: "none", preset, reason: WHISPER_PRESET_NON_MLX_MESSAGE };
  }
  const presetModel = (WHISPER_PRESETS as Record<string, string>)[preset];
  if (!presetModel) {
    return { source: "none", preset, reason: WHISPER_PRESET_UNKNOWN_MESSAGE };
  }
  return { model: presetModel, source: "preset", preset };
}

/**
 * Single source of truth for whether the local Whisper rung can actually RUN
 * at usable quality (not merely whether a binary was detected): whisper.cpp
 * needs a ggml model via CASTRECALL_WHISPER_MODEL or it can't run at all;
 * mlx-whisper can run without one, but silently falls back to Whisper's tiny
 * model, so it additionally needs an explicit model or preset (or an opt-in
 * to accept that low quality) before it's quality-ready. Status surfaces
 * must use this, never raw detection, or they report "ready" for a rung that
 * will throw or quietly produce a toy-quality transcript.
 */
export function localWhisperReadiness(
  detection: WhisperDetection,
  localWhisperConfig: { model?: string; preset?: string; allowLowQuality?: boolean },
): { ready: boolean; detected: boolean; needsModel: boolean; reason?: string } {
  const detected = Boolean(detection.detected);
  const flavor = detection.detected?.flavor;
  const resolved = resolveWhisperModel(flavor, localWhisperConfig);
  const hasModel = Boolean(resolved.model);
  // A preset that fails to resolve (unknown value, or used on a non-mlx
  // flavor) is a configuration error, not a "low quality" tradeoff — it must
  // not be silently bypassed by CASTRECALL_WHISPER_ALLOW_LOW_QUALITY, or
  // readiness would say "ready" for a preset value that runWhisper rejects.
  const presetError = Boolean(localWhisperConfig.preset && resolved.reason);
  const needsModel =
    (flavor === "whisper.cpp" && !hasModel) ||
    (flavor === "mlx-whisper" && !hasModel && (presetError || !localWhisperConfig.allowLowQuality));
  const reason = needsModel
    ? presetError
      ? resolved.reason
      : flavor === "whisper.cpp"
        ? WHISPER_CPP_MODEL_MISSING_MESSAGE
        : MLX_WHISPER_MODEL_MISSING_MESSAGE
    : undefined;
  return { ready: detected && !needsModel, detected, needsModel, reason };
}

export type ExecResult = { code: number | null; stdout: string; stderr: string };
export type ExecImpl = (argv: string[], options: { timeoutMs: number }) => Promise<ExecResult>;

export async function detectLocalWhisper(
  config: ResolvedConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WhisperDetection> {
  if (config.localWhisper.disabled) {
    return { reason: "Local Whisper is disabled via CASTRECALL_DISABLE_LOCAL_WHISPER." };
  }
  if (config.localWhisper.command) {
    if (!config.localWhisper.command.includes("{input}")) {
      return {
        reason:
          "CASTRECALL_WHISPER_COMMAND is set but has no {input} placeholder for the audio file path.",
      };
    }
    return { detected: { flavor: "custom", command: config.localWhisper.command } };
  }
  for (const candidate of KNOWN_BINARIES) {
    const found = await findOnPath(candidate.name, env.PATH ?? "");
    if (found) return { detected: { flavor: candidate.flavor, command: found } };
  }
  return {
    reason:
      "No local Whisper CLI detected on PATH (looked for " +
      `${KNOWN_BINARIES.map((b) => b.name).join(", ")}). Install one — e.g. ` +
      "'brew install whisper-cpp' plus a ggml model, 'pip install mlx-whisper' on Apple Silicon, " +
      "or 'pip install openai-whisper' — or set CASTRECALL_WHISPER_COMMAND. " +
      "Free and fully private once installed.",
  };
}

export async function findOnPath(binary: string, pathVar: string): Promise<string | undefined> {
  for (const dir of pathVar.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, binary);
    try {
      await fs.access(candidate, fs.constants.X_OK);
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // not here; keep looking
    }
  }
  return undefined;
}

export async function transcribeWithLocalWhisper(
  config: ResolvedConfig,
  audioUrl: string,
  deps: { fetchImpl?: FetchLike; execImpl?: ExecImpl; env?: NodeJS.ProcessEnv } = {},
): Promise<{ text: string; provider: string }> {
  const detection = await detectLocalWhisper(config, deps.env ?? process.env);
  if (!detection.detected) throw new CastrecallSetupError(detection.reason);
  if (!audioUrl) throw new Error("Episode has no audio URL; cannot transcribe locally.");

  const fetchImpl = deps.fetchImpl ?? fetch;
  const execImpl = deps.execImpl ?? defaultExec;
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "castrecall-whisper-"));
  try {
    const audioPath = await downloadAudio(fetchImpl, audioUrl, workDir);
    const text = await runWhisper(detection.detected, config, audioPath, workDir, execImpl, deps.env);
    if (!text.trim()) {
      throw new Error(`${detection.detected.flavor} produced an empty transcript.`);
    }
    return { text: text.trim(), provider: providerLabel(detection.detected, config) };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

async function downloadAudio(
  fetchImpl: FetchLike,
  audioUrl: string,
  workDir: string,
): Promise<string> {
  const response = await fetchImpl(audioUrl);
  if (!response.ok) {
    throw new Error(`Audio download failed with HTTP ${response.status}.`);
  }
  const ext = audioUrl.split("?")[0].split(".").pop()?.toLowerCase();
  const safeExt = ext && /^[a-z0-9]{1,5}$/.test(ext) ? ext : "mp3";
  const audioPath = path.join(workDir, `episode.${safeExt}`);
  await fs.writeFile(audioPath, Buffer.from(await response.arrayBuffer()));
  return audioPath;
}

async function runWhisper(
  detected: DetectedWhisper,
  config: ResolvedConfig,
  audioPath: string,
  workDir: string,
  execImpl: ExecImpl,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const resolved = resolveWhisperModel(detected.flavor, config.localWhisper);
  const model = resolved.model;
  switch (detected.flavor) {
    case "custom": {
      const command = detected.command
        .replaceAll("{input}", shellQuote(audioPath))
        .replaceAll("{model}", model ? shellQuote(model) : "");
      const result = await execImpl(["/bin/sh", "-c", command], {
        timeoutMs: TRANSCRIBE_TIMEOUT_MS,
      });
      assertExitOk(result, "custom whisper command");
      return result.stdout;
    }
    case "whisper.cpp": {
      if (!model) {
        throw new CastrecallSetupError(WHISPER_CPP_MODEL_MISSING_MESSAGE);
      }
      const input = await ensureWav(audioPath, workDir, execImpl, env);
      const result = await execImpl(
        [detected.command, "-m", model, "-f", input, "-np", "-nt"],
        { timeoutMs: TRANSCRIBE_TIMEOUT_MS },
      );
      assertExitOk(result, "whisper.cpp");
      return result.stdout;
    }
    case "openai-whisper":
    case "whisper-ctranslate2": {
      const argv = [
        detected.command,
        audioPath,
        "--output_format",
        "txt",
        "--output_dir",
        workDir,
        "--verbose",
        "False",
        ...(model ? ["--model", model] : []),
      ];
      const result = await execImpl(argv, { timeoutMs: TRANSCRIBE_TIMEOUT_MS });
      assertExitOk(result, detected.flavor);
      return readProducedTxt(workDir, audioPath);
    }
    case "mlx-whisper": {
      if (!model) {
        if (config.localWhisper.preset && resolved.reason) {
          throw new CastrecallSetupError(resolved.reason);
        }
        if (!config.localWhisper.allowLowQuality) {
          throw new CastrecallSetupError(MLX_WHISPER_MODEL_MISSING_MESSAGE);
        }
      }
      const argv = [
        detected.command,
        audioPath,
        "--output-dir",
        workDir,
        "--output-format",
        "txt",
        ...(model ? ["--model", model] : []),
      ];
      const result = await execImpl(argv, { timeoutMs: TRANSCRIBE_TIMEOUT_MS });
      assertExitOk(result, "mlx-whisper");
      return readProducedTxt(workDir, audioPath);
    }
  }
}

/** whisper.cpp wants 16 kHz mono WAV; convert with ffmpeg when the input isn't WAV. */
async function ensureWav(
  audioPath: string,
  workDir: string,
  execImpl: ExecImpl,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  if (audioPath.endsWith(".wav")) return audioPath;
  const ffmpeg = await findOnPath("ffmpeg", env.PATH ?? "");
  if (!ffmpeg) {
    throw new CastrecallSetupError(
      "whisper.cpp needs 16 kHz WAV input and the episode audio is not WAV. " +
        "Install ffmpeg (e.g. 'brew install ffmpeg'), or use another Whisper CLI " +
        "(openai-whisper / mlx-whisper decode audio themselves).",
    );
  }
  const wavPath = path.join(workDir, "episode.wav");
  const result = await execImpl(
    [ffmpeg, "-y", "-i", audioPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath],
    { timeoutMs: 10 * 60_000 },
  );
  assertExitOk(result, "ffmpeg conversion");
  return wavPath;
}

async function readProducedTxt(workDir: string, audioPath: string): Promise<string> {
  const base = path.basename(audioPath).replace(/\.[^.]+$/, "");
  const expected = path.join(workDir, `${base}.txt`);
  try {
    return await fs.readFile(expected, "utf8");
  } catch {
    // Some CLIs name outputs differently; take any .txt they produced.
    const entries = await fs.readdir(workDir);
    const txt = entries.find((name) => name.endsWith(".txt"));
    if (!txt) throw new Error("Whisper run finished but produced no .txt output.");
    return fs.readFile(path.join(workDir, txt), "utf8");
  }
}

function providerLabel(detected: DetectedWhisper, config: ResolvedConfig): string {
  const resolved = resolveWhisperModel(detected.flavor, config.localWhisper);
  const modelPart = resolved.model ? `:${path.basename(resolved.model)}` : "";
  return `local-whisper:${detected.flavor}${modelPart}`;
}

function assertExitOk(result: ExecResult, label: string): void {
  if (result.code === 0) return;
  const stderrTail = result.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 500);
  throw new Error(
    `${label} exited with code ${result.code ?? "null (timeout/signal)"}${
      stderrTail ? `: ${stderrTail}` : ""
    }`,
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function defaultExec(argv: string[], options: { timeoutMs: number }): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const [command, ...args] = argv;
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
