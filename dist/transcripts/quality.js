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
import { detectRepetitionLoop } from "./loop-detection.js";
export const DEFAULT_QUALITY_THRESHOLDS = {
    /** Word count below this is flagged too-short — too little text to be reliably reviewable or searchable. */
    MIN_WORDS: 50,
    TOO_SHORT_PENALTY: 30,
    /** Below this many tokens, lexical variety is never checked — too short to distinguish a low-variety transcript from legitimate brevity. */
    MIN_TOKENS_FOR_TTR: 60,
    /** Type-token ratio (unique words / total words) below this is flagged low-lexical-variety. */
    MIN_LEXICAL_VARIETY: 0.2,
    LOW_LEXICAL_VARIETY_PENALTY: 25,
    REPETITION_LOOP_PENALTY: 100,
    /** A segment longer than this many characters looks like merged/failed captioning rather than one spoken turn. */
    MAX_SEGMENT_CHARS: 500,
    /** Fraction of segments that must be empty-text or oversized before suspicious-segment-lengths fires. */
    SUSPICIOUS_SEGMENT_FRACTION: 0.3,
    SUSPICIOUS_SEGMENT_PENALTY: 15,
    LOW_SOURCE_CONFIDENCE_PENALTY: 10,
    /** Fraction of non-empty segments that must carry a timestamp/speaker label to suppress the corresponding reason — a single labeled segment among many unlabeled ones shouldn't count as covered. */
    MIN_TIMESTAMP_COVERAGE: 0.9,
    MIN_SPEAKER_COVERAGE: 0.9,
    NO_TIMESTAMPS_PENALTY: 10,
    NO_SPEAKER_LABELS_PENALTY: 5,
    QUOTE_SAFE_MIN: 90,
    REVIEWABLE_MIN: 60,
};
/** Machine transcription rungs have no independent confidence signal, unlike a published RSS/Taddy/Podchaser transcript. */
const MACHINE_SOURCES = new Set(["local-whisper", "stt"]);
function tokenize(text) {
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter(Boolean);
}
/**
 * Scores a transcript 0-100 with machine-readable reasons, and buckets it
 * into a tier consumers can act on directly: `quote-safe` (verbatim quoting
 * is safe), `reviewable` (fine for a human review pass), or `search-only`
 * (keyword search only — don't quote or surface as reviewable).
 */
export function scoreTranscriptQuality(input, thresholds = {}) {
    if (input.text.trim() === "") {
        return { score: 0, tier: "search-only", reasons: ["empty"] };
    }
    const t = { ...DEFAULT_QUALITY_THRESHOLDS, ...thresholds };
    const reasons = [];
    let score = 100;
    const tokens = tokenize(input.text);
    if (tokens.length < t.MIN_WORDS) {
        reasons.push("too-short");
        score -= t.TOO_SHORT_PENALTY;
    }
    const loop = detectRepetitionLoop(input.text);
    if (loop.looped) {
        reasons.push("repetition-loop");
        score -= t.REPETITION_LOOP_PENALTY;
    }
    if (tokens.length >= t.MIN_TOKENS_FOR_TTR) {
        const typeTokenRatio = new Set(tokens).size / tokens.length;
        if (typeTokenRatio < t.MIN_LEXICAL_VARIETY) {
            reasons.push("low-lexical-variety");
            score -= t.LOW_LEXICAL_VARIETY_PENALTY;
        }
    }
    const segments = input.segments ?? [];
    if (segments.length > 0) {
        const suspicious = segments.filter((segment) => segment.text.trim() === "" || segment.text.length > t.MAX_SEGMENT_CHARS).length;
        if (suspicious / segments.length >= t.SUSPICIOUS_SEGMENT_FRACTION) {
            reasons.push("suspicious-segment-lengths");
            score -= t.SUSPICIOUS_SEGMENT_PENALTY;
        }
    }
    if (MACHINE_SOURCES.has(input.source)) {
        reasons.push("low-source-confidence");
        score -= t.LOW_SOURCE_CONFIDENCE_PENALTY;
    }
    const labelableSegments = segments.filter((segment) => segment.text.trim() !== "");
    const timestampCoverage = labelableSegments.length === 0
        ? 0
        : labelableSegments.filter((segment) => Boolean(segment.start?.trim() || segment.end?.trim())).length /
            labelableSegments.length;
    if (timestampCoverage < t.MIN_TIMESTAMP_COVERAGE) {
        reasons.push("no-timestamps");
        score -= t.NO_TIMESTAMPS_PENALTY;
    }
    const speakerCoverage = labelableSegments.length === 0
        ? 0
        : labelableSegments.filter((segment) => Boolean(segment.speaker?.trim())).length / labelableSegments.length;
    if (speakerCoverage < t.MIN_SPEAKER_COVERAGE) {
        reasons.push("no-speaker-labels");
        score -= t.NO_SPEAKER_LABELS_PENALTY;
    }
    score = Math.max(0, Math.min(100, score));
    const tier = loop.looped
        ? "search-only"
        : score >= t.QUOTE_SAFE_MIN
            ? "quote-safe"
            : score >= t.REVIEWABLE_MIN
                ? "reviewable"
                : "search-only";
    return { score, tier, reasons };
}
