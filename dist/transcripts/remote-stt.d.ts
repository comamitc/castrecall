/**
 * Generic remote STT provider contract (issue #61): lets CastRecall call a
 * private/self-hosted speech-to-text service — WhisperX, faster-whisper, or
 * anything else — as an implementation of `CASTRECALL_STT_PROVIDER=remote-stt`,
 * without the transcript ladder knowing which implementation actually ran.
 *
 * Contract (normative — mirrored verbatim in README):
 * - Every request carries `Authorization: Bearer <token>` when a token is configured.
 * - `GET {base}/health` — 200 (optionally `{ status, implementation, version, model, model_ready,
 *   capabilities: { diarization, timestamps }, accepts }`) means ready (or degraded, see
 *   `remoteSttHealth`'s tri-state — issue #63); any non-2xx or network failure means unavailable;
 *   401/403 means unavailable due to auth. Never throws.
 * - `POST {base}/transcribe` — JSON `{ audio_url, model? }` by default, or
 *   `multipart/form-data` with a `file` field (+ `model`) when
 *   `CASTRECALL_REMOTE_STT_UPLOAD=true` — upload mode downloads the audio itself
 *   and never also sends `audio_url`.
 * - Response is either a normalized result object directly (sync), or
 *   `{ job_id, status }` (async), polled via `GET {base}/jobs/{job_id}` until
 *   `status` is `"completed"` (reads `result`, falling back to the body itself)
 *   or `"failed"` (terminal).
 * - Normalized result: `{ text?, segments?, model?, implementation?, warnings?, duration? }`.
 *   `segments[].start/end` are seconds. `text` or non-empty `segments` is
 *   required; when `text` is absent it is synthesized from `segments`.
 */
import { type ResolvedConfig } from "../config.js";
import type { FetchLike } from "../pocketcasts/client.js";
import { type SttResult } from "./stt.js";
/**
 * Exact remote-stt provenance (issue #61): implementation/model as reported
 * by the remote service, host-only base URL (never the token or full
 * path/query — see `baseUrlHost` below), and how the job actually ran.
 */
export type RemoteSttGeneration = {
    kind: "remote-stt";
    implementation?: string;
    model?: string;
    /** `new URL(base).host` — deliberately never the full base URL (may carry a path/query) or the token. */
    baseUrlHost: string;
    mode: "sync" | "async";
    submittedBy: "audio_url" | "upload";
    warnings?: string[];
    durationSeconds?: number;
};
export type RemoteSttDeps = {
    fetchImpl?: FetchLike;
    sleep?: (ms: number) => Promise<void>;
    pollIntervalMs?: number;
    timeoutMs?: number;
    /** Injectable clock (ms since epoch) so the poll deadline is deterministic in tests. */
    now?: () => number;
};
/** Tri-state readiness (issue #63) reported by `castrecall_setup`/`castrecall_setup_status`. */
export type RemoteSttHealth = {
    state: "ready" | "degraded" | "unavailable";
    /** Actionable, present for degraded/unavailable; NEVER the bearer token. */
    reason?: string;
    implementation?: string;
    version?: string;
    model?: string;
    modelReady?: boolean;
    capabilities?: {
        diarization?: boolean;
        timestamps?: boolean;
    };
    /** Submit mode(s) the provider accepts — see `submittedBy` in transcribeWithRemoteStt. */
    accepts?: "audio_url" | "upload" | "both";
};
/**
 * Readiness probe for `castrecall_setup`/`castrecall_setup_status` — outside
 * the billed ladder path, so it deliberately never throws, mirroring
 * `detectLocalWhisper`. Tri-state (issue #63): `unavailable` blocks a
 * corpus-scale run (see buildTranscriptionPreflight), `degraded` never does.
 */
export declare function remoteSttHealth(config: ResolvedConfig, fetchImpl?: FetchLike, timeoutMs?: number): Promise<RemoteSttHealth>;
export declare function transcribeWithRemoteStt(config: ResolvedConfig, audioUrl: string, deps?: RemoteSttDeps): Promise<SttResult>;
