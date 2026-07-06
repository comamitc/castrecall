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
import type { TranscriptSegment } from "./normalize.js";
import { type LocalWhisperGeneration } from "./local-whisper.js";
import type { RemoteSttGeneration } from "./remote-stt.js";
export type LadderRung = "rss" | "taddy" | "podchaser" | "local-whisper" | "stt";
export type RungOutcome = {
    rung: LadderRung;
    outcome: "hit" | "miss" | "skipped" | "failed";
    detail: string;
    /** Set on a "failed" stt rung when the provider failure is transient (rate limit, timeout, 5xx). */
    retryable?: boolean;
    /** Set on a "miss" rung when the transcript may simply not be available yet (worth polling again later). */
    recheckable?: boolean;
    /** Set on the "skipped" local-whisper or stt rung when the corpus-scale preflight (issue #55),
     * not a real failure, is why this rung didn't run — this is a reversible policy gate, not
     * evidence the episode is untranscribable. */
    preflightBlocked?: boolean;
};
export type LadderResult = {
    transcript?: {
        source: LadderRung;
        format: string;
        raw: string;
        text: string;
        sourceUrl?: string;
        provider?: string;
        /** Exact local-transcription (issue #54) or remote-stt (issue #61) provenance; only set on the matching rung's hit. */
        generation?: LocalWhisperGeneration | RemoteSttGeneration;
        /** Structured segments (timing, speaker), when the rung parsed them; set on an RSS hit (VTT/SRT/JSON) or a diarized STT hit. */
        segments?: TranscriptSegment[];
    };
    feedItem?: ResolvedFeedItem;
    rungs: RungOutcome[];
};
export declare function runTranscriptLadder(config: ResolvedConfig, record: ListenRecord, options?: {
    fetchImpl?: FetchLike;
    env?: NodeJS.ProcessEnv;
    skipStt?: boolean;
    /** `skipStt` is true because the corpus-scale preflight (issue #55) blocked local Whisper for
     * this run and STT would otherwise run as the very next rung — never set for the unrelated
     * STT-retry-budget-exhausted skip, which uses its own detail message below. */
    skipSttPreflightBlocked?: boolean;
    /** Corpus-scale preflight (issue #55) blocked low-quality local generation for this run. */
    skipLocalWhisper?: boolean;
}): Promise<LadderResult>;
