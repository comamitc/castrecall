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
/** One-way fingerprint of an adjacent token pair. ` ` separator keeps ("ab","c") ≠ ("a","bc"). */
export declare function hashBigram(first: string, second: string): string;
/**
 * One-way 64-bit fingerprint of a token occurrence at a token index. Two
 * independent 32-bit FNV-1a passes are concatenated so accidental
 * collisions (which would fake a contiguity probe) are negligible even
 * across hour-long transcripts.
 */
export declare function hashOccurrence(term: string, position: number): string;
/** Build a document's term-frequency + fingerprint record from its transcript text. Pure. */
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
 * Exact, index-only contiguity check: the phrase matches iff some start
 * index has every phrase token's occurrence fingerprint at consecutive
 * positions. Settles what `phraseEligible`'s bigram chains can only
 * approximate (e.g. "a b … b c" passes the chain without containing
 * "a b c"), still without reading any transcript. Pass a prebuilt
 * `occurrences` set when probing several phrases against one doc.
 */
export declare function phraseConfirmed(doc: IndexedDocument, phrase: string[], occurrences?: Set<string>): boolean;
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
