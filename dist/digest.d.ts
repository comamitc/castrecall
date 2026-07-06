/**
 * Cross-episode digest generation.
 *
 * The per-episode analogue is review.ts: a heuristic document a human (or
 * human-approved agent flow) decides what to keep from. A digest is the
 * aggregate view across many episodes in a time window — counts, term
 * frequencies, and verbatim excerpts, never synthesized themes. "What have I
 * been absorbing lately, and how is it shaping my thinking?" is exactly the
 * kind of semantic synthesis this module must NOT attempt — it belongs to
 * the reviewing agent, per the same honesty contract as review.ts.
 */
import type { ListenRecord } from "./storage.js";
export declare const MAX_TOPICS = 15;
export declare const MAX_DIGEST_EXCERPTS = 8;
export type DigestEpisodeInput = {
    record: ListenRecord;
    /** Transcript text, when the episode's transcript was successfully read. Absent for listened-but-not-transcribed episodes. */
    transcriptText?: string;
};
export type DigestSummary = {
    episodes: number;
    shows: number;
    transcribed: number;
    window: {
        days: number;
        start: string;
        end: string;
    };
};
export type TopicCount = {
    term: string;
    count: number;
};
export type NotableExcerpt = {
    podcast: string;
    episode: string;
    excerpt: string;
};
export type ListeningPattern = {
    totalEpisodes: number;
    showCount: number;
    transcribedCount: number;
    sourceBreakdown: Record<string, number>;
    showBreakdown: Array<{
        show: string;
        count: number;
    }>;
};
/** Term-frequency topics across every transcribed episode's text, excluding stopwords. Pure, deterministic ordering. */
export declare function recurringTopics(transcripts: string[]): TopicCount[];
/**
 * The single most substantial pickExcerpts() candidate per transcribed
 * episode, ranked across the whole window by length and capped at
 * MAX_DIGEST_EXCERPTS, then restored to listen order for a coherent read.
 */
export declare function notableExcerpts(episodes: DigestEpisodeInput[]): NotableExcerpt[];
/** Counts and breakdowns over every in-window episode, transcribed or not. */
export declare function listeningPattern(episodes: DigestEpisodeInput[]): ListeningPattern;
export declare function buildDigest(options: {
    episodes: DigestEpisodeInput[];
    days: number;
    windowStart: Date;
    windowEnd: Date;
    generatedAt: Date;
}): {
    markdown: string;
    summary: DigestSummary;
};
