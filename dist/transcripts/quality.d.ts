/**
 * Deterministic transcript quality scoring (issue #41): downstream consumers
 * (search, review generation, corpus export) need a machine-readable signal
 * for whether a stored transcript is trustworthy enough to quote verbatim,
 * merely worth a human review pass, or only fit for keyword search.
 *
 * Pure classifier, no I/O — mirrors `loop-detection.ts`'s pattern
 * (options-with-defaults, an exported result type, deterministic integer
 * scoring). Composes `detectRepetitionLoop` rather than re-detecting loops,
 * so the two signals never disagree.
 */
import type { LadderRung } from "./ladder.js";
import type { TranscriptSegment } from "./normalize.js";
export type QualityTier = "quote-safe" | "reviewable" | "search-only";
export type TranscriptQualityReason = "empty" | "too-short" | "repetition-loop" | "low-lexical-variety" | "suspicious-segment-lengths" | "low-source-confidence" | "no-timestamps" | "no-speaker-labels";
export type TranscriptQuality = {
    score: number;
    tier: QualityTier;
    reasons: TranscriptQualityReason[];
};
export declare const DEFAULT_QUALITY_THRESHOLDS: {
    /** Word count below this is flagged too-short — too little text to be reliably reviewable or searchable. */
    readonly MIN_WORDS: 50;
    readonly TOO_SHORT_PENALTY: 30;
    /** Below this many tokens, lexical variety is never checked — too short to distinguish a low-variety transcript from legitimate brevity. */
    readonly MIN_TOKENS_FOR_TTR: 60;
    /** Type-token ratio (unique words / total words) below this is flagged low-lexical-variety. */
    readonly MIN_LEXICAL_VARIETY: 0.2;
    readonly LOW_LEXICAL_VARIETY_PENALTY: 25;
    readonly REPETITION_LOOP_PENALTY: 100;
    /** A segment longer than this many characters looks like merged/failed captioning rather than one spoken turn. */
    readonly MAX_SEGMENT_CHARS: 500;
    /** Fraction of segments that must be empty-text or oversized before suspicious-segment-lengths fires. */
    readonly SUSPICIOUS_SEGMENT_FRACTION: 0.3;
    readonly SUSPICIOUS_SEGMENT_PENALTY: 15;
    readonly LOW_SOURCE_CONFIDENCE_PENALTY: 10;
    /** Fraction of non-empty segments that must carry a timestamp/speaker label to suppress the corresponding reason — a single labeled segment among many unlabeled ones shouldn't count as covered. */
    readonly MIN_TIMESTAMP_COVERAGE: 0.9;
    readonly MIN_SPEAKER_COVERAGE: 0.9;
    readonly NO_TIMESTAMPS_PENALTY: 10;
    readonly NO_SPEAKER_LABELS_PENALTY: 5;
    readonly QUOTE_SAFE_MIN: 90;
    readonly REVIEWABLE_MIN: 60;
};
export type QualityThresholds = Partial<Record<keyof typeof DEFAULT_QUALITY_THRESHOLDS, number>>;
/**
 * Scores a transcript 0-100 with machine-readable reasons, and buckets it
 * into a tier consumers can act on directly: `quote-safe` (verbatim quoting
 * is safe), `reviewable` (fine for a human review pass), or `search-only`
 * (keyword search only — don't quote or surface as reviewable).
 */
export declare function scoreTranscriptQuality(input: {
    text: string;
    source: LadderRung;
    segments?: TranscriptSegment[];
}, thresholds?: QualityThresholds): TranscriptQuality;
