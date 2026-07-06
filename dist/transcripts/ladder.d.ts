/**
 * The transcript ladder, cheapest and most-open first:
 *   1. RSS `<podcast:transcript>` links (open standard, free)
 *   2. Taddy API (optional, needs TADDY_API_KEY + TADDY_USER_ID)
 *   3. Podchaser API (optional, needs PODCHASER_API_KEY)
 *   4. Local Whisper (free and private; auto-detected CLI, skipped when absent)
 *   5. Cloud speech-to-text (optional, costs money, must be explicitly enabled)
 *
 * Each rung reports why it was skipped or failed so the outcome is explainable.
 */
import { type ResolvedConfig } from "../config.js";
import type { FetchLike } from "../pocketcasts/client.js";
import { type ResolvedFeedItem } from "../resolver.js";
import type { ListenRecord } from "../storage.js";
import { type LocalWhisperGeneration } from "./local-whisper.js";
export type LadderRung = "rss" | "taddy" | "podchaser" | "local-whisper" | "stt";
export type RungOutcome = {
    rung: LadderRung;
    outcome: "hit" | "miss" | "skipped" | "failed";
    detail: string;
    /** Set on a "failed" stt rung when the provider failure is transient (rate limit, timeout, 5xx). */
    retryable?: boolean;
    /** Set on a "miss" rung when the transcript may simply not be available yet (worth polling again later). */
    recheckable?: boolean;
};
export type LadderResult = {
    transcript?: {
        source: LadderRung;
        format: string;
        raw: string;
        text: string;
        sourceUrl?: string;
        provider?: string;
        /** Exact local-transcription provenance (issue #54); only set on a local-whisper hit. */
        generation?: LocalWhisperGeneration;
    };
    feedItem?: ResolvedFeedItem;
    rungs: RungOutcome[];
};
export declare function runTranscriptLadder(config: ResolvedConfig, record: ListenRecord, options?: {
    fetchImpl?: FetchLike;
    env?: NodeJS.ProcessEnv;
    skipStt?: boolean;
}): Promise<LadderResult>;
