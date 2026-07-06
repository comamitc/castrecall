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
export declare const CLEANUP_VERSION = 1;
export type CleanupResult = {
    text: string;
    /** Names of the transform steps that actually changed the text, in the order they ran. */
    applied: string[];
};
export type CleanupOptions = Partial<{
    /** Non-speech cue names (without brackets) that are removed when they appear alone on a line. */
    cueAllowlist: readonly string[];
}>;
/** Curated non-speech caption cues — only removed when a line consists solely of one of these. */
export declare const STANDALONE_CUE_ALLOWLIST: readonly ["MUSIC", "APPLAUSE", "LAUGHTER", "INAUDIBLE", "CROSSTALK", "SILENCE", "BACKGROUND NOISE", "UNINTELLIGIBLE", "NOISE", "COUGHING"];
export declare const DEFAULT_CLEANUP_OPTIONS: {
    cueAllowlist: readonly ["MUSIC", "APPLAUSE", "LAUGHTER", "INAUDIBLE", "CROSSTALK", "SILENCE", "BACKGROUND NOISE", "UNINTELLIGIBLE", "NOISE", "COUGHING"];
};
/**
 * Tokenizes `text` with allowlisted standalone cue lines removed first — the
 * same removal `cleanTranscript` performs — so it can be compared before and
 * after cleanup to prove no spoken word was added, removed, or reordered.
 */
export declare function spokenTokens(text: string, allowlist?: readonly string[]): string[];
/**
 * Applies a conservative, deterministic cleanup pass to already-normalized
 * transcript text: strips standalone non-speech cues and caption markers,
 * de-glues/de-duplicates existing punctuation, paragraph-separates speaker
 * turns, and re-collapses whitespace. Never adds punctuation or words. Each
 * step only appears in `applied` when it actually changed the text.
 */
export declare function cleanTranscript(text: string, options?: CleanupOptions): CleanupResult;
