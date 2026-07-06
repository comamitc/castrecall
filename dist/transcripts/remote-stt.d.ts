/**
 * Generic remote STT provider contract (issue #61): lets CastRecall call a
 * private/self-hosted speech-to-text service — WhisperX, faster-whisper, or
 * anything else — as an implementation of `CASTRECALL_STT_PROVIDER=remote-stt`,
 * without the transcript ladder knowing which implementation actually ran.
 *
 * Contract (normative — mirrored verbatim in README):
 * - Every request carries `Authorization: Bearer <token>` when a token is configured.
 * - `GET {base}/health` — 200 (optionally `{ status, implementation, model }`) means ready;
 *   any non-2xx or network failure means not ready. Never throws.
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
/**
 * Readiness probe for `castrecall_setup`/`castrecall_setup_status` — outside
 * the billed ladder path, so it deliberately never throws, mirroring
 * `detectLocalWhisper`.
 */
export declare function remoteSttHealth(config: ResolvedConfig, fetchImpl?: FetchLike): Promise<{
    ok: boolean;
    reason?: string;
    implementation?: string;
    model?: string;
}>;
export declare function transcribeWithRemoteStt(config: ResolvedConfig, audioUrl: string, deps?: RemoteSttDeps): Promise<SttResult>;
