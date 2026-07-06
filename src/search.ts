/**
 * Search over the private transcript corpus. Two layers, mirroring
 * corpus-export.ts (pure builders) + storage.ts (IO): pure tokenize/parse/
 * score/snippet functions below, `SearchIndex` for the on-disk cache.
 *
 * Two-phase scoring, with ranking settled entirely from the index. Phase 1
 * scores every doc (tf-length-normalized + idf-lite over term frequencies)
 * and resolves quoted-phrase bonuses from index fingerprints alone: hashed
 * adjacent-token-pair bigrams as a cheap necessary-condition prefilter,
 * then hashed per-occurrence token@position fingerprints to confirm true
 * contiguity. No transcript is ever read to rank, so an exact phrase match
 * can never be hidden behind higher-scoring false positives (every
 * candidate is fully scored) and a broad query can never trigger a
 * corpus-wide transcript scan. Phase 2 reads only the final top `limit`
 * docs to build snippets. The index stores term frequencies and one-way
 * FNV hashes only — no plaintext prose, and positions appear solely inside
 * one-way occurrence hashes. Nothing in it is more revealing than the
 * transcript files it sits beside, and all of it is rebuilt from them on
 * contentHash or schema change.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Provenance } from "./storage.js";

const WORD_PATTERN = /[\p{L}\p{N}]+/gu;

function normalizeToken(raw: string): string {
  return raw.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** Unicode-safe tokenization: NFKD + combining-mark strip + lowercase, split on letters/numbers. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(WORD_PATTERN)) {
    const value = normalizeToken(match[0]);
    if (value) tokens.push(value);
  }
  return tokens;
}

type TokenSpan = { value: string; start: number; end: number };

function tokenizeWithSpans(text: string): TokenSpan[] {
  const spans: TokenSpan[] = [];
  for (const match of text.matchAll(WORD_PATTERN)) {
    const value = normalizeToken(match[0]);
    if (value) spans.push({ value, start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  }
  return spans;
}

export type ParsedQuery = { terms: string[]; phrases: string[][] };

/** Extract `"quoted phrases"` (as token arrays) from bare terms. Unbalanced quotes fall through to tokenize() as literal terms. */
export function parseQuery(raw: string): ParsedQuery {
  const phrases: string[][] = [];
  let remainder = "";
  let last = 0;
  const phrasePattern = /"([^"]*)"/g;
  for (const match of raw.matchAll(phrasePattern)) {
    remainder += raw.slice(last, match.index ?? 0);
    const phraseTokens = tokenize(match[1]);
    if (phraseTokens.length > 0) phrases.push(phraseTokens);
    last = (match.index ?? 0) + match[0].length;
  }
  remainder += raw.slice(last);
  return { terms: tokenize(remainder), phrases };
}

export type IndexedDocument = {
  uuid: string;
  contentHash: string;
  length: number;
  termFreq: Record<string, number>;
  /** Unique FNV-1a hashes of each adjacent token pair — cheap phrase prefilter, not recoverable prose. */
  bigrams: string[];
  /**
   * One 64-bit one-way hash per token occurrence (`token@position`), in
   * token order. Lets a quoted phrase's exact contiguity be confirmed by
   * membership probes alone — no transcript read — while keeping the index
   * free of plaintext prose.
   */
  occurrences: string[];
};

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** One-way fingerprint of an adjacent token pair. ` ` separator keeps ("ab","c") ≠ ("a","bc"). */
export function hashBigram(first: string, second: string): string {
  return fnv1a(`${first} ${second}`);
}

/**
 * One-way 64-bit fingerprint of a token occurrence at a token index. Two
 * independent 32-bit FNV-1a passes are concatenated so accidental
 * collisions (which would fake a contiguity probe) are negligible even
 * across hour-long transcripts.
 */
export function hashOccurrence(term: string, position: number): string {
  const key = `${term} ${position}`;
  return fnv1a(key) + fnv1a(`${key}#`);
}

/** Build a document's term-frequency + fingerprint record from its transcript text. Pure. */
export function buildDocument(uuid: string, contentHash: string, text: string): IndexedDocument {
  const tokens = tokenize(text);
  const termFreq: Record<string, number> = {};
  for (const token of tokens) termFreq[token] = (termFreq[token] ?? 0) + 1;
  const bigrams = new Set<string>();
  for (let i = 0; i + 1 < tokens.length; i++) bigrams.add(hashBigram(tokens[i], tokens[i + 1]));
  const occurrences = tokens.map((token, i) => hashOccurrence(token, i));
  return { uuid, contentHash, length: tokens.length, termFreq, bigrams: Array.from(bigrams), occurrences };
}

