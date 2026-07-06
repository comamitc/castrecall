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
import { CastrecallSetupError } from "../config.js";
import { normalizeTranscript } from "./normalize.js";
const TRANSCRIBE_TIMEOUT_MS = 60 * 60_000; // long episodes on CPU take a while
const KNOWN_BINARIES = [
    { name: "whisper-cli", flavor: "whisper.cpp" },
    { name: "whisper-cpp", flavor: "whisper.cpp" },
    { name: "mlx_whisper", flavor: "mlx-whisper" },
    { name: "whisper-ctranslate2", flavor: "whisper-ctranslate2" },
    { name: "whisper", flavor: "openai-whisper" },
];
export const WHISPER_CPP_MODEL_MISSING_MESSAGE = "whisper.cpp needs a ggml model file. Set CASTRECALL_WHISPER_MODEL=/path/to/ggml-<size>.bin " +
    "(download one with whisper.cpp's models script or from Hugging Face ggerganov/whisper.cpp).";
export const MLX_WHISPER_MODEL_MISSING_MESSAGE = "mlx_whisper defaults to the tiny model, too weak for a transcript corpus. Set " +
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
};
export const WHISPER_PRESET_UNKNOWN_MESSAGE = "CASTRECALL_LOCAL_WHISPER_PRESET must be one of: fast, balanced, best.";
export const WHISPER_PRESET_NON_MLX_MESSAGE = "CASTRECALL_LOCAL_WHISPER_PRESET only resolves a model on Apple Silicon (mlx-whisper); " +
    "mlx-community models are not valid on other Whisper CLIs/CUDA hosts. Set " +
    "CASTRECALL_WHISPER_MODEL directly for this flavor instead.";
/**
 * Single source of truth for which concrete model a local Whisper run uses:
 * an explicit CASTRECALL_WHISPER_MODEL always wins; otherwise a
 * CASTRECALL_LOCAL_WHISPER_PRESET resolves to a concrete mlx-community model,
 * but only for the mlx-whisper flavor (the presence of the mlx_whisper binary
 * IS the Apple-Silicon signal here — no separate platform probe). The custom
 * flavor (CASTRECALL_WHISPER_COMMAND) is an explicit user-supplied command
 * that never consumes model/preset, so a leftover preset value is not an
 * error for it. Every consumer that needs to know or show the concrete
 * model — readiness, setup output, the provider label, and exec argv — must
 * call this, never read config.localWhisper.model directly.
 */
export function resolveWhisperModel(flavor, localWhisperConfig) {
    if (localWhisperConfig.model) {
        return { model: localWhisperConfig.model, source: "explicit" };
    }
    const preset = localWhisperConfig.preset;
    if (!preset)
        return { source: "none" };
    if (flavor === "custom")
        return { source: "none", preset };
    if (flavor !== "mlx-whisper") {
        return { source: "none", preset, reason: WHISPER_PRESET_NON_MLX_MESSAGE };
    }
    const presetModel = WHISPER_PRESETS[preset];
    if (!presetModel) {
        return { source: "none", preset, reason: WHISPER_PRESET_UNKNOWN_MESSAGE };
    }
    return { model: presetModel, source: "preset", preset };
}
const VALID_OUTPUT_FORMATS = ["txt", "json", "vtt", "srt"];
const WHISPER_CPP_FORMAT_FLAGS = {
    json: "-oj",
    vtt: "-ovtt",
    srt: "-osrt",
};
/**
 * Single source of truth mapping abstract decode intents (issue #53:
 * language, condition-on-previous-text loop prevention, word timestamps,
 * structured output, hallucination/silence thresholds) to concrete per-
 * flavor CLI flags. Every option lands in `applied` with the flag it
 * produced, or in `ignored` with a reason — nothing is silently dropped
 * (the "fail clearly or ignored with explicit provenance" criterion). The
 * `custom` flavor applies nothing (the user owns the whole command
 * template) but every decode control it bypasses — INCLUDING CastRecall's
 * own loop-prevention default — is reported in `ignored`, so
 * setup/status/rung provenance shows exactly which guardrails a custom
 * command is running without.
 */
