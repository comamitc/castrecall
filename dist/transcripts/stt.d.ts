/**
 * Rung 3 of the transcript ladder: paid speech-to-text fallback.
 * Never runs unless explicitly enabled (CASTRECALL_ENABLE_STT=true or plugin
 * config sttEnabled) because it costs money per episode.
 *
 * Providers:
 * - AssemblyAI (default): accepts a remote audio URL directly — no download needed.
 * - OpenAI: requires downloading the audio and uploading it (25 MB API limit).
 * - Deepgram: accepts a remote audio URL directly, like AssemblyAI, but its
 *   prerecorded endpoint responds synchronously (no polling) with diarized
 *   utterances.
 * - remote-stt (issue #61): a generic contract for private/self-hosted STT
 *   services (WhisperX, faster-whisper, etc.) — see transcripts/remote-stt.ts.
 */
import { type ResolvedConfig } from "../config.js";
import type { FetchLike } from "../pocketcasts/client.js";
import { type TranscriptSegment } from "./normalize.js";
import { type RemoteSttGeneration } from "./remote-stt.js";
export type SttResult = {
    text: string;
    provider: "assemblyai" | "openai" | "deepgram" | "remote-stt";
    model?: string;
    /** Diarized speaker turns (issue #44), when the provider returned per-utterance speaker labels. */
    segments?: TranscriptSegment[];
    /** Exact remote-stt provenance (issue #61); only set on a remote-stt hit. */
    generation?: RemoteSttGeneration;
};
/**
 * Build `TranscriptSegment[]` from provider utterances, given each
 * utterance's raw speaker label and its start/end already converted to
 * seconds. Timing fields (`start`/`end`/`startSeconds`/`endSeconds`) are
 * emitted only when a finite numeric time exists, matching the
 * `parseJsonTranscript` convention of a bare-seconds string.
 */
export declare function utterancesToSegments(utterances: Array<{
    speaker?: string | number;
    text: string;
    startSeconds?: number;
    endSeconds?: number;
}>): TranscriptSegment[];
/**
 * Thrown for provider failures that are transient (rate limits, timeouts,
 * upstream 5xx) rather than a fundamental rejection of the request. Callers
 * can use this to keep the episode eligible for the next scheduled retry
 * instead of recording a terminal failure.
 */
export declare class RetryableSttError extends Error {
    constructor(message: string);
}
/**
 * Deadline expiry after a window of SUCCESSFUL (authenticated, 200) polls —
 * distinct from transient RetryableSttError failures so remote-stt's resume
 * path can treat it as proof the token currently works. Defined here beside
 * its parent: extending across the stt ↔ remote-stt circular import would
 * run at module-evaluation time against an uninitialized binding and crash
 * consumers that load the plugin entry (openclaw plugins build --check).
 */
export declare class PollDeadlineError extends RetryableSttError {
}
export declare function isRetryableHttpStatus(status: number): boolean;
export declare function sttAvailability(config: ResolvedConfig): {
    ok: boolean;
    reason?: string;
};
export declare function transcribeAudio(config: ResolvedConfig, audioUrl: string, fetchImpl?: FetchLike, sleep?: (ms: number) => Promise<void>): Promise<SttResult>;
