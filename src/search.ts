/**
 * Search over the private transcript corpus. Two layers, mirroring
 * corpus-export.ts (pure builders) + storage.ts (IO): pure tokenize/parse/
 * score/snippet functions below, `SearchIndex` for the on-disk cache.
 *
 * Two-phase scoring: Phase 1 scores every doc from a persisted term-frequency
 * index (tf-length-normalized + idf-lite) and selects a bounded candidate set
 * — docs matching any bare term, plus docs containing every token of a quoted
 * phrase (always retained, so an exact-phrase doc is never missed). Phase 2
 * re-reads only the capped candidate set's transcript text, applies an exact
 * contiguous-phrase bonus, and builds snippets. The index therefore stores
 * term frequencies only — never prose, never positional data.
 */

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
};

/** Build a document's term-frequency record from its transcript text. Pure. */
export function buildDocument(uuid: string, contentHash: string, text: string): IndexedDocument {
  const tokens = tokenize(text);
  const termFreq: Record<string, number> = {};
  for (const token of tokens) termFreq[token] = (termFreq[token] ?? 0) + 1;
  return { uuid, contentHash, length: tokens.length, termFreq };
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
/** Bounds how many candidate transcripts Phase 2 reads for phrase/snippet scoring per search. */
export const MAX_CANDIDATES = 50;

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
    const tmpPath = `${this.indexPath}.tmp`;
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
      if (current && current.contentHash === entry.contentHash) {
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
  ): Promise<{ hits: SearchHit[]; droppedCandidates: number }> {
    const query = parseQuery(rawQuery);
    const byUuid = new Map(corpus.map((entry) => [entry.uuid, entry]));
    const docs = await this.reconcile(corpus);

    const candidateUuids = selectCandidates(query, docs);
    const keywordScores = scoreKeywords(query, docs);
    const cappedCandidates = candidateUuids.slice(0, MAX_CANDIDATES);
    const droppedCandidates = candidateUuids.length - cappedCandidates.length;

    const scored: Array<{ uuid: string; score: number; text: string }> = [];
    for (const uuid of cappedCandidates) {
      const entry = byUuid.get(uuid);
      if (!entry) continue;
      const text = await entry.readText();
      const bonus = phraseBonus(query.phrases, tokenize(text));
      const score = (keywordScores.get(uuid) ?? 0) + bonus;
      if (score > 0) scored.push({ uuid, score, text });
    }

    scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.uuid.localeCompare(b.uuid)));

    const limit = clampLimit(opts.limit);
    const hits: SearchHit[] = [];
    for (const item of scored.slice(0, limit)) {
      const entry = byUuid.get(item.uuid);
      if (!entry) continue;
      const { snippet, snippetText } = buildSnippet(item.text, query);
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
    return { hits, droppedCandidates };
  }
}