export function resolveWhisperDecodeArgs(flavor, decode) {
    if (flavor === "custom") {
        const ignored = [];
        const customReason = "CASTRECALL_WHISPER_COMMAND owns its full command line; CastRecall adds no decode flags. " +
            "Include the equivalent flag in the command template itself.";
        // Surfaced for BOTH values: false is CastRecall's loop-prevention
        // default that the custom command runs without, and an explicit true
        // is a user-configured control that is equally not applied.
        ignored.push({
            option: "conditionOnPreviousText",
            reason: decode.conditionOnPreviousText
                ? customReason
                : "CastRecall's loop-prevention default (condition-on-previous-text off) is NOT applied " +
                    `to a custom command. ${customReason}`,
        });
        if (decode.language)
            ignored.push({ option: "language", reason: customReason });
        if (decode.wordTimestamps)
            ignored.push({ option: "wordTimestamps", reason: customReason });
        if (decode.noSpeechThreshold !== undefined) {
            ignored.push({ option: "noSpeechThreshold", reason: customReason });
        }
        if (decode.logprobThreshold !== undefined) {
            ignored.push({ option: "logprobThreshold", reason: customReason });
        }
        if (decode.compressionRatioThreshold !== undefined) {
            ignored.push({ option: "compressionRatioThreshold", reason: customReason });
        }
        if (decode.hallucinationSilenceThreshold !== undefined) {
            ignored.push({ option: "hallucinationSilenceThreshold", reason: customReason });
        }
        if (decode.outputFormat !== "txt") {
            ignored.push({ option: "outputFormat", reason: customReason });
        }
        return { args: [], applied: [], ignored, outputFormat: "txt" };
    }
    const ignored = [];
    const ignore = (option, reason) => ignored.push({ option, reason });
    let outputFormat = "txt";
    if (VALID_OUTPUT_FORMATS.includes(decode.outputFormat)) {
        outputFormat = decode.outputFormat;
    }
    else {
        ignore("outputFormat", `CASTRECALL_WHISPER_OUTPUT_FORMAT="${decode.outputFormat}" is not one of ` +
            `${VALID_OUTPUT_FORMATS.join(", ")}; falling back to txt.`);
    }
    const applied = [];
    const args = [];
    if (decode.language) {
        args.push(...(flavor === "whisper.cpp" ? ["-l", decode.language] : ["--language", decode.language]));
        applied.push("language");
    }
    else if (flavor === "whisper.cpp") {
        // whisper.cpp's CLI defaults -l to "en", not auto-detect, so an unset
        // language hint must explicitly request auto-detect to match the
        // documented "unset = auto-detect" behavior other flavors get for free.
        args.push("-l", "auto");
    }
    // Loop-prevention default for long-form podcasts (issue #53): repeating
    // prior output back as decoding context is a primary driver of Whisper
    // repetition loops, so this is honored (and reported as applied) whenever
    // it's false, which is CastRecall's own default.
    if (!decode.conditionOnPreviousText) {
        if (flavor === "whisper.cpp") {
            args.push("-mc", "0");
        }
        else if (flavor === "mlx-whisper") {
            args.push("--condition-on-previous-text", "False");
        }
        else {
            args.push("--condition_on_previous_text", "False");
        }
        applied.push("conditionOnPreviousText");
    }
    // Two distinct concerns share the word-timestamp flag on Python-backed
    // flavors: (a) STORING word-level timing, which only survives into a
    // json artifact — requesting it with txt/vtt/srt output is reported as
    // ignored, not applied (that would be false provenance); and (b) the
    // word-timestamp DECODE path, which hallucinationSilenceThreshold needs
    // regardless of what artifact is stored — so the decode flag is also
    // enabled whenever that threshold is set.
    const needsWordTimestampDecode = flavor !== "whisper.cpp" &&
        (decode.wordTimestamps || decode.hallucinationSilenceThreshold !== undefined);
    if (needsWordTimestampDecode) {
        args.push(flavor === "mlx-whisper" ? "--word-timestamps" : "--word_timestamps", "True");
    }
    if (decode.wordTimestamps) {
        if (flavor === "whisper.cpp") {
            if (outputFormat === "json") {
                args.push("-ojf");
                applied.push("wordTimestamps");
            }
            else {
                ignore("wordTimestamps", "whisper.cpp only carries word-level timing in its full-JSON -ojf output; set " +
                    "CASTRECALL_WHISPER_OUTPUT_FORMAT=json to use this.");
            }
        }
        else if (outputFormat === "json") {
            applied.push("wordTimestamps");
        }
        else {
            ignore("wordTimestamps", `${flavor} decodes with word timing, but the stored ${outputFormat} output cannot ` +
                "carry it. Set CASTRECALL_WHISPER_OUTPUT_FORMAT=json to store word-level timestamps.");
        }
    }
    applyThreshold(flavor, decode.noSpeechThreshold, "noSpeechThreshold", args, applied, ignore, {
        "whisper.cpp": "-nth",
        "mlx-whisper": "--no-speech-threshold",
        "openai-whisper": "--no_speech_threshold",
        "whisper-ctranslate2": "--no_speech_threshold",
    });
    applyThreshold(flavor, decode.logprobThreshold, "logprobThreshold", args, applied, ignore, {
        "whisper.cpp": "-lpt",
        "mlx-whisper": "--logprob-threshold",
        "openai-whisper": "--logprob_threshold",
        "whisper-ctranslate2": "--logprob_threshold",
    });
    applyThreshold(flavor, decode.compressionRatioThreshold, "compressionRatioThreshold", args, applied, ignore, {
        "mlx-whisper": "--compression-ratio-threshold",
        "openai-whisper": "--compression_ratio_threshold",
        "whisper-ctranslate2": "--compression_ratio_threshold",
    });
    // mlx-whisper, openai-whisper, and whisper-ctranslate2 only act on
    // hallucination_silence_threshold inside their word-timestamp decode
    // path — which `needsWordTimestampDecode` above enables whenever this
    // threshold is set, independent of the stored output format. It is a
    // decode-time anti-hallucination guardrail, not an artifact feature.
    applyThreshold(flavor, decode.hallucinationSilenceThreshold, "hallucinationSilenceThreshold", args, applied, ignore, {
        "mlx-whisper": "--hallucination-silence-threshold",
        "openai-whisper": "--hallucination_silence_threshold",
        "whisper-ctranslate2": "--hallucination_silence_threshold",
    });
    return { args, applied, ignored, outputFormat };
}
/**
 * Which of explicit/preset/backend-default/none produced a resolved model —
 * shared with the transcription preflight (issue #55) so its `modelSource`
 * can never disagree with the provenance a real run would record.
 */
