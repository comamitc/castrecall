/**
 * Chained pipeline for scheduled/background runs: sync history → fetch
 * transcripts for newly seen listens → generate review candidates for
 * episodes newly stored this run (corpus export chains inside
 * `fetchTranscript` already, when `CASTRECALL_EXPORT_DIR` is set).
 *
 * A run lock (renewed on a heartbeat so a long-running invocation, e.g. local
 * Whisper transcription, is never mistaken for a crashed one) keeps two
 * overlapping scheduler invocations from both hitting the unofficial Pocket
 * Casts API; a cooldown gate with capped exponential backoff keeps a
 * persistently failing API from being hammered on every scheduler tick. This
 * module has no knowledge of cron or intervals for *scheduling* runs — see
 * the README's "Scheduled / periodic sync" section for the actual scheduling
 * recipes.
 */
import { type ResolvedConfig } from "./config.js";
import { type ToolDeps } from "./tools.js";
export type PipelineParams = {
    limit?: number;
    /** Bypass the cooldown gate for a manual recovery run. Never use from a scheduler recipe. */
    force?: boolean;
    /**
     * Break a STALE run lock (one whose heartbeat stopped > LOCK_TTL_MS ago,
     * i.e. a hard-killed run) after a human confirmed no run is alive. Never
     * breaks a live lock. Never use from a scheduler recipe.
     */
    breakStaleLock?: boolean;
};
export declare function runPipeline(config: ResolvedConfig, params?: PipelineParams, deps?: ToolDeps): Promise<unknown>;
