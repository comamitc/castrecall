/**
 * Search over the private transcript corpus. Two layers, mirroring
 * corpus-export.ts (pure builders) + storage.ts (IO): pure tokenize/parse/
 * score/snippet functions below, `SearchIndex` for the on-disk cache.
 *
 * Two-phase scoring, with ranking settled entirely from the index. Phase 1
 * scores every doc (tf-length-normalized + idf-lite over term frequencies)
 * and resolves quoted-phrase bonuses from indexed positional postings:
 * sorted token positions keyed by a one-way hash of each term, so exact
 * contiguity is confirmed by walking the rarest phrase term's positions
 * with binary searches — work proportional to that term's frequency, not
 * to document length, and never a transcript read. Ranking is therefore
 * complete over every candidate before any IO: an exact phrase match can
 * never be hidden behind higher-scoring false positives, and no query
 * shape triggers corpus-wide transcript scans. Phase 2 reads only the
 * final top `limit` docs to build snippets. The index stores plaintext
 * vocabulary (termFreq — inherent to keyword scoring) but never the word
 * sequence: positions are keyed by one-way term hashes, so the index is no
 * more revealing than the transcript files it sits beside, and all of it
 * is rebuilt from them on contentHash or schema change.
 */

import { createHash, randomUUID } from "node:crypto";
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
  /**
   * Sorted token positions keyed by a 64-bit one-way hash of each term.
   * Lets a quoted phrase's exact contiguity be confirmed from the index
   * alone — no transcript read — without persisting the plaintext word
   * sequence.
   */
  postings: Record<string, number[]>;
};

/** Bumped whenever the persisted document shape changes; older indexes rebuild wholesale. */
export const INDEX_SCHEMA_VERSION = 1;

/**
 * Structural validation for a persisted document: every term in `termFreq`
 * must map (via its term hash) to a strictly ascending array of that many
 * integer positions in `[0, length)`, with no extra postings keys. Anything
 * else — a torn write, disk corruption, an index produced by an
 * incompatible build under the same schemaVersion — is treated as absent so
 * reconcile rebuilds it, rather than letting `phraseConfirmed` throw or
 * silently miss exact matches.
 */
export function isValidIndexedDocument(doc: unknown): doc is IndexedDocument {
  if (typeof doc !== "object" || doc === null) return false;
  const candidate = doc as Partial<IndexedDocument>;
  if (typeof candidate.uuid !== "string" || typeof candidate.contentHash !== "string") return false;
  if (typeof candidate.length !== "number" || !Number.isInteger(candidate.length) || candidate.length < 0) {
    return false;
  }
  if (typeof candidate.termFreq !== "object" || candidate.termFreq === null) return false;
  if (typeof candidate.postings !== "object" || candidate.postings === null) return false;
  const terms = Object.keys(candidate.termFreq);
  if (Object.keys(candidate.postings).length !== terms.length) return false;
  for (const term of terms) {
    const expectedCount = candidate.termFreq[term];
    if (typeof expectedCount !== "number" || !Number.isInteger(expectedCount) || expectedCount <= 0) {
      return false;
    }
    const positions = candidate.postings[hashTerm(term)];
    if (!Array.isArray(positions) || positions.length !== expectedCount) return false;
    let previous = -1;
    for (const position of positions) {
      if (typeof position !== "number" || !Number.isInteger(position)) return false;
      if (position <= previous || position >= candidate.length) return false;
      previous = position;
    }
  }
  return true;
}

/**
 * One-way 64-bit hash of a term, keying its positional postings. Truncated
 * SHA-256 digest: unlike two concatenated FNV-1a passes (whose halves are
 * not independent — an FNV collision on `term` also collides on any shared
 * suffix), a cryptographic digest gives a genuine 64 bits of collision
 * resistance, so accidental collisions that would merge two terms'
 * postings and fake a contiguity check are negligible.
 */
export function hashTerm(term: string): string {
  return createHash("sha256").update(term, "utf8").digest("hex").slice(0, 16);
}

/** Build a document's term-frequency + positional-postings record from its transcript text. Pure. */
export function buildDocument(uuid: string, contentHash: string, text: string): IndexedDocument {
  const tokens = tokenize(text);
  const termFreq: Record<string, number> = {};
  const postings: Record<string, number[]> = {};
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    termFreq[token] = (termFreq[token] ?? 0) + 1;
    (postings[hashTerm(token)] ??= []).push(i);
  }
  return { uuid, contentHash, length: tokens.length, termFreq, postings };
}