/**
 * Index-only phrase eligibility: every phrase token present AND every
 * adjacent phrase pair's bigram fingerprint present. Necessary but not
 * sufficient for a contiguous match (e.g. "a b … b c" carries both "a b"
 * and "b c" without "a b c"), so Phase 2 still verifies by reading — but
 * docs holding the tokens only non-contiguously are excluded up front,
 * without transcript IO.
 */
export function phraseEligible(doc: IndexedDocument, phrase: string[]): boolean {
  if (phrase.length === 0) return false;
  if (!phrase.every((term) => (doc.termFreq[term] ?? 0) > 0)) return false;
  if (phrase.length === 1) return true;
  const fingerprints = new Set(doc.bigrams);
  for (let i = 0; i + 1 < phrase.length; i++) {
    if (!fingerprints.has(hashBigram(phrase[i], phrase[i + 1]))) return false;
  }
  return true;
}

/**
 * Exact, index-only contiguity check: the phrase matches iff some start
 * index has every phrase token's occurrence fingerprint at consecutive
 * positions. Settles what `phraseEligible`'s bigram chains can only
 * approximate (e.g. "a b … b c" passes the chain without containing
 * "a b c"), still without reading any transcript. Pass a prebuilt
 * `occurrences` set when probing several phrases against one doc.
 */
