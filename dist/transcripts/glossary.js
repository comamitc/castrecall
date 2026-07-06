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
import { CastrecallSetupError } from "../config.js";
export const GLOSSARY_VERSION = 1;
function isNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
}
/**
 * Validates glossary JSON shape only — no knowledge of where it came from.
 * The caller (loadGlossary in tools.ts) attaches the file path to any thrown
 * error, so this stays reusable/testable without an I/O boundary.
 */
export function parseGlossary(json) {
    if (typeof json !== "object" || json === null || !("terms" in json)) {
        throw new CastrecallSetupError("Glossary must be a JSON object with a \"terms\" array.");
    }
    const terms = json.terms;
    if (!Array.isArray(terms)) {
        throw new CastrecallSetupError("Glossary \"terms\" must be an array.");
    }
    const parsed = terms.map((entry, index) => {
        if (typeof entry !== "object" || entry === null) {
            throw new CastrecallSetupError(`Glossary term at index ${index} must be an object.`);
        }
        const { canonical, variants, matchCase } = entry;
        if (!isNonEmptyString(canonical)) {
            throw new CastrecallSetupError(`Glossary term at index ${index} must have a non-empty string "canonical".`);
        }
        if (!Array.isArray(variants) || variants.length === 0 || !variants.every(isNonEmptyString)) {
            throw new CastrecallSetupError(`Glossary term "${canonical}" must have a non-empty array of non-empty string "variants".`);
        }
        if (matchCase !== undefined && typeof matchCase !== "boolean") {
            throw new CastrecallSetupError(`Glossary term "${canonical}" has a non-boolean "matchCase".`);
        }
        return { canonical, variants, matchCase };
    });
    return { terms: parsed };
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/**
 * Flattens every (variant, entry) pair into one globally ranked list, sorted
 * longest-first (ties broken by variant string) so the longest match always
 * wins across entries regardless of declaration order. Rejects a variant
 * that maps to two different canonicals as ambiguous.
 */
export function compileGlossary(entries) {
    const byKey = new Map();
    for (const entry of entries) {
        const matchCase = entry.matchCase ?? false;
        for (const variant of entry.variants) {
            const key = matchCase ? variant : variant.toLowerCase();
            const existing = byKey.get(key);
            if (existing && existing.canonical !== entry.canonical) {
                throw new CastrecallSetupError(`Glossary variant "${variant}" is ambiguous: it maps to both "${existing.canonical}" ` +
                    `and "${entry.canonical}". Each variant must resolve to exactly one canonical term.`);
            }
            byKey.set(key, { variant, canonical: entry.canonical, matchCase });
        }
    }
    const all = [...byKey.values()].sort((a, b) => {
        if (b.variant.length !== a.variant.length)
            return b.variant.length - a.variant.length;
        return a.variant.localeCompare(b.variant);
    });
    const variants = all.map((v) => ({
        ...v,
        pattern: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(v.variant)}(?![\\p{L}\\p{N}])`, v.matchCase ? "gu" : "giu"),
    }));
    return { variants };
}
/**
 * Each variant is scanned independently (its own pattern, its own matchAll
 * pass) rather than via one combined alternation. A combined pattern's
 * single non-overlapping scan would consume "new york" and never even
 * observe "york city" starting inside it — collecting per-variant is what
 * lets resolveOverlaps see every shifted-overlap candidate, not just the
 * ones that happen to start where a prior match left off.
 */
function collectSpans(text, compiled) {
    const spans = [];
    for (const v of compiled.variants) {
        for (const match of text.matchAll(v.pattern)) {
            spans.push({
                start: match.index,
                end: match.index + match[0].length,
                canonical: v.canonical,
                variant: v.variant,
            });
        }
    }
    return spans;
}
/** Sort by span length descending (ties broken by start ascending) so the longest match is always considered first, then greedily accept spans that don't overlap an already-accepted one — genuine longest-wins regardless of start position. */
function resolveOverlaps(spans) {
    const sorted = [...spans].sort((a, b) => {
        const lengthDiff = b.end - b.start - (a.end - a.start);
        if (lengthDiff !== 0)
            return lengthDiff;
        return a.start - b.start;
    });
    const accepted = [];
    for (const span of sorted) {
        if (accepted.some((a) => span.start < a.end && a.start < span.end))
            continue;
        accepted.push(span);
    }
    return accepted.sort((a, b) => a.start - b.start);
}
/**
 * Applies compiled glossary corrections to `text` in a single pass over the
 * ORIGINAL string: matches are collected once against the untouched input,
 * overlaps resolved, then spliced left-to-right. This guarantees a canonical
 * produced by one correction is never re-scanned by another rule.
 */
export function applyGlossary(text, compiled) {
    const spans = resolveOverlaps(collectSpans(text, compiled));
    const counts = new Map();
    let out = "";
    let cursor = 0;
    for (const span of spans) {
        out += text.slice(cursor, span.start);
        const matched = text.slice(span.start, span.end);
        out += span.canonical;
        cursor = span.end;
        if (matched === span.canonical)
            continue; // no-op: already canonical, don't record churn
        const key = `${span.canonical}\u0000${span.variant}`;
        const existing = counts.get(key);
        if (existing) {
            existing.count += 1;
        }
        else {
            counts.set(key, { canonical: span.canonical, variant: span.variant, count: 1 });
        }
    }
    out += text.slice(cursor);
    return { text: out, corrections: [...counts.values()] };
}
