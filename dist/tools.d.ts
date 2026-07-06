/**
 * Implementations behind the CastRecall tools. Pure functions over
 * (config, params) so they are testable without the OpenClaw runtime.
 */
import { type ResolvedConfig } from "./config.js";
import { type ExportResult } from "./corpus-export.js";
import type { FetchLike } from "./pocketcasts/client.js";
import { type ExecImpl } from "./pocketcasts/secret-store.js";
import { type TranscriptionPreflight } from "./transcripts/preflight.js";
import { Storage, type ListenRecord } from "./storage.js";
export type ToolDeps = {
    fetchImpl?: FetchLike;
    execImpl?: ExecImpl;
    now?: () => Date;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
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
/**
 * Read-only corpus-scale transcription preflight (issue #55): the "look
 * before you leap" surface for a large batch — run this before
 * castrecall_run_pipeline. Reads synced state and detects the local Whisper
 * CLI, but never writes to storage; the pipeline itself computes the same
 * report and enforces the block (see runPipeline), so a corpus run can never
 * silently generate transcripts with a low-quality model.
 */
export declare function transcriptionPreflight(config: ResolvedConfig, deps?: ToolDeps): Promise<TranscriptionPreflight>;
export declare function syncHistory(config: ResolvedConfig, params: {
    limit?: number;
}, deps?: ToolDeps): Promise<unknown>;
export declare function listRecent(config: ResolvedConfig, params: {
    limit?: number;
}): Promise<unknown>;
export declare function fetchTranscript(config: ResolvedConfig, params: {
    episodeUuid: string;
    scheduled?: boolean;
    /** Corpus-scale preflight (issue #55) blocked low-quality local generation for this run; never set by the castrecall_fetch_transcript tool itself, so a direct single-episode call is never gated. */
    skipLocalWhisper?: boolean;
    /** Corpus-scale preflight (issue #55) also blocked the paid cloud STT fallback for this run, since it would otherwise run as the very next rung right behind the blocked local Whisper one; never set by the castrecall_fetch_transcript tool itself. */
    skipStt?: boolean;
}, deps?: ToolDeps): Promise<unknown>;
export declare function generateReview(config: ResolvedConfig, params: {
    episodeUuid?: string;
}, deps?: ToolDeps): Promise<unknown>;
/**
 * Disposition a pending review candidate. This is the only path in
 * CastRecall that can promote content anywhere outside the private data
 * dir — the gate is contractual, not technical: the tool description
 * instructs callers to invoke this only after explicit human confirmation
 * in conversation, the same trust model as every other agent tool. A
 * `promote` requires the exact human-chosen `content`; CastRecall itself
 * never decides what to keep.
 */
export declare function resolveReview(config: ResolvedConfig, params: {
    episodeUuid: string;
    disposition: "promote" | "discard";
    content?: string;
    title?: string;
}, deps?: ToolDeps): Promise<unknown>;
/**
 * Keyword/phrase search over stored transcripts. Read-only: assembles the
 * corpus from state.json + sources/<uuid>/ (mirroring exportIfEnabled's
 * contentHash ?? sha256(text) legacy fallback) and delegates reconciliation,
 * scoring, and snippet-building to SearchIndex — see search.ts.
 */
export declare function search(config: ResolvedConfig, params: {
    query: string;
    limit?: number;
}): Promise<unknown>;
/**
 * Cross-episode digest over a recent time window, filtered on `firstSeenAt`
 * — the only honest "when I absorbed it" signal in v0 (Pocket Casts episodes
 * carry no listened-at timestamp; provenance.listenTimestamp is itself
 * derived from firstSeenAt in fetchTranscript above). Mirrors generateReview:
 * loads state, reads transcripts for stored episodes, builds a pure
 * structural document, and writes it to the same approval-gated review lane.
 */
export declare function digest(config: ResolvedConfig, params: {
    days?: number;
}, deps?: ToolDeps): Promise<unknown>;
