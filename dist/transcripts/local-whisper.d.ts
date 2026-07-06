/**
 * Rung 3 of the transcript ladder: local Whisper — free and fully private.
 *
 * Nothing is bundled: this rung auto-detects a Whisper CLI the user already
 * has installed (whisper.cpp, openai-whisper, whisper-ctranslate2, or
 * mlx-whisper) and is skipped with an actionable message when none is found.
 * A custom command can be supplied via CASTRECALL_WHISPER_COMMAND with an
 * {input} placeholder; its stdout is treated as the transcript.
 */
import { type ResolvedConfig, type WhisperDecodeConfig } from "../config.js";
import type { FetchLike } from "../pocketcasts/client.js";
import { type TranscriptFormat } from "./normalize.js";
declare const KNOWN_BINARIES: readonly [{
    readonly name: "whisper-cli";
    readonly flavor: "whisper.cpp";
}, {
    readonly name: "whisper-cpp";
    readonly flavor: "whisper.cpp";
}, {
    readonly name: "mlx_whisper";
    readonly flavor: "mlx-whisper";
}, {
    readonly name: "whisper-ctranslate2";
    readonly flavor: "whisper-ctranslate2";
}, {
    readonly name: "whisper";
    readonly flavor: "openai-whisper";
}];
export type WhisperFlavor = (typeof KNOWN_BINARIES)[number]["flavor"] | "custom";
export type DetectedWhisper = {
    flavor: WhisperFlavor;
    /** Absolute binary path, or the raw command template for the custom flavor. */
    command: string;
};
export type WhisperDetection = {
    detected: DetectedWhisper;
    reason?: undefined;
} | {
    detected?: undefined;
    reason: string;
};
export declare const WHISPER_CPP_MODEL_MISSING_MESSAGE: string;
export declare const MLX_WHISPER_MODEL_MISSING_MESSAGE: string;
/**
 * CastRecall-managed quality presets for Apple Silicon local transcription
 * (mlx-whisper only). `best` is the only #51-quality-approved model; `balanced`
 * aliases it today and can diverge to a validated mid-tier model later with no
 * env/API change; `fast` is an explicit, lower-quality opt-in — never an
 * accidental default.
 */
export declare const WHISPER_PRESETS: {
    readonly best: "mlx-community/whisper-large-v3-turbo";
    readonly balanced: "mlx-community/whisper-large-v3-turbo";
    readonly fast: "mlx-community/whisper-small-mlx";
};
export type WhisperPreset = keyof typeof WHISPER_PRESETS;
export declare const WHISPER_PRESET_UNKNOWN_MESSAGE = "CASTRECALL_LOCAL_WHISPER_PRESET must be one of: fast, balanced, best.";
export declare const WHISPER_PRESET_NON_MLX_MESSAGE: string;
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
 * IS the Apple-Silicon signal here — no separate platform probe). The custom
 * flavor (CASTRECALL_WHISPER_COMMAND) is an explicit user-supplied command
 * that never consumes model/preset, so a leftover preset value is not an
 * error for it. Every consumer that needs to know or show the concrete
 * model — readiness, setup output, the provider label, and exec argv — must
 * call this, never read config.localWhisper.model directly.
 */
export declare function resolveWhisperModel(flavor: WhisperFlavor | undefined, localWhisperConfig: {
    model?: string;
    preset?: string;
}): WhisperModelResolution;
/** Structured/timestamped output formats a local Whisper CLI can be asked to produce (issue #53). */
export type WhisperOutputFormat = Exclude<TranscriptFormat, "html">;
export type WhisperDecodeIgnored = {
    option: string;
    reason: string;
};
export type WhisperDecodeResolution = {
    /** Argv elements for the decode intents this flavor honors (excludes output-format/dir flags — callers build those from `outputFormat`). */
    args: string[];
    applied: string[];
    ignored: WhisperDecodeIgnored[];
    outputFormat: WhisperOutputFormat;
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
export declare function resolveWhisperDecodeArgs(flavor: WhisperFlavor, decode: WhisperDecodeConfig): WhisperDecodeResolution;
export type LocalWhisperModelSource = "explicit" | "preset" | "backend-default" | "none";
/**
 * Exact local-transcription provenance (issue #54): which backend family,
 * concrete model/preset, decode settings, and output shape actually produced
 * a transcript — not merely "local-whisper", which hides the difference
 * between e.g. whisper-tiny and large-v3-turbo. Assembled once, in
 * `buildGeneration`, from the exact `resolveWhisperModel`/
 * `resolveWhisperDecodeArgs` results a run used — it can never disagree with
 * the argv actually executed.
 */
export type LocalWhisperGeneration = {
    kind: "local-whisper";
    backend: WhisperFlavor;
    /** Concrete model id/path; undefined when the backend ran its own default or the flavor is custom. */
    model?: string;
    modelSource: LocalWhisperModelSource;
    /**
     * True when no model was pinned (no explicit model, no preset) and the
     * backend ran with its own internal default — the auditable "this corpus
     * may have been generated with a poor default model" red flag the issue
     * exists to surface. CastRecall never fabricates a concrete default model
     * string here: it genuinely doesn't observe one (no --model flag is passed).
     */
    usesBackendDefault: boolean;
    preset?: string;
    outputFormat: WhisperOutputFormat;
    /** Whether word-level timestamps actually survived into the stored artifact (not merely requested). */
    wordTimestamps: boolean;
    decode: {
        /** Effective option -> concrete value, for the decode options this run actually applied. */
        applied: Record<string, string | number | boolean>;
        /** Decode options this run bypassed, verbatim from resolveWhisperDecodeArgs, with reasons. */
        ignored: WhisperDecodeIgnored[];
    };
    /** Best-effort `<tool> --version` output; undefined when unavailable or not cheaply probeable (custom flavor). */
    toolVersion?: string;
};
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
export declare function localWhisperReadiness(detection: WhisperDetection, localWhisperConfig: {
    model?: string;
    preset?: string;
    allowLowQuality?: boolean;
}): {
    ready: boolean;
    detected: boolean;
    needsModel: boolean;
    reason?: string;
};
export type ExecResult = {
    code: number | null;
    stdout: string;
    stderr: string;
};
export type ExecImpl = (argv: string[], options: {
    timeoutMs: number;
}) => Promise<ExecResult>;
export declare function detectLocalWhisper(config: ResolvedConfig, env?: NodeJS.ProcessEnv): Promise<WhisperDetection>;
export declare function findOnPath(binary: string, pathVar: string): Promise<string | undefined>;
export declare function transcribeWithLocalWhisper(config: ResolvedConfig, audioUrl: string, deps?: {
    fetchImpl?: FetchLike;
    execImpl?: ExecImpl;
    env?: NodeJS.ProcessEnv;
}): Promise<{
    text: string;
    raw: string;
    format: WhisperOutputFormat;
    provider: string;
    ignoredOptions: WhisperDecodeIgnored[];
    generation: LocalWhisperGeneration;
}>;
export {};
