/**
 * Search over the private transcript corpus. Two layers, mirroring
 * corpus-export.ts (pure builders) + storage.ts (IO): pure tokenize/parse/
 * score/snippet functions below, `SearchIndex` for the on-disk cache.
 *
 * Two-phase scoring: Phase 1 scores every doc from a persisted term-frequency
 * index (tf-length-normalized + idf-lite) and selects a candidate set — docs
 * matching any bare term, plus docs containing every token of a quoted
 * phrase. Bare-term candidates need no verification, so they're capped at
 * MAX_CANDIDATES by score. Phrase-eligible candidates can only be confirmed
 * as an exact contiguous match by reading their text, so instead of a blind
 * pre-verification cap, Phase 2 scans them in score order and keeps reading
 * past MAX_CANDIDATES whenever an unread candidate could still outscore the
 * current top results even with the maximum possible phrase bonus — so a
 * genuine exact-phrase match is never dropped just because higher-scoring
 * non-contiguous matches outnumber it. The index therefore stores term
 * frequencies only — never prose, never positional data.
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
};
/** Build a document's term-frequency record from its transcript text. Pure. */
export declare function buildDocument(uuid: string, contentHash: string, text: string): IndexedDocument;
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
/** Bounds how many candidate transcripts Phase 2 reads for phrase/snippet scoring per search. */
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
