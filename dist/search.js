/**
 * Search over the private transcript corpus. Two layers, mirroring
 * corpus-export.ts (pure builders) + storage.ts (IO): pure tokenize/parse/
 * score/snippet functions below, `SearchIndex` for the on-disk cache.
 *
 * Two-phase scoring: Phase 1 scores every doc from a persisted term-frequency
 * index (tf-length-normalized + idf-lite) and selects a candidate set — docs
 * matching any bare term, plus docs containing every token of a quoted
 * phrase — then ranks phrase-eligible and bare-term candidates by score and
 * caps both to MAX_CANDIDATES total, so a broad phrase can't force an
 * unbounded Phase 2 scan. Phase 2 re-reads only the capped candidate set's
 * transcript text, applies an exact contiguous-phrase bonus, and builds
 * snippets. The index therefore stores term frequencies only — never prose,
 * never positional data.
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
const WORD_PATTERN = /[\p{L}\p{N}]+/gu;
function normalizeToken(raw) {
    return raw.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
/** Unicode-safe tokenization: NFKD + combining-mark strip + lowercase, split on letters/numbers. */
export function tokenize(text) {
    const tokens = [];
    for (const match of text.matchAll(WORD_PATTERN)) {
        const value = normalizeToken(match[0]);
        if (value)
            tokens.push(value);
    }
    return tokens;
}
function tokenizeWithSpans(text) {
    const spans = [];
    for (const match of text.matchAll(WORD_PATTERN)) {
        const value = normalizeToken(match[0]);
        if (value)
            spans.push({ value, start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
    }
    return spans;
}
/** Extract `"quoted phrases"` (as token arrays) from bare terms. Unbalanced quotes fall through to tokenize() as literal terms. */
export function parseQuery(raw) {
    const phrases = [];
    let remainder = "";
    let last = 0;
    const phrasePattern = /"([^"]*)"/g;
    for (const match of raw.matchAll(phrasePattern)) {
        remainder += raw.slice(last, match.index ?? 0);
        const phraseTokens = tokenize(match[1]);
        if (phraseTokens.length > 0)
            phrases.push(phraseTokens);
        last = (match.index ?? 0) + match[0].length;
    }
    remainder += raw.slice(last);
    return { terms: tokenize(remainder), phrases };
}
/** Build a document's term-frequency record from its transcript text. Pure. */
export function buildDocument(uuid, contentHash, text) {
    const tokens = tokenize(text);
    const termFreq = {};
    for (const token of tokens)
        termFreq[token] = (termFreq[token] ?? 0) + 1;
    return { uuid, contentHash, length: tokens.length, termFreq };
}
/**
 * Candidate uuids: docs matching any bare keyword term, union docs
 * containing every token of any quoted phrase (phrase-eligible docs are
 * always retained, since a doc with the exact phrase necessarily contains
 * every phrase token).
 */
export function selectCandidates(query, docs) {
    const uuids = [];
    for (const doc of docs) {
        const hasTerm = query.terms.some((term) => (doc.termFreq[term] ?? 0) > 0);
        const hasPhrase = query.phrases.some((phrase) => phrase.length > 0 && phrase.every((term) => (doc.termFreq[term] ?? 0) > 0));
        if (hasTerm || hasPhrase)
            uuids.push(doc.uuid);
    }
    return uuids;
}
/**
 * tf-length-normalized + idf-lite keyword score across bare terms and quoted
 * phrase tokens (so a phrase-only query still scores its candidates before
 * the Phase 2 contiguity bonus is added).
 */
export function scoreKeywords(query, docs) {
    const allTerms = Array.from(new Set([...query.terms, ...query.phrases.flat()]));
    const scores = new Map();
    if (allTerms.length === 0) {
        for (const doc of docs)
            scores.set(doc.uuid, 0);
        return scores;
    }
    const totalDocs = docs.length;
    const idf = new Map();
    for (const term of allTerms) {
        const df = docs.reduce((count, doc) => count + ((doc.termFreq[term] ?? 0) > 0 ? 1 : 0), 0);
        idf.set(term, Math.log(1 + totalDocs / Math.max(df, 1)));
    }
    for (const doc of docs) {
        let score = 0;
        for (const term of allTerms) {
            const tf = doc.termFreq[term] ?? 0;
            if (tf === 0)
                continue;
            score += (tf / Math.max(doc.length, 1)) * (idf.get(term) ?? 0);
        }
        scores.set(doc.uuid, score);
    }
    return scores;
}
const PHRASE_BONUS_WEIGHT = 10;
/** Additive bonus for each quoted phrase whose tokens appear contiguously in `docTokens`. */
export function phraseBonus(phrases, docTokens) {
    let bonus = 0;
    for (const phrase of phrases) {
        if (phrase.length > 0 && containsContiguous(docTokens, phrase)) {
            bonus += phrase.length * PHRASE_BONUS_WEIGHT;
        }
    }
    return bonus;
}
function containsContiguous(tokens, phrase) {
    outer: for (let i = 0; i <= tokens.length - phrase.length; i++) {
        for (let j = 0; j < phrase.length; j++) {
            if (tokens[i + j] !== phrase[j])
                continue outer;
        }
        return true;
    }
    return false;
}
const DEFAULT_SNIPPET_RADIUS = 160;
/**
 * A display-formatted, highlighted window around the best match (`snippet`)
 * plus the exact verbatim slice it was built from (`snippetText`), so quoted
 * material always stays attributable to the transcript, not to a mutated
 * string.
 */
