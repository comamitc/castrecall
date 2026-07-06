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
  byMatch: Map<string, { variant: string; canonical: string }>;
  /**
   * Authoritative rare-path identification for the insensitive class: each
   * variant carries an anchored /iu matcher — the SAME semantics that
   * produced the scanner match — so scan and lookup can never disagree.
   * Simple case folding is 1:1, so candidates are filtered by exact length
   * first; this path only runs when the toLowerCase fast path misses.
   */
  fallback: Array<{ variant: string; canonical: string; exact: RegExp }>;
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validates glossary JSON shape only — no knowledge of where it came from.
 * The caller (loadGlossary in tools.ts) attaches the file path to any thrown
 * error, so this stays reusable/testable without an I/O boundary.
 */
export function parseGlossary(json: unknown): RawGlossary {
  if (typeof json !== "object" || json === null || !("terms" in json)) {
    throw new CastrecallSetupError("Glossary must be a JSON object with a \"terms\" array.");
  }
  const terms = (json as { terms: unknown }).terms;
  if (!Array.isArray(terms)) {
    throw new CastrecallSetupError("Glossary \"terms\" must be an array.");
  }
  const parsed: GlossaryEntry[] = terms.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new CastrecallSetupError(`Glossary term at index ${index} must be an object.`);
    }
    const { canonical, variants, matchCase } = entry as Record<string, unknown>;
    if (!isNonEmptyString(canonical)) {
      throw new CastrecallSetupError(
        `Glossary term at index ${index} must have a non-empty string "canonical".`,
      );
    }
    if (!Array.isArray(variants) || variants.length === 0 || !variants.every(isNonEmptyString)) {
      throw new CastrecallSetupError(
        `Glossary term "${canonical}" must have a non-empty array of non-empty string "variants".`,
      );
    }
    if (matchCase !== undefined && typeof matchCase !== "boolean") {
      throw new CastrecallSetupError(
        `Glossary term "${canonical}" has a non-boolean "matchCase".`,
      );
    }
    return { canonical, variants, matchCase };
  });
  return { terms: parsed };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Flattens every (variant, entry) pair into one globally ranked list, sorted
 * longest-first (ties broken by variant string) so the longest match always
 * wins across entries regardless of declaration order. Rejects a variant
 * that maps to two different canonicals as ambiguous.
 */
export function compileGlossary(entries: GlossaryEntry[]): CompiledGlossary {
  const byKey = new Map<string, { variant: string; canonical: string; matchCase: boolean }>();
  for (const entry of entries) {
    const matchCase = entry.matchCase ?? false;
    for (const variant of entry.variants) {
      const key = matchCase ? variant : variant.toLowerCase();
      const existing = byKey.get(key);
      if (existing && existing.canonical !== entry.canonical) {
        throw new CastrecallSetupError(
          `Glossary variant "${variant}" is ambiguous: it maps to both "${existing.canonical}" ` +
            `and "${entry.canonical}". Each variant must resolve to exactly one canonical term.`,
        );
      }
      byKey.set(key, { variant, canonical: entry.canonical, matchCase });
    }
  }

  const all = [...byKey.values()].sort((a, b) => {
    if (b.variant.length !== a.variant.length) return b.variant.length - a.variant.length;
    return a.variant.localeCompare(b.variant);
  });

  const scanners: CompiledScanner[] = [];
  for (const caseSensitive of [true, false]) {
    const classVariants = all.filter((v) => v.matchCase === caseSensitive);
    if (classVariants.length === 0) continue;
    // Longest-first alternation: at any given start position the regex
    // engine takes the first alternative that fits, so the longest variant
    // at that position wins within the class — the same rank rule the
    // per-variant sort encodes. One capture group wraps the WHOLE
    // alternation (per-variant groups would attach thousands of empty
    // capture slots to every hit and force an O(variants) group scan per
    // match); the matched alternative is identified by the constant-time
    // byMatch fast path with the /iu-exact fallback for fold divergence.
    const alternation = classVariants.map((v) => escapeRegExp(v.variant)).join("|");
    const byMatch = new Map<string, { variant: string; canonical: string }>();
    for (const v of classVariants) {
      byMatch.set(caseSensitive ? v.variant : v.variant.toLowerCase(), {
        variant: v.variant,
        canonical: v.canonical,
      });
    }
    if (!caseSensitive) {
      // Under /iu the scanner cannot distinguish two variants that Unicode
      // case-fold to the same value (micro sign vs Greek mu, final sigma vs
      // sigma…). If such a pair maps to DIFFERENT canonicals, every match of
      // either spelling is inherently ambiguous — any resolution rule (map
      // order, alternation order) would silently override one of the user's
      // exact configured spellings. Fail closed at compile time, exactly
      // like the same-lowercase-key ambiguity above; entries that need
      // fold-distinct spellings can set matchCase: true, whose scanner
      // matches exactly. Scoped to non-ASCII variants — same-length pure-
      // ASCII pairs are already covered by the toLowerCase key check.
      for (const a of classVariants) {
        if (/^[\x00-\x7f]*$/.test(a.variant)) continue;
        const aExact = new RegExp(`^(?:${escapeRegExp(a.variant)})$`, "iu");
        for (const b of classVariants) {
          if (b === a || b.canonical === a.canonical || b.variant.length !== a.variant.length) {
            continue;
          }
          if (aExact.test(b.variant)) {
            throw new CastrecallSetupError(
              `Glossary variants "${a.variant}" (→ "${a.canonical}") and "${b.variant}" ` +
                `(→ "${b.canonical}") are indistinguishable under case-insensitive Unicode ` +
                "matching. Give them the same canonical, or set matchCase: true on their " +
                "entries to match the exact spellings.",
            );
          }
        }
      }
    }
    scanners.push({
      pattern: new RegExp(
        `(?<![\\p{L}\\p{N}])(?=(${alternation})(?![\\p{L}\\p{N}]))`,
        caseSensitive ? "gu" : "giu",
      ),
      caseSensitive,
      byMatch,
      fallback: caseSensitive
        ? []
        : classVariants.map((v) => ({
            variant: v.variant,
            canonical: v.canonical,
            exact: new RegExp(`^(?:${escapeRegExp(v.variant)})$`, "iu"),
          })),
    });
  }

  return { scanners };
}

