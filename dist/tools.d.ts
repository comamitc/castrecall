/**
 * Implementations behind the CastRecall tools. Pure functions over
 * (config, params) so they are testable without the OpenClaw runtime.
 */
import { type ResolvedConfig } from "./config.js";
import { type ExportResult } from "./corpus-export.js";
import { type FetchLike } from "./pocketcasts/client.js";
import { Storage, type ListenRecord } from "./storage.js";
export type ToolDeps = {
    fetchImpl?: FetchLike;
    now?: () => Date;
    env?: NodeJS.ProcessEnv;
};
/**
 * Opt-in corpus export: off unless config.exportDir is set. Reads only the
 * stored transcript + provenance sidecar (never review candidates or
 * state.json) and recomputes the content hash for legacy sidecars that
 * predate it, so export never emits an undefined content_hash.
 */
/**
 * Run the opt-in corpus export for an episode and persist the outcome:
 * `exportedAt` on success (clearing any prior `exportError`), `exportError`
 * on failure. Never throws — a failed export must not mask the successful
 * transcript stage, and the persisted error is what lets scheduled runs
 * retry the export later and setup_status surface it.
 */
export declare function exportAndRecord(config: ResolvedConfig, storage: Storage, record: ListenRecord, now?: () => Date): Promise<ExportResult | {
    error: string;
} | undefined>;
export declare function setupStatus(config: ResolvedConfig, deps?: ToolDeps): Promise<unknown>;
/**
 * Guided first-run setup: reports what's configured/missing/optional and,
 * with { verify: true } and both credentials present, makes one read-only
 * Pocket Casts call (login + history fetch) to confirm they work. Never
 * constructs Storage, never writes to disk, and never returns secret values
 * or transcript/episode content — only booleans, counts, and plain-language
 * explanations.
 */
export declare function setup(config: ResolvedConfig, params?: {
    verify?: boolean;
}, deps?: ToolDeps): Promise<unknown>;
export declare function syncHistory(config: ResolvedConfig, params: {
    limit?: number;
}, deps?: ToolDeps): Promise<unknown>;
export declare function listRecent(config: ResolvedConfig, params: {
    limit?: number;
}): Promise<unknown>;
export declare function fetchTranscript(config: ResolvedConfig, params: {
    episodeUuid: string;
}, deps?: ToolDeps): Promise<unknown>;
export declare function generateReview(config: ResolvedConfig, params: {
    episodeUuid?: string;
}, deps?: ToolDeps): Promise<unknown>;