export function deriveModelSource(flavor, resolved) {
    if (resolved.source !== "none")
        return resolved.source;
    return flavor === "custom" ? "none" : "backend-default";
}
function buildDecodeApplied(decode, applied) {
    const values = {};
    for (const option of applied) {
        switch (option) {
            case "language":
                if (decode.language)
                    values.language = decode.language;
                break;
            case "conditionOnPreviousText":
                // Only ever applied when the resolved value is false (CastRecall's loop-prevention default).
                values.conditionOnPreviousText = false;
                break;
            case "wordTimestamps":
                values.wordTimestamps = true;
                break;
            case "noSpeechThreshold":
                if (decode.noSpeechThreshold !== undefined)
                    values.noSpeechThreshold = decode.noSpeechThreshold;
                break;
            case "logprobThreshold":
                if (decode.logprobThreshold !== undefined)
                    values.logprobThreshold = decode.logprobThreshold;
                break;
            case "compressionRatioThreshold":
                if (decode.compressionRatioThreshold !== undefined) {
                    values.compressionRatioThreshold = decode.compressionRatioThreshold;
                }
                break;
            case "hallucinationSilenceThreshold":
                if (decode.hallucinationSilenceThreshold !== undefined) {
                    values.hallucinationSilenceThreshold = decode.hallucinationSilenceThreshold;
                }
                break;
        }
    }
    return values;
}
function buildGeneration(flavor, resolved, decodeResolution, decode, toolVersion) {
    const modelSource = deriveModelSource(flavor, resolved);
    return {
        kind: "local-whisper",
        backend: flavor,
        model: resolved.model,
        modelSource,
        usesBackendDefault: modelSource === "backend-default",
        preset: resolved.preset,
        outputFormat: decodeResolution.outputFormat,
        wordTimestamps: decodeResolution.applied.includes("wordTimestamps"),
        decode: {
            applied: buildDecodeApplied(decode, decodeResolution.applied),
            ignored: decodeResolution.ignored,
        },
        toolVersion,
    };
}
/**
 * Best-effort `<tool> --version` probe, cheap enough to run on every
 * transcription: short timeout, every failure mode (non-zero exit, throw,
 * timeout) swallowed to `undefined` so a broken/slow `--version` can never
 * fail or meaningfully delay a transcription. Skipped for the `custom`
 * flavor, whose `command` is an `{input}` template rather than a directly
 * runnable binary.
 */