export function phraseConfirmed(
  doc: IndexedDocument,
  phrase: string[],
  occurrences?: Set<string>,
): boolean {
  if (phrase.length === 0) return false;
  if (!phrase.every((term) => (doc.termFreq[term] ?? 0) > 0)) return false;
  if (phrase.length === 1) return true;
  const probes = occurrences ?? new Set(doc.occurrences);
  outer: for (let start = 0; start + phrase.length <= doc.length; start++) {
    for (let j = 0; j < phrase.length; j++) {
      if (!probes.has(hashOccurrence(phrase[j], start + j))) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Candidate uuids: docs matching any bare keyword term, union docs
 * containing every token of any quoted phrase (phrase-eligible docs are
 * always retained, since a doc with the exact phrase necessarily contains
 * every phrase token).
 */
export function selectCandidates(query: ParsedQuery, docs: IndexedDocument[]): string[] {
  const uuids: string[] = [];
  for (const doc of docs) {
    const hasTerm = query.terms.some((term) => (doc.termFreq[term] ?? 0) > 0);
    const hasPhrase = query.phrases.some(
      (phrase) => phrase.length > 0 && phrase.every((term) => (doc.termFreq[term] ?? 0) > 0),
    );
    if (hasTerm || hasPhrase) uuids.push(doc.uuid);
  }
  return uuids;
}

/**
 * tf-length-normalized + idf-lite keyword score across bare terms and quoted
 * phrase tokens (so a phrase-only query still scores its candidates before
 * the Phase 2 contiguity bonus is added).
 */
export function scoreKeywords(query: ParsedQuery, docs: IndexedDocument[]): Map<string, number> {
  const allTerms = Array.from(new Set([...query.terms, ...query.phrases.flat()]));
  const scores = new Map<string, number>();
  if (allTerms.length === 0) {
    for (const doc of docs) scores.set(doc.uuid, 0);
    return scores;
  }
  const totalDocs = docs.length;
  const idf = new Map<string, number>();
  for (const term of allTerms) {
    const df = docs.reduce((count, doc) => count + ((doc.termFreq[term] ?? 0) > 0 ? 1 : 0), 0);
    idf.set(term, Math.log(1 + totalDocs / Math.max(df, 1)));
  }
  for (const doc of docs) {
    let score = 0;
    for (const term of allTerms) {
      const tf = doc.termFreq[term] ?? 0;
      if (tf === 0) continue;
      score += (tf / Math.max(doc.length, 1)) * (idf.get(term) ?? 0);
    }
    scores.set(doc.uuid, score);
  }
  return scores;
}

const PHRASE_BONUS_WEIGHT = 10;

/** Additive bonus for each quoted phrase whose tokens appear contiguously in `docTokens`. */
export function phraseBonus(phrases: string[][], docTokens: string[]): number {
  let bonus = 0;
  for (const phrase of phrases) {
    if (phrase.length > 0 && containsContiguous(docTokens, phrase)) {
      bonus += phrase.length * PHRASE_BONUS_WEIGHT;
    }
  }
  return bonus;
}

function containsContiguous(tokens: string[], phrase: string[]): boolean {
  outer: for (let i = 0; i <= tokens.length - phrase.length; i++) {
    for (let j = 0; j < phrase.length; j++) {
      if (tokens[i + j] !== phrase[j]) continue outer;
    }
    return true;
  }
  return false;
}

export type Snippet = { snippet: string; snippetText: string; offset: number };

const DEFAULT_SNIPPET_RADIUS = 160;

/**
 * A display-formatted, highlighted window around the best match (`snippet`)
 * plus the exact verbatim slice it was built from (`snippetText`), so quoted
 * material always stays attributable to the transcript, not to a mutated
 * string.
 */
export function buildSnippet(
  text: string,
  query: ParsedQuery,
  opts: { radius?: number } = {},
): Snippet {
  const radius = opts.radius ?? DEFAULT_SNIPPET_RADIUS;
  const spans = tokenizeWithSpans(text);
  const matchTerms = new Set([...query.terms, ...query.phrases.flat()]);

  let anchorStart = 0;
  let anchorEnd = 0;

  phraseSearch: for (const phrase of query.phrases) {
    if (phrase.length === 0) continue;
    for (let i = 0; i <= spans.length - phrase.length; i++) {
      let matched = true;
      for (let j = 0; j < phrase.length; j++) {
        if (spans[i + j].value !== phrase[j]) {
          matched = false;
          break;
        }
      }
      if (matched) {
        anchorStart = spans[i].start;
        anchorEnd = spans[i + phrase.length - 1].end;
        break phraseSearch;
      }
    }
  }

  if (anchorStart === 0 && anchorEnd === 0) {
    const hit = spans.find((span) => matchTerms.has(span.value));
    if (hit) {
      anchorStart = hit.start;
      anchorEnd = hit.end;
    }
  }

  const center = Math.floor((anchorStart + anchorEnd) / 2);
  const windowStart = Math.max(0, center - radius);
  const windowEnd = Math.min(text.length, center + radius);
  const snippetText = text.slice(windowStart, windowEnd);

  const highlightSpans = spans
    .filter((span) => span.start >= windowStart && span.end <= windowEnd && matchTerms.has(span.value))
    .sort((a, b) => b.start - a.start);

  let highlighted = snippetText;
  for (const span of highlightSpans) {
    const relStart = span.start - windowStart;
    const relEnd = span.end - windowStart;
    highlighted = `${highlighted.slice(0, relStart)}**${highlighted.slice(relStart, relEnd)}**${highlighted.slice(relEnd)}`;
  }

  return {
    snippet: `${windowStart > 0 ? "…" : ""}${highlighted}${windowEnd < text.length ? "…" : ""}`,
    snippetText,
    offset: windowStart,
  };
}

/**
 * The tool layer's view of one stored transcript, assembled from `state.json`
 * + `sources/<uuid>/`. `SearchIndex` reconciles/scores/snippets purely
 * against this — no hidden storage or provenance lookups inside the index.
 */
export type CorpusEntry = {
  uuid: string;
  contentHash: string;
  provenance: Provenance;
  transcriptPath: string;
  readText: () => Promise<string>;
};

export type SearchHit = {
  episodeUuid: string;
  podcast: string;
  episode: string;
  listenDate?: string;
  transcriptSource: string;
  transcriptPath: string;
  score: number;
  snippet: string;
  snippetText: string;
};

export type SearchOptions = { limit?: number };

export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 25;

/** `limit && limit > 0 ? … : default` — same guard idiom as tools.ts's listRecent — plus a hard max cap. */
export function clampLimit(limit: number | undefined): number {
  if (!limit || limit <= 0) return DEFAULT_SEARCH_LIMIT;
  return Math.min(limit, MAX_SEARCH_LIMIT);
}

/**
 * Persisted, rebuildable term-frequency cache under `<dataDir>/.index/`.
 * Reconciled by contentHash on every search: an unchanged corpus re-
 * tokenizes nothing, a corrupt/missing index self-heals via full rescan
 * (same tolerant idiom as `Storage.loadState`), written via tmp+rename (same
 * idiom as `Storage.saveState`).
 */
export class SearchIndex {
  constructor(private readonly indexDir: string) {}

  private get indexPath(): string {
    return path.join(this.indexDir, "search-index.json");
  }

  private async load(): Promise<IndexedDocument[]> {
    try {
      const raw = await fs.readFile(this.indexPath, "utf8");
      const parsed = JSON.parse(raw) as { docs?: IndexedDocument[] };
      return Array.isArray(parsed.docs) ? parsed.docs : [];
    } catch {
      return [];
    }
  }

  private async persist(docs: IndexedDocument[]): Promise<void> {
    await fs.mkdir(this.indexDir, { recursive: true });
    // Unique per attempt so concurrent searches reconciling the same index
    // don't share (and race on) a single fixed temp path.
    const tmpPath = `${this.indexPath}.${randomUUID()}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify({ docs }, null, 2)}\n`, "utf8");
    await fs.rename(tmpPath, this.indexPath);
  }

  private async reconcile(corpus: CorpusEntry[]): Promise<IndexedDocument[]> {
    const existing = await this.load();
    const byUuid = new Map(existing.map((doc) => [doc.uuid, doc]));
    const reconciled: IndexedDocument[] = [];
    let changed = corpus.length !== existing.length;
    for (const entry of corpus) {
      const current = byUuid.get(entry.uuid);
      // Schema check alongside contentHash: docs persisted before the
      // bigram/occurrence fingerprints existed rebuild themselves on the
      // next search.
      if (
        current &&
        current.contentHash === entry.contentHash &&
        Array.isArray(current.bigrams) &&
        Array.isArray(current.occurrences)
      ) {
        reconciled.push(current);
        continue;
      }
      changed = true;
      const text = await entry.readText();
      reconciled.push(buildDocument(entry.uuid, entry.contentHash, text));
    }
    if (changed) await this.persist(reconciled);
    return reconciled;
  }

  /**
   * Search the given corpus. `corpus` is the tool layer's authoritative view
   * of stored transcripts — the index never looks anything up itself.
   */
  async search(
    rawQuery: string,
    opts: SearchOptions,
    corpus: CorpusEntry[],
  ): Promise<{ hits: SearchHit[] }> {
    const query = parseQuery(rawQuery);
    const byUuid = new Map(corpus.map((entry) => [entry.uuid, entry]));
    const docs = await this.reconcile(corpus);

    const candidateUuids = selectCandidates(query, docs);
    const keywordScores = scoreKeywords(query, docs);
    const limit = clampLimit(opts.limit);

    // Every candidate's final score — keyword score plus phrase bonuses —
    // is computed from the index alone: the bigram-chain prefilter cheaply
    // rejects docs holding the tokens only non-contiguously, and the
    // occurrence fingerprints confirm exact contiguity for the rest. No
    // transcript is read to rank, so ranking is complete over ALL
    // candidates: an exact phrase match can never be hidden behind
    // higher-scoring false positives, and no query shape — however broad —
    // triggers corpus-wide transcript IO.
    const docByUuid = new Map(docs.map((doc) => [doc.uuid, doc]));
    const ranked = candidateUuids
      .map((uuid) => {
        const doc = docByUuid.get(uuid);
        let bonus = 0;
        if (doc && query.phrases.length > 0) {
          let probes: Set<string> | undefined;
          for (const phrase of query.phrases) {
            if (phrase.length === 0 || !phraseEligible(doc, phrase)) continue;
            probes ??= new Set(doc.occurrences);
            if (phraseConfirmed(doc, phrase, probes)) bonus += phrase.length * PHRASE_BONUS_WEIGHT;
          }
        }
        return { uuid, score: (keywordScores.get(uuid) ?? 0) + bonus };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.uuid.localeCompare(b.uuid)));

    // Phase 2: the only transcript reads in a search — snippets for the
    // top `limit` hits.
    const hits: SearchHit[] = [];
    for (const item of ranked.slice(0, limit)) {
      const entry = byUuid.get(item.uuid);
      if (!entry) continue;
      const text = await entry.readText();
      const { snippet, snippetText } = buildSnippet(text, query);
      hits.push({
        episodeUuid: entry.provenance.episodeUuid,
        podcast: entry.provenance.podcastTitle,
        episode: entry.provenance.episodeTitle,
        listenDate: entry.provenance.listenTimestamp?.slice(0, 10),
        transcriptSource: entry.provenance.transcriptSource,
        transcriptPath: entry.transcriptPath,
        score: item.score,
        snippet,
        snippetText,
      });
    }
    return { hits };
  }
}
