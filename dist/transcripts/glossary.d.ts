/**
 * Optional proper-noun correction glossary (issue #46): a deterministic,
 * whole-token find/replace pass that corrects known STT mangling of product
 * names, people, and companies — e.g. "chat gpt" -> "ChatGPT".
 *
 * Pure transform, no I/O — mirrors `cleanup.ts`'s shape (an exported
 * `*_VERSION`, a pure function returning `{ text, <provenance-list> }`), but
 * is deliberately a SEPARATE pass, not a `cleanTranscript` step: cleanup's
 * hard invariant is that it never adds, reorders, paraphrases, or invents a
 * word (see cleanup.ts:8-11), whereas glossary correction does change words
 * by design. Chained in tools.ts after cleanup, not inside it.
 *
 * Safety comes from three constraints, all enforced here rather than left to
 * caller discipline:
 *   - exact whole-token matching only, no fuzzy/Levenshtein matching, so a
 *     near-miss like "cat"/"category" or "Astral"/"Astralis" never fires;
 *   - global longest-first compilation across ALL entries, so overlapping
 *     variants from different entries resolve deterministically instead of
 *     depending on entry order;
 *   - single-pass application over the ORIGINAL text, so a canonical
 *     produced by one correction is never re-scanned and cannot feed another
 *     rule (no cascades).
 */
export declare const GLOSSARY_VERSION = 1;
export type GlossaryEntry = {
    canonical: string;
    variants: string[];
    /** When true, this entry's variants match case-sensitively. Default false (case-insensitive). */
    matchCase?: boolean;
};
export type RawGlossary = {
    terms: GlossaryEntry[];
};
type CompiledScanner = {
    /**
     * Zero-width scanner: word-boundary lookbehind plus a lookahead capturing
     * the longest-first variant alternation (with its own trailing boundary).
     * Being zero-width, matchAll advances position-by-position, so candidates
     * STARTING inside another candidate are still enumerated — one native
     * regex pass per case class instead of one full-text scan per variant.
     */
    pattern: RegExp;
    caseSensitive: boolean;
    /**
     * Constant-time common-path lookup: matched text (lowercased for the
     * insensitive class) → its variant/canonical. Not authoritative on its
     * own — regex /iu Unicode case folding isn't equivalent to
     * `String.prototype.toLowerCase()` for every character (Greek final
     * sigma, micro sign vs Greek mu, Kelvin sign…), so a miss here falls
     * through to `fallback` instead of dropping the correction.
     */
    byMatch: Map<string, {
        variant: string;
        canonical: string;
    }>;
    /**
     * Authoritative rare-path identification for the insensitive class: each
     * variant carries an anchored /iu matcher — the SAME semantics that
     * produced the scanner match — so scan and lookup can never disagree.
     * Simple case folding is 1:1, so candidates are filtered by exact length
     * first; this path only runs when the toLowerCase fast path misses.
     */
    fallback: Array<{
        variant: string;
        canonical: string;
        exact: RegExp;
    }>;
};
export type CompiledGlossary = {
    /** At most two scanners: case-sensitive and case-insensitive classes. */
    scanners: CompiledScanner[];
};
export type GlossaryCorrection = {
    canonical: string;
    variant: string;
    count: number;
};
export type GlossaryResult = {
    text: string;
    corrections: GlossaryCorrection[];
};
/**
 * Validates glossary JSON shape only — no knowledge of where it came from.
 * The caller (loadGlossary in tools.ts) attaches the file path to any thrown
 * error, so this stays reusable/testable without an I/O boundary.
 */
export declare function parseGlossary(json: unknown): RawGlossary;
/**
 * Flattens every (variant, entry) pair into one globally ranked list, sorted
 * longest-first (ties broken by variant string) so the longest match always
 * wins across entries regardless of declaration order. Rejects a variant
 * that maps to two different canonicals as ambiguous.
 */
export declare function compileGlossary(entries: GlossaryEntry[]): CompiledGlossary;
/**
 * Applies compiled glossary corrections to `text` in a single pass over the
 * ORIGINAL string: matches are collected once against the untouched input,
 * overlaps resolved, then spliced left-to-right. This guarantees a canonical
 * produced by one correction is never re-scanned by another rule.
 */
export declare function applyGlossary(text: string, compiled: CompiledGlossary): GlossaryResult;
export {};
