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
type CompiledVariant = {
    variant: string;
    canonical: string;
    matchCase: boolean;
    /** Single-variant word-boundary pattern, scanned independently so shifted overlaps with other variants are never hidden by matchAll's own non-overlapping scan. */
    pattern: RegExp;
};
export type CompiledGlossary = {
    /** Sorted longest-first (ties broken by variant string); each variant is scanned with its own pattern. */
    variants: CompiledVariant[];
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
