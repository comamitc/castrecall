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

type CompiledVariant = {
  variant: string;
  canonical: string;
  matchCase: boolean;
};

export type CompiledGlossary = {
  /** Combined case-insensitive pattern, or undefined when there are no case-insensitive variants. */
  insensitivePattern?: RegExp;
  /** Combined case-sensitive pattern, or undefined when there are no matchCase variants. */
  sensitivePattern?: RegExp;
  /** Lookup from the matched literal variant text (lowercased for insensitive entries) to its entry. */
  byMatch: Map<string, CompiledVariant>;
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
  const byKey = new Map<string, CompiledVariant>();
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

  const insensitive = all.filter((v) => !v.matchCase);
  const sensitive = all.filter((v) => v.matchCase);

  const byMatch = new Map<string, CompiledVariant>();
  for (const v of all) {
    byMatch.set(v.matchCase ? v.variant : v.variant.toLowerCase(), v);
  }

  const toPattern = (variants: CompiledVariant[], flags: string): RegExp | undefined => {
    if (variants.length === 0) return undefined;
    const alternation = variants.map((v) => escapeRegExp(v.variant)).join("|");
    return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternation})(?![\\p{L}\\p{N}])`, flags);
  };

  return {
    insensitivePattern: toPattern(insensitive, "giu"),
    sensitivePattern: toPattern(sensitive, "gu"),
    byMatch,
  };
}

type Span = { start: number; end: number; canonical: string; variant: string };

function collectSpans(text: string, compiled: CompiledGlossary): Span[] {
  const spans: Span[] = [];
  const patterns = [compiled.insensitivePattern, compiled.sensitivePattern];
  for (const pattern of patterns) {
    if (!pattern) continue;
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const matched = match[0];
      const entry = compiled.byMatch.get(
        compiled.byMatch.has(matched) ? matched : matched.toLowerCase(),
      );
      if (!entry) continue;
      spans.push({
        start: match.index,
        end: match.index + matched.length,
        canonical: entry.canonical,
        variant: entry.variant,
      });
    }
  }
  return spans;
}

/** Sort by start ascending, then by span length descending, then greedily accept non-overlapping spans (longest-wins on conflict). */
function resolveOverlaps(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.end - b.start - (a.end - a.start);
  });
  const accepted: Span[] = [];
  let lastEnd = -1;
  for (const span of sorted) {
    if (span.start < lastEnd) continue;
    accepted.push(span);
    lastEnd = span.end;
  }
  return accepted;
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
