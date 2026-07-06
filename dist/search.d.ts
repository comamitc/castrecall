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
    /** Unique FNV-1a hashes of each adjacent token pair — phrase-contiguity fingerprints, not recoverable prose. */
    bigrams: string[];
};
/** One-way fingerprint of an adjacent token pair. ` ` separator keeps ("ab","c") ≠ ("a","bc"). */
export declare function hashBigram(first: string, second: string): string;
/** Build a document's term-frequency + bigram-fingerprint record from its transcript text. Pure. */
export declare function buildDocument(uuid: string, contentHash: string, text: string): IndexedDocument;
/**
 * Index-only phrase eligibility: every phrase token present AND every
 * adjacent phrase pair's bigram fingerprint present. Necessary but not
 * sufficient for a contiguous match (e.g. "a b … b c" carries both "a b"
 * and "b c" without "a b c"), so Phase 2 still verifies by reading — but
 * docs holding the tokens only non-contiguously are excluded up front,
 * without transcript IO.
 */
export declare function phraseEligible(doc: IndexedDocument, phrase: string[]): boolean;
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
/**
 * Bounds how many bare-term (non-phrase) candidate transcripts Phase 2
 * reads per search. Phrase-eligible candidates are bounded by score
 * dominance instead of this flat cap, so a false-positive bigram chain can
 * never rank ahead of and hide a true exact-phrase match.
 */
export declare const MAX_CANDIDATES = 50;
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
        droppedCandidates: number;
    }>;
}
