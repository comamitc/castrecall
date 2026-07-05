/**
 * Rung 3 of the transcript ladder: paid speech-to-text fallback.
 * Never runs unless explicitly enabled (CASTRECALL_ENABLE_STT=true or plugin
 * config sttEnabled) because it costs money per episode.
 *
 * Providers:
 * - AssemblyAI (default): accepts a remote audio URL directly — no download needed.
 * - OpenAI: requires downloading the audio and uploading it (25 MB API limit).
 */
import { type ResolvedConfig } from "../config.js";
import type { FetchLike } from "../pocketcasts/client.js";
export type SttResult = {
    text: string;
    provider: "assemblyai" | "openai";
    model?: string;
};
export declare function sttAvailability(config: ResolvedConfig): {
    ok: boolean;
    reason?: string;
};
export declare function transcribeAudio(config: ResolvedConfig, audioUrl: string, fetchImpl?: FetchLike, sleep?: (ms: number) => Promise<void>): Promise<SttResult>;
