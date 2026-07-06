/**
 * Repetition-loop detector (issue #42): local Whisper (and, less often, other
 * STT backends) can degenerate into repeating the same phrase or single word
 * for the rest of a transcript once it loses its place in the audio. Left
 * unchecked, that looped text gets stored as trusted corpus and poisons
 * search results and exported markdown.
 *
 * Pure classifier, no I/O — mirrors the repo's `preflight.ts` pattern
 * (options-with-defaults, an exported result type, a human-readable
 * `reason`). The caller (`fetchTranscript` in `../tools.ts`) decides what to
 * do with the verdict; this module only detects.
 */
export type LoopDetection = {
    looped: boolean;
    /** Human-readable explanation naming the repeated phrase; present iff looped. */
    reason?: string;
    /** The repeated phrase, truncated for the message. */
    phrase?: string;
    /** How many times the phrase repeats consecutively. */
    repetitions?: number;
    /** Fraction (0..1) of the transcript's tokens covered by the loop. */
    coverage?: number;
};
export type LoopThresholds = Partial<{
    /** Below this many tokens, a transcript is never flagged — too short for a loop to matter or to distinguish from legitimate brevity. */
    MIN_TOKENS: number;
    /** Consecutive identical single-word run length that alone is suspicious, regardless of coverage (natural language essentially never repeats one word this many times in a row). */
    WORD_RUN_THRESHOLD: number;
    /** Longest phrase (in words) considered when searching for a repeating n-gram. */
    WINDOW_MAX: number;
    /** Minimum consecutive repeats of a phrase before it can be flagged. */
    MIN_REPEATS: number;
    /** Minimum token span a repeating phrase must cover, as an alternative to COVERAGE_THRESHOLD. */
    MIN_LOOP_TOKENS: number;
    /** Minimum fraction of the transcript a repeating phrase must cover, as an alternative to MIN_LOOP_TOKENS. */
    COVERAGE_THRESHOLD: number;
}>;
export declare const DEFAULT_LOOP_THRESHOLDS: {
    MIN_TOKENS: number;
    WORD_RUN_THRESHOLD: number;
    WINDOW_MAX: number;
    MIN_REPEATS: number;
    MIN_LOOP_TOKENS: number;
    COVERAGE_THRESHOLD: number;
};
/**
 * Detects Whisper/STT-style repetition loops in transcript text.
 *
 * Two independent rules, checked in this precedence order:
 * 1. Phrase loop (any n-gram length 1..WINDOW_MAX): flags when
 *    `consecutiveRepeats >= MIN_REPEATS && (span >= MIN_LOOP_TOKENS ||
 *    coverage >= COVERAGE_THRESHOLD)`. The qualifying candidate with the
 *    greatest coverage wins across all n.
 * 2. Single-token flood: flags when the longest run of one identical word is
 *    `>= WORD_RUN_THRESHOLD`, even if it's too small a fraction of a long
 *    transcript to satisfy the phrase rule — a single word repeated this many
 *    times in a row essentially never happens in real speech.
 *
 * A single-word loop can satisfy both rules; the phrase rule's result is
 * preferred so only one `LoopDetection` is ever returned for it.
 */
export declare function detectRepetitionLoop(text: string, thresholds?: LoopThresholds): LoopDetection;
