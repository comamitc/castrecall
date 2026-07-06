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
] as const;

export const DEFAULT_CLEANUP_OPTIONS = {
  cueAllowlist: STANDALONE_CUE_ALLOWLIST,
};

const CUE_LINE_PATTERN = /^[[(]\s*([^\])]+?)\s*[\])]$/;

function isStandaloneCueLine(line: string, allowlist: readonly string[]): boolean {
  const match = line.trim().match(CUE_LINE_PATTERN);
  if (!match) return false;
  const inner = match[1].trim().toUpperCase();
  return allowlist.some((cue) => cue.toUpperCase() === inner);
}

function stripStandaloneCueLines(text: string, allowlist: readonly string[]): string {
  return text
    .split("\n")
    .filter((line) => !isStandaloneCueLine(line, allowlist))
    .join("\n");
}

function stripCaptionMarkers(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*>+\s*/, "").replace(/^\s*-\s+/, ""))
    .join("\n");
}

const TERMINAL_PUNCTUATION = new Set([".", "?", "!"]);

function fixPunctuationGlue(text: string): string {
  return text
    .replace(/[ \t]+([,.;:?!])/g, "$1")
    .replace(/([.?!])[.?!]+/g, "$1")
    .replace(/([,.;:?!])(?=[\p{L}\p{N}])/gu, (match, punct, offset, str) => {
      const next = str[offset + 1];
      if (TERMINAL_PUNCTUATION.has(punct)) {
        // Only split before an uppercase letter (a real new sentence) — this
        // avoids splitting decimals ("3.14") and lowercase domain/URL
        // continuations ("example.com") since neither is followed by an
        // uppercase letter.
        return /\p{Lu}/u.test(next) ? `${punct} ` : punct;
      }
      // Comma/semicolon/colon: avoid splitting digit-glued tokens like clock
      // times ("10:30") or thousands separators ("3,000").
      const prev = str[offset - 1];
      if (prev !== undefined && /\p{N}/u.test(prev) && /\p{N}/u.test(next)) {
        return punct;
      }
      return `${punct} `;
    });
}

/** A lone `\n` before a `Name:` turn is promoted to a blank-line paragraph break; already-blank-separated turns are left alone. */
const SPEAKER_TURN_BOUNDARY = /(?<=[^\n])\n(?=[A-Za-z][\w .'-]{0,40}:\s)/g;

function separateSpeakerTurns(text: string): string {
  return text.replace(SPEAKER_TURN_BOUNDARY, "\n\n");
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Tokenizes `text` with caption markers stripped and allowlisted standalone
 * cue lines removed — the same removals `cleanTranscript` performs, in the
 * same order — so it can be compared before and after cleanup to prove no
 * spoken word was added, removed, or reordered.
 */
export function spokenTokens(
  text: string,
  allowlist: readonly string[] = STANDALONE_CUE_ALLOWLIST,
): string[] {
  return tokenize(stripStandaloneCueLines(stripCaptionMarkers(text), allowlist));
}

/**
 * Applies a conservative, deterministic cleanup pass to already-normalized
 * transcript text: strips standalone non-speech cues and caption markers,
 * de-glues/de-duplicates existing punctuation, paragraph-separates speaker
 * turns, and re-collapses whitespace. Never adds punctuation or words. Each
 * step only appears in `applied` when it actually changed the text.
 */
export function cleanTranscript(text: string, options: CleanupOptions = {}): CleanupResult {
  const opts = { ...DEFAULT_CLEANUP_OPTIONS, ...options };
  const applied: string[] = [];
  let out = text;

  const steps: Array<{ name: string; run: (t: string) => string }> = [
    { name: "strip-caption-markers", run: stripCaptionMarkers },
    { name: "strip-standalone-cues", run: (t) => stripStandaloneCueLines(t, opts.cueAllowlist) },
    { name: "fix-punctuation-glue", run: fixPunctuationGlue },
    { name: "separate-speaker-turns", run: separateSpeakerTurns },
    { name: "collapse-whitespace", run: collapseWhitespace },
  ];

  for (const step of steps) {
    const next = step.run(out);
    if (next !== out) applied.push(step.name);
    out = next;
  }

  return { text: out, applied };
}