export function buildSnippet(text, query, opts = {}) {
    const radius = opts.radius ?? DEFAULT_SNIPPET_RADIUS;
    const spans = tokenizeWithSpans(text);
    const matchTerms = new Set([...query.terms, ...query.phrases.flat()]);
    let anchorStart = 0;
    let anchorEnd = 0;
    phraseSearch: for (const phrase of query.phrases) {
        if (phrase.length === 0)
            continue;
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
export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 25;
/** Bounds how many candidate transcripts Phase 2 reads for phrase/snippet scoring per search. */
export const MAX_CANDIDATES = 50;
/** `limit && limit > 0 ? … : default` — same guard idiom as tools.ts's listRecent — plus a hard max cap. */
export function clampLimit(limit) {
    if (!limit || limit <= 0)
        return DEFAULT_SEARCH_LIMIT;
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
    indexDir;
    constructor(indexDir) {
        this.indexDir = indexDir;
    }
    get indexPath() {
        return path.join(this.indexDir, "search-index.json");
    }
    async load() {
        try {
            const raw = await fs.readFile(this.indexPath, "utf8");
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed.docs) ? parsed.docs : [];
        }
        catch {
            return [];
        }
    }
    async persist(docs) {
        await fs.mkdir(this.indexDir, { recursive: true });
        // Unique per attempt so concurrent searches reconciling the same index
        // don't share (and race on) a single fixed temp path.
        const tmpPath = `${this.indexPath}.${randomUUID()}.tmp`;
        await fs.writeFile(tmpPath, `${JSON.stringify({ docs }, null, 2)}\n`, "utf8");
        await fs.rename(tmpPath, this.indexPath);
    }
    async reconcile(corpus) {
        const existing = await this.load();
        const byUuid = new Map(existing.map((doc) => [doc.uuid, doc]));
        const reconciled = [];
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
        if (changed)
            await this.persist(reconciled);
        return reconciled;
    }
    /**
     * Search the given corpus. `corpus` is the tool layer's authoritative view
     * of stored transcripts — the index never looks anything up itself.
     */
    async search(rawQuery, opts, corpus) {
        const query = parseQuery(rawQuery);
        const byUuid = new Map(corpus.map((entry) => [entry.uuid, entry]));
        const docs = await this.reconcile(corpus);
        const candidateUuids = selectCandidates(query, docs);
        const keywordScores = scoreKeywords(query, docs);
        // Phrase-eligible docs (containing every token of a quoted phrase) are
        // prioritized over bare-term matches, since only Phase 2 can confirm the
        // exact contiguous match — but they are still ranked by keyword score and
        // subject to the same MAX_CANDIDATES read budget as bare terms, so a broad
        // phrase (e.g. common words) cannot force an unbounded Phase 2 scan.
        const phraseEligibleUuids = new Set(docs
            .filter((doc) => query.phrases.some((phrase) => phrase.length > 0 && phrase.every((term) => (doc.termFreq[term] ?? 0) > 0)))
            .map((doc) => doc.uuid));
        const rankedPhraseEligible = Array.from(phraseEligibleUuids).sort((a, b) => (keywordScores.get(b) ?? 0) - (keywordScores.get(a) ?? 0));
        const cappedPhraseEligible = rankedPhraseEligible.slice(0, MAX_CANDIDATES);
        const bareTermUuids = candidateUuids
            .filter((uuid) => !phraseEligibleUuids.has(uuid))
            .sort((a, b) => (keywordScores.get(b) ?? 0) - (keywordScores.get(a) ?? 0));
        const remainingBudget = Math.max(0, MAX_CANDIDATES - cappedPhraseEligible.length);
        const cappedCandidates = [...cappedPhraseEligible, ...bareTermUuids.slice(0, remainingBudget)];
        const droppedCandidates = candidateUuids.length - cappedCandidates.length;
        const scored = [];
        for (const uuid of cappedCandidates) {
            const entry = byUuid.get(uuid);
            if (!entry)
                continue;
            const text = await entry.readText();
            const bonus = phraseBonus(query.phrases, tokenize(text));
            const score = (keywordScores.get(uuid) ?? 0) + bonus;
            if (score > 0)
                scored.push({ uuid, score, text });
        }
        scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.uuid.localeCompare(b.uuid)));
        const limit = clampLimit(opts.limit);
        const hits = [];
        for (const item of scored.slice(0, limit)) {
            const entry = byUuid.get(item.uuid);
            if (!entry)
                continue;
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
