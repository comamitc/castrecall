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
export const DEFAULT_LOOP_THRESHOLDS = {
    MIN_TOKENS: 60,
    WORD_RUN_THRESHOLD: 20,
    WINDOW_MAX: 40,
    MIN_REPEATS: 6,
    MIN_LOOP_TOKENS: 30,
    COVERAGE_THRESHOLD: 0.35,
};
const REASON_PHRASE_MAX_CHARS = 80;
function tokenize(text) {
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter(Boolean);
}
function chunkEquals(tokens, a, b, n) {
    for (let k = 0; k < n; k++) {
        if (tokens[a + k] !== tokens[b + k])
            return false;
    }
    return true;
}
/**
 * Longest run of an immediately-repeating n-gram anywhere in `tokens`, for a
 * fixed phrase length `n`. Single linear scan: once a run is found, the scan
 * resumes after it rather than re-testing positions already consumed by it.
 */
function longestRunForPhraseLength(tokens, n) {
    let best;
    let i = 0;
    const total = tokens.length;
    while (i + n <= total) {
        let repeats = 1;
        let j = i + n;
        while (j + n <= total && chunkEquals(tokens, i, j, n)) {
            repeats += 1;
            j += n;
        }
        const span = repeats * n;
        if (!best || span > best.span) {
            best = { n, start: i, repeats, span };
        }
        i = repeats > 1 ? j : i + 1;
    }
    return best;
}
function buildReason(phrase, repeats, coverage) {
    const pct = Math.round(coverage * 100);
    const truncated = phrase.length > REASON_PHRASE_MAX_CHARS ? `${phrase.slice(0, REASON_PHRASE_MAX_CHARS - 3)}...` : phrase;
    return (`Detected a repetition loop: "${truncated}" repeats ${repeats}× consecutively ` +
        `(${pct}% of the transcript). Likely a Whisper/STT loop; regenerate with a different model or provider.`);
}
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
export function detectRepetitionLoop(text, thresholds = {}) {
    const t = { ...DEFAULT_LOOP_THRESHOLDS, ...thresholds };
    const tokens = tokenize(text);
    if (tokens.length < t.MIN_TOKENS) {
        return { looped: false };
    }
    const candidates = [];
    for (let n = 1; n <= t.WINDOW_MAX; n++) {
        const candidate = longestRunForPhraseLength(tokens, n);
        if (candidate)
            candidates.push(candidate);
    }
    let bestPhrase;
    for (const c of candidates) {
        const coverage = c.span / tokens.length;
        const qualifies = c.repeats >= t.MIN_REPEATS && (c.span >= t.MIN_LOOP_TOKENS || coverage >= t.COVERAGE_THRESHOLD);
        if (qualifies && (!bestPhrase || coverage > bestPhrase.coverage)) {
            bestPhrase = { ...c, coverage };
        }
    }
    if (bestPhrase) {
        const phrase = tokens.slice(bestPhrase.start, bestPhrase.start + bestPhrase.n).join(" ");
        return {
            looped: true,
            phrase,
            repetitions: bestPhrase.repeats,
            coverage: bestPhrase.coverage,
            reason: buildReason(phrase, bestPhrase.repeats, bestPhrase.coverage),
        };
    }
    const floodCandidate = candidates.find((c) => c.n === 1);
    if (floodCandidate && floodCandidate.repeats >= t.WORD_RUN_THRESHOLD) {
        const coverage = floodCandidate.span / tokens.length;
        const phrase = tokens[floodCandidate.start];
        return {
            looped: true,
            phrase,
            repetitions: floodCandidate.repeats,
            coverage,
            reason: buildReason(phrase, floodCandidate.repeats, coverage),
        };
    }
    return { looped: false };
}
