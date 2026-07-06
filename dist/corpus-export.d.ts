/**
 * Corpus export: opt-in projection of stored transcripts into section-split,
 * frontmattered markdown pages for markdown-native "brains" (gbrain, Obsidian
 * vaults, custom LSD/brainstorm corpora).
 *
 * This is a read-only projection of the private source layer (transcript.txt
 * + provenance.json), never of review candidates or state — see
 * docs/ARCHITECTURE.md. Two layers, mirroring review.ts (pure) + storage.ts
 * (IO): pure builders below, `CorpusExporter` for the filesystem side.
 */
import type { ListenRecord, Provenance } from "./storage.js";
import type { TranscriptSegment } from "./transcripts/normalize.js";
type Range = {
    start: number;
    end: number;
};
export type CorpusPage = {
    relativePath: string;
    content: string;
};
/** Kebab-case slug; never empty — falls back when the input has no alphanumerics. */
export declare function slugify(value: string, fallback: string): string;
/**
 * Split transcript text into ordered, non-overlapping section ranges of
 * roughly `targetWords` words, never exceeding `maxWords`. The pure range
 * computation behind `splitSections` — exposed separately so callers that
 * need section boundaries (e.g. mapping segment timestamps onto sections)
 * don't have to re-derive them from slice content.
 */
export declare function splitSectionRanges(text: string, options?: {
    targetWords?: number;
    maxWords?: number;
}): Range[];
/**
 * Split transcript text into ordered, verbatim sections of roughly
 * `targetWords` words, never exceeding `maxWords`. Sections are exact
 * contiguous slices of the source text — never rewritten or whitespace-
 * collapsed — so gbrain and similar consumers see the transcript as-fetched.
 */
export declare function splitSections(text: string, options?: {
    targetWords?: number;
    maxWords?: number;
}): string[];
/** Format seconds as `HH:MM:SS` (supports durations of an hour or more). */
export declare function formatTimecode(seconds: number): string;
export type SectionTiming = {
    approxStart?: number;
    approxEnd?: number;
};
/**
 * Map each section range onto an approximate `{ approxStart, approxEnd }` in
 * seconds, by proportionally scaling the range's position in `text` onto the
 * segment timeline built from `segments`. This is inherently approximate:
 * `text` is the deduped/whitespace-collapsed transcript (see `joinSegments`),
 * so character offsets don't line up exactly with segment boundaries.
 *
 * Contract: never returns `NaN`. Returns all-`undefined` entries when there
 * is no usable timing signal at all (empty text, no ranges, or no segment
 * carries numeric times). Emitted times are non-decreasing across ordered
 * sections, and within a section `approxEnd >= approxStart` whenever both are
 * defined.
 */
export declare function sectionTimestamps(segments: TranscriptSegment[] | undefined, ranges: Range[], textLength: number): SectionTiming[];
/**
 * Build the full set of markdown pages for one episode: one page per
 * transcript section plus an episode index page. Pure — no filesystem
 * access; `CorpusExporter` handles publishing these to disk.
 */
export declare function buildCorpusPages(options: {
    record: ListenRecord;
    provenance: Provenance;
    text: string;
    contentHash: string;
    targetWords?: number;
    maxWords?: number;
    /** Normalized transcript segments (issue #43) — when present, section/index pages get approximate timestamps. */
    segments?: TranscriptSegment[];
}): CorpusPage[];
export type ExportResult = {
    exported: number;
    skipped: boolean;
    dir: string;
};
/**
 * Publishes corpus pages under `<exportDir>/podcasts/<show-slug>/<episode-slug>/`.
 * Idempotent by content hash: an unchanged episode re-exports nothing, unless
 * provenance now carries quality scoring (issue #41) that the existing export
 * lacks or disagrees with — that forces a re-export so upgraded installs
 * backfill the new frontmatter, and later rescoring (e.g. a corrected
 * timestamp/speaker-coverage rule) doesn't leave stale score/tier/reasons
 * behind, instead of staying stale until the transcript text changes. A
 * changed hash replaces the whole episode directory so no stale section
 * files from a previous, longer transcript survive.
 */
export declare class CorpusExporter {
    private readonly exportDir;
    constructor(exportDir: string);
    exportEpisode(options: {
        record: ListenRecord;
        provenance: Provenance;
        text: string;
        contentHash: string;
        targetWords?: number;
        maxWords?: number;
        /** Normalized transcript segments (issue #43), read from the storage sidecar — see readSegments. */
        segments?: TranscriptSegment[];
    }): Promise<ExportResult>;
}
export {};