async function probeToolVersion(detected, execImpl) {
    if (detected.flavor === "custom")
        return undefined;
    try {
        const result = await execImpl([detected.command, "--version"], { timeoutMs: 5_000 });
        if (result.code !== 0)
            return undefined;
        return result.stdout.trim().split("\n")[0]?.trim() || undefined;
    }
    catch {
        return undefined;
    }
}
function applyThreshold(flavor, value, option, args, applied, ignore, flagByFlavor) {
    if (value === undefined)
        return;
    const flag = flagByFlavor[flavor];
    if (!flag) {
        ignore(option, `${flavor} does not support ${option}.`);
        return;
    }
    args.push(flag, String(value));
    applied.push(option);
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
export function localWhisperReadiness(detection, localWhisperConfig) {
    const detected = Boolean(detection.detected);
    const flavor = detection.detected?.flavor;
    const resolved = resolveWhisperModel(flavor, localWhisperConfig);
    const hasModel = Boolean(resolved.model);
    // A preset that fails to resolve (unknown value, or used on a non-mlx
    // flavor) is a configuration error, not a "low quality" tradeoff — it must
    // not be silently bypassed by CASTRECALL_WHISPER_ALLOW_LOW_QUALITY, or
    // readiness would say "ready" for a preset value that runWhisper rejects.
    const presetError = Boolean(localWhisperConfig.preset && resolved.reason);
    const needsModel = presetError ||
        (flavor === "whisper.cpp" && !hasModel) ||
        (flavor === "mlx-whisper" && !hasModel && !localWhisperConfig.allowLowQuality);
    const reason = needsModel
        ? presetError
            ? resolved.reason
            : flavor === "whisper.cpp"
                ? WHISPER_CPP_MODEL_MISSING_MESSAGE
                : MLX_WHISPER_MODEL_MISSING_MESSAGE
        : undefined;
    return { ready: detected && !needsModel, detected, needsModel, reason };
}
export async function detectLocalWhisper(config, env = process.env) {
    if (config.localWhisper.disabled) {
        return { reason: "Local Whisper is disabled via CASTRECALL_DISABLE_LOCAL_WHISPER." };
    }
    if (config.localWhisper.command) {
        if (!config.localWhisper.command.includes("{input}")) {
            return {
                reason: "CASTRECALL_WHISPER_COMMAND is set but has no {input} placeholder for the audio file path.",
            };
        }
        return { detected: { flavor: "custom", command: config.localWhisper.command } };
    }
    for (const candidate of KNOWN_BINARIES) {
        const found = await findOnPath(candidate.name, env.PATH ?? "");
        if (found)
            return { detected: { flavor: candidate.flavor, command: found } };
    }
    return {
        reason: "No local Whisper CLI detected on PATH (looked for " +
            `${KNOWN_BINARIES.map((b) => b.name).join(", ")}). Install one — e.g. ` +
            "'brew install whisper-cpp' plus a ggml model, 'pip install mlx-whisper' on Apple Silicon, " +
            "or 'pip install openai-whisper' — or set CASTRECALL_WHISPER_COMMAND. " +
            "Free and fully private once installed.",
    };
}
export async function findOnPath(binary, pathVar) {
    for (const dir of pathVar.split(path.delimiter).filter(Boolean)) {
        const candidate = path.join(dir, binary);
        try {
            await fs.access(candidate, fs.constants.X_OK);
            const stat = await fs.stat(candidate);
            if (stat.isFile())
                return candidate;
        }
        catch {
            // not here; keep looking
        }
    }
    return undefined;
}
export async function transcribeWithLocalWhisper(config, audioUrl, deps = {}) {
    const detection = await detectLocalWhisper(config, deps.env ?? process.env);
    if (!detection.detected)
        throw new CastrecallSetupError(detection.reason);
    if (!audioUrl)
        throw new Error("Episode has no audio URL; cannot transcribe locally.");
    const fetchImpl = deps.fetchImpl ?? fetch;
    const execImpl = deps.execImpl ?? defaultExec;
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "castrecall-whisper-"));
    try {
        const audioPath = await downloadAudio(fetchImpl, audioUrl, workDir);
        const produced = await runWhisper(detection.detected, config, audioPath, workDir, execImpl, deps.env);
        const text = produced.format === "txt"
            ? produced.raw.trim()
            : normalizeTranscript(produced.raw, produced.format).text.trim();
        if (!text) {
            throw new Error(`${detection.detected.flavor} produced an empty transcript.`);
        }
        return {
            text,
            raw: produced.raw,
            format: produced.format,
            provider: providerLabel(detection.detected, config),
            ignoredOptions: produced.ignoredOptions,
            generation: produced.generation,
        };
    }
    finally {
        await fs.rm(workDir, { recursive: true, force: true });
    }
}
async function downloadAudio(fetchImpl, audioUrl, workDir) {
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
async function runWhisper(detected, config, audioPath, workDir, execImpl, env = process.env) {
    const resolved = resolveWhisperModel(detected.flavor, config.localWhisper);
    const model = resolved.model;
    const decodeResolution = resolveWhisperDecodeArgs(detected.flavor, config.localWhisper.decode);
    const generation = (toolVersion) => buildGeneration(detected.flavor, resolved, decodeResolution, config.localWhisper.decode, toolVersion);
    switch (detected.flavor) {
        case "custom": {
            const command = detected.command
                .replaceAll("{input}", shellQuote(audioPath))
                .replaceAll("{model}", model ? shellQuote(model) : "");
            const result = await execImpl(["/bin/sh", "-c", command], {
                timeoutMs: TRANSCRIBE_TIMEOUT_MS,
            });
            assertExitOk(result, "custom whisper command");
            return {
                raw: result.stdout,
                format: "txt",
                ignoredOptions: decodeResolution.ignored,
                generation: generation(undefined),
            };
        }
        case "whisper.cpp": {
            if (!model) {
                throw new CastrecallSetupError(WHISPER_CPP_MODEL_MISSING_MESSAGE);
            }
            const toolVersion = await probeToolVersion(detected, execImpl);
            const input = await ensureWav(audioPath, workDir, execImpl, env);
            const format = decodeResolution.outputFormat;
            if (format === "txt") {
                const result = await execImpl([detected.command, "-m", model, "-f", input, "-np", "-nt", ...decodeResolution.args], { timeoutMs: TRANSCRIBE_TIMEOUT_MS });
                assertExitOk(result, "whisper.cpp");
                return {
                    raw: result.stdout,
                    format,
                    ignoredOptions: decodeResolution.ignored,
                    generation: generation(toolVersion),
                };
            }
            // Controlled output base: whisper.cpp appends .<format> to -of itself,
            // so the exact file we read is the exact path we asked it to write —
            // no filename-convention guessing for structured output.
            const outputBase = path.join(workDir, "episode");
            const result = await execImpl([
                detected.command,
                "-m",
                model,
                "-f",
                input,
                WHISPER_CPP_FORMAT_FLAGS[format],
                "-of",
                outputBase,
                ...decodeResolution.args,
            ], { timeoutMs: TRANSCRIBE_TIMEOUT_MS });
            assertExitOk(result, "whisper.cpp");
            let raw;
            try {
                raw = await fs.readFile(`${outputBase}.${format}`, "utf8");
            }
            catch {
                throw new Error(`whisper.cpp produced no ${format} output.`);
            }
            return { raw, format, ignoredOptions: decodeResolution.ignored, generation: generation(toolVersion) };
        }
        case "openai-whisper":
        case "whisper-ctranslate2": {
            const toolVersion = await probeToolVersion(detected, execImpl);
            const format = decodeResolution.outputFormat;
            const argv = [
                detected.command,
                audioPath,
                "--output_format",
                format,
                "--output_dir",
                workDir,
                "--verbose",
                "False",
                ...(model ? ["--model", model] : []),
                ...decodeResolution.args,
            ];
            const result = await execImpl(argv, { timeoutMs: TRANSCRIBE_TIMEOUT_MS });
            assertExitOk(result, detected.flavor);
            const raw = await readProduced(workDir, audioPath, format, format === "txt");
            return { raw, format, ignoredOptions: decodeResolution.ignored, generation: generation(toolVersion) };
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
            const toolVersion = await probeToolVersion(detected, execImpl);
            const format = decodeResolution.outputFormat;
            const argv = [
                detected.command,
                audioPath,
                "--output-dir",
                workDir,
                "--output-format",
                format,
                ...(model ? ["--model", model] : []),
                ...decodeResolution.args,
            ];
            const result = await execImpl(argv, { timeoutMs: TRANSCRIBE_TIMEOUT_MS });
            assertExitOk(result, "mlx-whisper");
            const raw = await readProduced(workDir, audioPath, format, format === "txt");
            return { raw, format, ignoredOptions: decodeResolution.ignored, generation: generation(toolVersion) };
        }
    }
}
/** whisper.cpp wants 16 kHz mono WAV; convert with ffmpeg when the input isn't WAV. */
async function ensureWav(audioPath, workDir, execImpl, env) {
    if (audioPath.endsWith(".wav"))
        return audioPath;
    const ffmpeg = await findOnPath("ffmpeg", env.PATH ?? "");
    if (!ffmpeg) {
        throw new CastrecallSetupError("whisper.cpp needs 16 kHz WAV input and the episode audio is not WAV. " +
            "Install ffmpeg (e.g. 'brew install ffmpeg'), or use another Whisper CLI " +
            "(openai-whisper / mlx-whisper decode audio themselves).");
    }
    const wavPath = path.join(workDir, "episode.wav");
    const result = await execImpl([ffmpeg, "-y", "-i", audioPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath], { timeoutMs: 10 * 60_000 });
    assertExitOk(result, "ffmpeg conversion");
    return wavPath;
}
/**
 * Reads the file a Whisper CLI produced from --output-dir/--output-format.
 * The "take any file it produced" fallback is retained only for txt (some
 * CLIs name plain-text outputs differently) — structured formats never fall
 * back to a stale/other file, they either match the exact expected name or
 * fail clearly.
 */
async function readProduced(workDir, audioPath, ext, allowFallback) {
    const base = path.basename(audioPath).replace(/\.[^.]+$/, "");
    const expected = path.join(workDir, `${base}.${ext}`);
    try {
        return await fs.readFile(expected, "utf8");
    }
    catch {
        if (allowFallback) {
            const entries = await fs.readdir(workDir);
            const match = entries.find((name) => name.endsWith(`.${ext}`));
            if (match)
                return fs.readFile(path.join(workDir, match), "utf8");
        }
        throw new Error(`Whisper run finished but produced no ${ext} output.`);
    }
}
function providerLabel(detected, config) {
    const resolved = resolveWhisperModel(detected.flavor, config.localWhisper);
    const modelPart = resolved.model ? `:${path.basename(resolved.model)}` : "";
    return `local-whisper:${detected.flavor}${modelPart}`;
}
function assertExitOk(result, label) {
    if (result.code === 0)
        return;
    const stderrTail = result.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 500);
    throw new Error(`${label} exited with code ${result.code ?? "null (timeout/signal)"}${stderrTail ? `: ${stderrTail}` : ""}`);
}
function shellQuote(value) {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}
function defaultExec(argv, options) {
    return new Promise((resolve, reject) => {
        const [command, ...args] = argv;
        const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
        child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
        child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
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
