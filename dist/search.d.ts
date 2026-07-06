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
import type { Provenance } from "./storage.js";
/** Unicode-safe tokenization: NFKD + combining-mark strip + lowercase, split on letters/numbers. */
export declare function tokenize(text: string): string[];
export type ParsedQuery = {
    terms: string[];
    phrases: string[][];
};
/** Extract `"quoted phrases"` (as token arrays) from bare terms. Unbalanced quotes fall through to tokenize() as literal terms. */
export declare function parseQuery(raw: string): ParsedQuery;
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
/**
 * One-way 64-bit hash of a term, keying its positional postings. Two
 * independent 32-bit FNV-1a passes are concatenated so accidental
 * collisions (which would merge two terms' postings and could fake a
 * contiguity check) are negligible.
 */
export declare function hashTerm(term: string): string;
/** Build a document's term-frequency + positional-postings record from its transcript text. Pure. */
export declare function buildDocument(uuid: string, contentHash: string, text: string): IndexedDocument;
/**
 * Exact, index-only contiguity check: the phrase matches iff some start
 * index has every phrase token at consecutive positions. Walks the RAREST
 * phrase term's postings and binary-searches the others, so the work is
 * proportional to that term's frequency (times log of the others'), never
 * to document length — no transcript read, no per-doc allocation.
 */
export declare function phraseConfirmed(doc: IndexedDocument, phrase: string[]): boolean;
/**
 * Candidate uuids: docs matching any bare keyword term, union docs
 * containing every token of any quoted phrase (phrase-eligible docs are
 * always retained, since a doc with the exact phrase necessarily contains
 * every phrase token).
 */
export declare function selectCandidates(query: ParsedQuery, docs: IndexedDocument[]): string[];
/**
 * tf-length-normalized + idf-lite keyword score across bare terms and quoted
 * phrase tokens (so a phrase-only query still scores its candidates before
 * the Phase 2 contiguity bonus is added).
 */
export declare function scoreKeywords(query: ParsedQuery, docs: IndexedDocument[]): Map<string, number>;
/** Additive bonus for each quoted phrase whose tokens appear contiguously in `docTokens`. */
export declare function phraseBonus(phrases: string[][], docTokens: string[]): number;
export type Snippet = {
    snippet: string;
    snippetText: string;
    offset: number;
};
/**
 * A display-formatted, highlighted window around the best match (`snippet`)
 * plus the exact verbatim slice it was built from (`snippetText`), so quoted
 * material always stays attributable to the transcript, not to a mutated
 * string.
 */
export declare function buildSnippet(text: string, query: ParsedQuery, opts?: {
    radius?: number;
}): Snippet;
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
export type SearchOptions = {
    limit?: number;
};
export declare const DEFAULT_SEARCH_LIMIT = 10;
export declare const MAX_SEARCH_LIMIT = 25;
/** `limit && limit > 0 ? … : default` — same guard idiom as tools.ts's listRecent — plus a hard max cap. */
export declare function clampLimit(limit: number | undefined): number;
/**
 * Persisted, rebuildable term-frequency cache under `<dataDir>/.index/`.
 * Reconciled by contentHash on every search: an unchanged corpus re-
 * tokenizes nothing, a corrupt/missing index self-heals via full rescan
 * (same tolerant idiom as `Storage.loadState`), written via tmp+rename (same
 * idiom as `Storage.saveState`).
 */
export declare class SearchIndex {
    private readonly indexDir;
    constructor(indexDir: string);
    private get indexPath();
    private load;
    private persist;
    private reconcile;
    /**
     * Search the given corpus. `corpus` is the tool layer's authoritative view
     * of stored transcripts — the index never looks anything up itself.
     */
    search(rawQuery: string, opts: SearchOptions, corpus: CorpusEntry[]): Promise<{
        hits: SearchHit[];
    }>;
}