function includesSorted(sorted: number[], value: number): boolean {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] === value) return true;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/**
 * Exact, index-only contiguity check: the phrase matches iff some start
 * index has every phrase token at consecutive positions. Walks the RAREST
 * phrase term's postings and binary-searches the others, so the work is
 * proportional to that term's frequency (times log of the others'), never
 * to document length — no transcript read, no per-doc allocation.
 */
export function phraseConfirmed(doc: IndexedDocument, phrase: string[]): boolean {
  if (phrase.length === 0) return false;
  const lists: number[][] = [];
  for (const term of phrase) {
    const positions = doc.postings[hashTerm(term)];
    if (!positions || positions.length === 0) return false;
    lists.push(positions);
  }
  if (phrase.length === 1) return true;
  let rarest = 0;
  for (let j = 1; j < lists.length; j++) {
    if (lists[j].length < lists[rarest].length) rarest = j;
  }
  outer: for (const position of lists[rarest]) {
    const start = position - rarest;
    if (start < 0 || start + phrase.length > doc.length) continue;
    for (let j = 0; j < phrase.length; j++) {
      if (j === rarest) continue;
      if (!includesSorted(lists[j], start + j)) continue outer;
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
      const parsed = JSON.parse(raw) as { schemaVersion?: number; docs?: IndexedDocument[] };
      // Version gate: anything not written by exactly this schema —
      // including the pre-postings formats — is discarded wholesale and
      // rebuilt from the transcripts.
      if (parsed.schemaVersion !== INDEX_SCHEMA_VERSION || !Array.isArray(parsed.docs)) return [];
      // Structural gate: a doc written under the right version can still
      // be malformed (torn write, disk corruption, hand edit). Dropping it
      // here marks it changed in reconcile, so it self-heals instead of
      // making phraseConfirmed throw or silently miss.
      return parsed.docs.filter(isValidIndexedDocument);
    } catch {
      return [];
    }
  }

  private async persist(docs: IndexedDocument[]): Promise<void> {
    await fs.mkdir(this.indexDir, { recursive: true });
    // Unique per attempt so concurrent searches reconciling the same index
    // don't share (and race on) a single fixed temp path.
    const tmpPath = `${this.indexPath}.${randomUUID()}.tmp`;
    await fs.writeFile(
      tmpPath,
      `${JSON.stringify({ schemaVersion: INDEX_SCHEMA_VERSION, docs }, null, 2)}\n`,
      "utf8",
    );
    await fs.rename(tmpPath, this.indexPath);
  }

  private async reconcile(corpus: CorpusEntry[]): Promise<IndexedDocument[]> {
    const existing = await this.load();
    const byUuid = new Map(existing.map((doc) => [doc.uuid, doc]));
    const reconciled: IndexedDocument[] = [];
    let changed = corpus.length !== existing.length;
    for (const entry of corpus) {
      const current = byUuid.get(entry.uuid);
      // load() already discarded wrong-version and structurally invalid
      // docs, so contentHash equality is the only per-doc freshness check
      // left.
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
  ): Promise<{ hits: SearchHit[] }> {
    const query = parseQuery(rawQuery);
    const byUuid = new Map(corpus.map((entry) => [entry.uuid, entry]));
    const docs = await this.reconcile(corpus);

    const candidateUuids = selectCandidates(query, docs);
    const keywordScores = scoreKeywords(query, docs);
    const limit = clampLimit(opts.limit);

    // Every candidate's final score — keyword score plus phrase bonuses —
    // is computed from the index alone: positional postings confirm exact
    // contiguity in work proportional to the rarest phrase term's
    // frequency, not document length. No transcript is read to rank, so
    // ranking is complete over ALL candidates: an exact phrase match can
    // never be hidden behind higher-scoring false positives, and no query
    // shape — however broad — triggers corpus-wide transcript IO or
    // per-document scans.
    const docByUuid = new Map(docs.map((doc) => [doc.uuid, doc]));
    const ranked = candidateUuids
      .map((uuid) => {
        const doc = docByUuid.get(uuid);
        let bonus = 0;
        if (doc) {
          for (const phrase of query.phrases) {
            if (phrase.length > 0 && phraseConfirmed(doc, phrase)) {
              bonus += phrase.length * PHRASE_BONUS_WEIGHT;
            }
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
