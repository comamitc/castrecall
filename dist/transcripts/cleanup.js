/**
 * Deterministic transcript cleanup pass (issue #45): a conservative punctuation/
 * caption-artifact/whitespace repair over already-normalized plain text, run
 * just before storage.
 *
 * Pure transform, no I/O — mirrors `loop-detection.ts`/`quality.ts` (options
 * merged over an exported `DEFAULT_*`, exported result type). The hard
 * invariant is `spokenTokens(clean(x))` equals `spokenTokens(x)`: every
 * transform edits only whitespace/punctuation/markup around existing tokens,
 * or deletes a token matching the curated `STANDALONE_CUE_ALLOWLIST` — it
 * never adds, reorders, paraphrases, or invents a word.
 */
import { collapseWhitespace } from "./normalize.js";
export const CLEANUP_VERSION = 1;
/** Curated non-speech caption cues — only removed when a line consists solely of one of these. */
export const STANDALONE_CUE_ALLOWLIST = [
    "MUSIC",
    "APPLAUSE",
    "LAUGHTER",
    "INAUDIBLE",
    "CROSSTALK",
    "SILENCE",
    "BACKGROUND NOISE",
    "UNINTELLIGIBLE",
    "NOISE",
    "COUGHING",
];
export const DEFAULT_CLEANUP_OPTIONS = {
    cueAllowlist: STANDALONE_CUE_ALLOWLIST,
};
const CUE_LINE_PATTERN = /^[[(]\s*([^\])]+?)\s*[\])]$/;
function isStandaloneCueLine(line, allowlist) {
    const match = line.trim().match(CUE_LINE_PATTERN);
    if (!match)
        return false;
    const inner = match[1].trim().toUpperCase();
    return allowlist.some((cue) => cue.toUpperCase() === inner);
}
function stripStandaloneCueLines(text, allowlist) {
    return text
        .split("\n")
        .filter((line) => !isStandaloneCueLine(line, allowlist))
        .join("\n");
}
function stripCaptionMarkers(text) {
    return text
        .split("\n")
        .map((line) => line.replace(/^\s*>+\s*/, "").replace(/^\s*-\s+/, ""))
        .join("\n");
}
function fixPunctuationGlue(text) {
    return text
        .replace(/[ \t]+([,.;:?!])/g, "$1")
        .replace(/([.?!])[.?!]+/g, "$1")
        .replace(/([,.;:?!])(?=[\p{L}\p{N}])/gu, "$1 ");
}
/** A lone `\n` before a `Name:` turn is promoted to a blank-line paragraph break; already-blank-separated turns are left alone. */
const SPEAKER_TURN_BOUNDARY = /(?<=[^\n])\n(?=[A-Za-z][\w .'-]{0,40}:\s)/g;
function separateSpeakerTurns(text) {
    return text.replace(SPEAKER_TURN_BOUNDARY, "\n\n");
}
function tokenize(text) {
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter(Boolean);
}
/**
 * Tokenizes `text` with allowlisted standalone cue lines removed first — the
 * same removal `cleanTranscript` performs — so it can be compared before and
 * after cleanup to prove no spoken word was added, removed, or reordered.
 */
export function spokenTokens(text, allowlist = STANDALONE_CUE_ALLOWLIST) {
    return tokenize(stripStandaloneCueLines(text, allowlist));
}
/**
 * Applies a conservative, deterministic cleanup pass to already-normalized
 * transcript text: strips standalone non-speech cues and caption markers,
 * de-glues/de-duplicates existing punctuation, paragraph-separates speaker
 * turns, and re-collapses whitespace. Never adds punctuation or words. Each
 * step only appears in `applied` when it actually changed the text.
 */
export function cleanTranscript(text, options = {}) {
    const opts = { ...DEFAULT_CLEANUP_OPTIONS, ...options };
    const applied = [];
    let out = text;
    const steps = [
        { name: "strip-standalone-cues", run: (t) => stripStandaloneCueLines(t, opts.cueAllowlist) },
        { name: "strip-caption-markers", run: stripCaptionMarkers },
        { name: "fix-punctuation-glue", run: fixPunctuationGlue },
        { name: "separate-speaker-turns", run: separateSpeakerTurns },
        { name: "collapse-whitespace", run: collapseWhitespace },
    ];
    for (const step of steps) {
        const next = step.run(out);
        if (next !== out)
            applied.push(step.name);
        out = next;
    }
    return { text: out, applied };
}
