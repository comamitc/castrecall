/**
 * The transcript ladder, cheapest and most-open first:
 *   1. RSS `<podcast:transcript>` links (open standard, free)
 *   2. Taddy API (optional, needs TADDY_API_KEY + TADDY_USER_ID)
 *   3. Speech-to-text (optional, costs money, must be explicitly enabled)
 *
 * Each rung reports why it was skipped or failed so the outcome is explainable.
 */
import { type ResolvedConfig } from "../config.js";
import type { FetchLike } from "../pocketcasts/client.js";
import { type ResolvedFeedItem } from "../resolver.js";
import type { ListenRecord } from "../storage.js";
export type LadderRung = "rss" | "taddy" | "stt";
export type RungOutcome = {
    rung: LadderRung;
    outcome: "hit" | "miss" | "skipped" | "failed";
    detail: string;
};
export type LadderResult = {
    transcript?: {
        source: LadderRung;
        format: string;
        raw: string;
        text: string;
        sourceUrl?: string;
        provider?: string;
    };
    feedItem?: ResolvedFeedItem;
    rungs: RungOutcome[];
};
export declare function runTranscriptLadder(config: ResolvedConfig, record: ListenRecord, options?: {
    fetchImpl?: FetchLike;
}): Promise<LadderResult>;
