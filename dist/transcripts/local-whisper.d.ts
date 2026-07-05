/**
 * Rung 3 of the transcript ladder: local Whisper — free and fully private.
 *
 * Nothing is bundled: this rung auto-detects a Whisper CLI the user already
 * has installed (whisper.cpp, openai-whisper, whisper-ctranslate2, or
 * mlx-whisper) and is skipped with an actionable message when none is found.
 * A custom command can be supplied via CASTRECALL_WHISPER_COMMAND with an
 * {input} placeholder; its stdout is treated as the transcript.
 */
import { type ResolvedConfig } from "../config.js";
import type { FetchLike } from "../pocketcasts/client.js";
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
/**
 * Single source of truth for whether the local Whisper rung can actually RUN
 * (not merely whether a binary was detected): whisper.cpp additionally needs
 * a ggml model via CASTRECALL_WHISPER_MODEL. Status surfaces must use this,
 * never raw detection, or they report "ready" for a rung that will throw.
 */
export declare function localWhisperReadiness(detection: WhisperDetection, localWhisperConfig: {
    model?: string;
}): {
    ready: boolean;
    needsModel: boolean;
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
    provider: string;
}>;
export {};
