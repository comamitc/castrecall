/**
 * Review candidate generation.
 *
 * CastRecall never promotes transcripts into durable memory itself. Instead it
 * writes a pending review document per episode: listen metadata, provenance,
 * and heuristic excerpt candidates. A human (or a human-approved agent flow)
 * decides what — if anything — graduates into curated memory.
 */
import { type ListenRecord, type Provenance } from "./storage.js";
export declare function buildReviewCandidate(options: {
    record: ListenRecord;
    provenance: Provenance;
    transcriptText: string;
    transcriptPath: string;
    generatedAt: Date;
}): string;
/**
 * Render a human-chosen promotion into a frontmattered note for the
 * configured notes destination. The body is exactly the human's `content` —
 * no heuristic excerpts, no full transcript — but attribution (podcast,
 * episode, listen date, transcript source, episode UUID) travels with it so
 * a promoted note is still traceable back to its source.
 */
export declare function buildPromotedNote(options: {
    record: ListenRecord;
    provenance: Provenance;
    content: string;
    title?: string;
    resolvedAt: Date;
}): string;
/**
 * Heuristic excerpt selection: split into paragraph-ish chunks, keep the
 * most substantial ones in original order. Deliberately simple and honest —
 * semantic summarization belongs to the reviewing agent/human, not this plugin.
 */
export declare function pickExcerpts(text: string): string[];
export declare function yamlString(value: string): string;
