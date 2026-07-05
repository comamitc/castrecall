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
export type CorpusPage = {
    relativePath: string;
    content: string;
};
/** Kebab-case slug; never empty — falls back when the input has no alphanumerics. */
export declare function slugify(value: string, fallback: string): string;
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
}): CorpusPage[];
export type ExportResult = {
    exported: number;
    skipped: boolean;
    dir: string;
};
/**
 * Publishes corpus pages under `<exportDir>/podcasts/<show-slug>/<episode-slug>/`.
 * Idempotent by content hash: an unchanged episode re-exports nothing. A
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
    }): Promise<ExportResult>;
}