type Span = { start: number; end: number; canonical: string; variant: string };

/**
 * One zero-width lookahead scan per case class (at most two passes total,
 * regardless of glossary size — the previous per-variant matchAll made this
 * O(variants × text length)). Because the overall match is zero-width, the
 * scan advances through every position, so a candidate starting INSIDE
 * another candidate ("york city" inside "new york") is still enumerated and
 * resolveOverlaps sees every shifted-overlap candidate. Within one position
 * the longest-first alternation picks the longest variant; a strictly
 * shorter same-start alternative is intentionally shadowed (deterministic
 * longest-at-position, matching the global rank rule).
 */
function collectSpans(text: string, compiled: CompiledGlossary): Span[] {
  const spans: Span[] = [];
  for (const scanner of compiled.scanners) {
    for (const match of text.matchAll(scanner.pattern)) {
      const matched = match[1];
      let hit = scanner.byMatch.get(scanner.caseSensitive ? matched : matched.toLowerCase());
      if (!hit && !scanner.caseSensitive) {
        // toLowerCase missed but the /iu scanner matched (case-fold
        // divergence): identify the variant with the same /iu semantics.
        // Rare path — runs only on fast-path misses, never per ordinary hit.
        hit = scanner.fallback.find(
          (candidate) => candidate.variant.length === matched.length && candidate.exact.test(matched),
        );
      }
      if (!hit) continue;
      spans.push({
        start: match.index,
        end: match.index + matched.length,
        canonical: hit.canonical,
        variant: hit.variant,
      });
    }
  }
  return spans;
}

/** Sort by span length descending (ties broken by start ascending) so the longest match is always considered first, then greedily accept spans that don't overlap an already-accepted one — genuine longest-wins regardless of start position. */
function resolveOverlaps(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => {
    const lengthDiff = b.end - b.start - (a.end - a.start);
    if (lengthDiff !== 0) return lengthDiff;
    return a.start - b.start;
  });
  const accepted: Span[] = [];
  for (const span of sorted) {
    if (accepted.some((a) => span.start < a.end && a.start < span.end)) continue;
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
export function applyGlossary(text: string, compiled: CompiledGlossary): GlossaryResult {
  const spans = resolveOverlaps(collectSpans(text, compiled));
  const counts = new Map<string, GlossaryCorrection>();
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start);
    const matched = text.slice(span.start, span.end);
    out += span.canonical;
    cursor = span.end;
    if (matched === span.canonical) continue; // no-op: already canonical, don't record churn
    const key = `${span.canonical}\u0000${span.variant}`;
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, { canonical: span.canonical, variant: span.variant, count: 1 });
    }
  }
  out += text.slice(cursor);
  return { text: out, corrections: [...counts.values()] };
}
