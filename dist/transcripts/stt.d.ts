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
 */
import { type ResolvedConfig } from "../config.js";
import type { FetchLike } from "../pocketcasts/client.js";
import { type TranscriptSegment } from "./normalize.js";
export type SttResult = {
    text: string;
    provider: "assemblyai" | "openai" | "deepgram";
    model?: string;
    /** Diarized speaker turns (issue #44), when the provider returned per-utterance speaker labels. */
    segments?: TranscriptSegment[];
};
/**
 * Thrown for provider failures that are transient (rate limits, timeouts,
 * upstream 5xx) rather than a fundamental rejection of the request. Callers
 * can use this to keep the episode eligible for the next scheduled retry
 * instead of recording a terminal failure.
 */
export declare class RetryableSttError extends Error {
    constructor(message: string);
}
export declare function sttAvailability(config: ResolvedConfig): {
    ok: boolean;
    reason?: string;
};
export declare function transcribeAudio(config: ResolvedConfig, audioUrl: string, fetchImpl?: FetchLike, sleep?: (ms: number) => Promise<void>): Promise<SttResult>;
