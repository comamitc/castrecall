/**
 * Search over the private transcript corpus. Two layers, mirroring
 * corpus-export.ts (pure builders) + storage.ts (IO): pure tokenize/parse/
 * score/snippet functions below, `SearchIndex` for the on-disk cache.
 *
 * Two-phase scoring: Phase 1 scores every doc from a persisted term-frequency
 * index (tf-length-normalized + idf-lite) and selects a candidate set — docs
 * matching any bare term, plus phrase-eligible docs. Phrase eligibility is
 * decided from the index alone: alongside term frequencies each doc stores
 * hashed adjacent-token-pair fingerprints (FNV-1a of each bigram), and a doc
 * is phrase-eligible only when every adjacent pair of the quoted phrase is
 * present — so docs that merely contain the tokens non-contiguously are
 * excluded without any transcript read. Phase 2 reads phrase-eligible docs
 * in score order to confirm true contiguity (bigram chains are necessary,
 * not sufficient) and score the phrase bonus, stopping only once no unread
 * candidate could beat the kept results — this scan is never cut off by a
 * blind read cap, so a false-positive bigram chain ranked ahead of a true
 * exact-phrase match can never hide that match from Phase 2. Bare-term-only
 * candidates carry no such correctness risk (their score is already final)
 * and keep a flat MAX_CANDIDATES budget. Anything left unread is reported
 * via `droppedCandidates` rather than silently ignored. The index stores
 * term frequencies and one-way bigram hashes only — never prose, never
 * positional data.
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
  /** Unique FNV-1a hashes of each adjacent token pair — phrase-contiguity fingerprints, not recoverable prose. */
  bigrams: string[];
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

/** Build a document's term-frequency + bigram-fingerprint record from its transcript text. Pure. */
export function buildDocument(uuid: string, contentHash: string, text: string): IndexedDocument {
  const tokens = tokenize(text);
  const termFreq: Record<string, number> = {};
  for (const token of tokens) termFreq[token] = (termFreq[token] ?? 0) + 1;
  const bigrams = new Set<string>();
  for (let i = 0; i + 1 < tokens.length; i++) bigrams.add(hashBigram(tokens[i], tokens[i + 1]));
  return { uuid, contentHash, length: tokens.length, termFreq, bigrams: Array.from(bigrams) };
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
/**
 * Bounds how many bare-term (non-phrase) candidate transcripts Phase 2
 * reads per search. Phrase-eligible candidates are bounded by score
 * dominance instead of this flat cap, so a false-positive bigram chain can
 * never rank ahead of and hide a true exact-phrase match.
 */
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
      // Schema check alongside contentHash: docs persisted before bigram
      // fingerprints existed rebuild themselves on the next search.
      if (current && current.contentHash === entry.contentHash && Array.isArray(current.bigrams)) {
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
    const limit = clampLimit(opts.limit);

    // Phrase-eligible docs are selected from the index alone: every phrase
    // token present AND every adjacent phrase pair's bigram fingerprint
    // present, so docs holding the tokens only non-contiguously never enter
    // this loop (they fall through to the capped bare-term pass with their
    // keyword-only score). Eligible docs are read in keyword-score order to
    // confirm true contiguity and add the phrase bonus. Bigram-chain
    // eligibility is necessary but not sufficient for an exact match, so this
    // read loop has no blind candidate cap — only the score-dominance check
    // below can stop it — otherwise enough false-positive bigram chains
    // could rank ahead of a true match and consume a fixed budget before it
    // is ever read. Anything unread past that point is counted in
    // `droppedCandidates` and surfaced to the caller.
    const phraseEligibleUuids = new Set(
      docs
        .filter((doc) => query.phrases.some((phrase) => phraseEligible(doc, phrase)))
        .map((doc) => doc.uuid),
    );
    const rankedPhraseEligible = Array.from(phraseEligibleUuids).sort(
      (a, b) => (keywordScores.get(b) ?? 0) - (keywordScores.get(a) ?? 0),
    );
    const maxPhraseBonus = query.phrases.reduce(
      (sum, phrase) => (phrase.length > 0 ? sum + phrase.length * PHRASE_BONUS_WEIGHT : sum),
      0,
    );

    const scored: Array<{ uuid: string; score: number; text: string }> = [];
    let phraseCandidatesRead = 0;
    for (const uuid of rankedPhraseEligible) {
      if (scored.length >= limit) {
        const weakestKept = scored[scored.length - 1].score;
        const bestPossibleRemaining = (keywordScores.get(uuid) ?? 0) + maxPhraseBonus;
        if (bestPossibleRemaining <= weakestKept) break;
      }
      const entry = byUuid.get(uuid);
      if (!entry) continue;
      const text = await entry.readText();
      phraseCandidatesRead++;
      const bonus = phraseBonus(query.phrases, tokenize(text));
      const score = (keywordScores.get(uuid) ?? 0) + bonus;
      if (score > 0) {
        scored.push({ uuid, score, text });
        scored.sort((a, b) => b.score - a.score);
        if (scored.length > limit) scored.length = limit;
      }
    }

    // Bare-term-only candidates need no verification — their keyword score
    // is already final — so they keep their own flat MAX_CANDIDATES read
    // budget regardless of how many phrase-eligible docs were scanned above.
    const bareTermUuids = candidateUuids
      .filter((uuid) => !phraseEligibleUuids.has(uuid))
      .sort((a, b) => (keywordScores.get(b) ?? 0) - (keywordScores.get(a) ?? 0));
    const cappedBareTerm = bareTermUuids.slice(0, MAX_CANDIDATES);
    const droppedCandidates =
      (rankedPhraseEligible.length - phraseCandidatesRead) + (bareTermUuids.length - cappedBareTerm.length);

    for (const uuid of cappedBareTerm) {
      const entry = byUuid.get(uuid);
      if (!entry) continue;
      const text = await entry.readText();
      const score = keywordScores.get(uuid) ?? 0;
      if (score > 0) scored.push({ uuid, score, text });
    }

    scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.uuid.localeCompare(b.uuid)));

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
