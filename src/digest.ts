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

import { pickExcerpts, yamlString } from "./review.js";
import { tokenize } from "./search.js";
import type { ListenRecord } from "./storage.js";

export const MAX_TOPICS = 15;
export const MAX_DIGEST_EXCERPTS = 8;
const MIN_TOPIC_LENGTH = 3;

/** Small, deliberately minimal stopword list — enough to keep function words out of a term-frequency topic list. */
const STOPWORDS = new Set([
  "the", "and", "a", "an", "to", "of", "in", "on", "for", "with", "that",
  "this", "these", "those", "it", "its", "as", "by", "at", "be", "or", "but",
  "not", "have", "has", "had", "having", "is", "are", "was", "were", "be",
  "been", "being", "i", "you", "he", "she", "we", "they", "his", "her",
  "their", "our", "your", "so", "if", "then", "than", "just", "about",
  "into", "out", "up", "down", "over", "what", "which", "who", "whom",
  "when", "where", "how", "why", "there", "here", "from", "can", "will",
  "would", "could", "should", "do", "does", "did", "also", "one", "two",
  "get", "got", "like", "really", "think", "know", "going", "gonna",
]);

export type DigestEpisodeInput = {
  record: ListenRecord;
  /** Transcript text, when the episode's transcript was successfully read. Absent for listened-but-not-transcribed episodes. */
  transcriptText?: string;
};

export type DigestSummary = {
  episodes: number;
  shows: number;
  transcribed: number;
  window: { days: number; start: string; end: string };
};

export type TopicCount = { term: string; count: number };

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
  showBreakdown: Array<{ show: string; count: number }>;
};

/** Term-frequency topics across every transcribed episode's text, excluding stopwords. Pure, deterministic ordering. */
export function recurringTopics(transcripts: string[]): TopicCount[] {
  const counts = new Map<string, number>();
  for (const text of transcripts) {
    for (const token of tokenize(text)) {
      if (token.length < MIN_TOPIC_LENGTH || STOPWORDS.has(token)) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.term.localeCompare(b.term)))
    .slice(0, MAX_TOPICS);
}

/**
 * The single most substantial pickExcerpts() candidate per transcribed
 * episode, ranked across the whole window by length and capped at
 * MAX_DIGEST_EXCERPTS, then restored to listen order for a coherent read.
 */
export function notableExcerpts(episodes: DigestEpisodeInput[]): NotableExcerpt[] {
  const candidates: Array<NotableExcerpt & { length: number; order: number }> = [];
  episodes.forEach((entry, order) => {
    if (!entry.transcriptText) return;
    const picks = pickExcerpts(entry.transcriptText);
    if (picks.length === 0) return;
    const best = picks.reduce((longest, candidate) =>
      candidate.length > longest.length ? candidate : longest,
    );
    candidates.push({
      podcast: entry.record.podcastTitle,
      episode: entry.record.title,
      excerpt: best,
      length: best.length,
      order,
    });
  });
  return candidates
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_DIGEST_EXCERPTS)
    .sort((a, b) => a.order - b.order)
    .map(({ podcast, episode, excerpt }) => ({ podcast, episode, excerpt }));
}

/** Counts and breakdowns over every in-window episode, transcribed or not. */
export function listeningPattern(episodes: DigestEpisodeInput[]): ListeningPattern {
  const sourceBreakdown: Record<string, number> = {};
  const showCounts = new Map<string, number>();
  let transcribedCount = 0;
  for (const { record } of episodes) {
    showCounts.set(record.podcastTitle, (showCounts.get(record.podcastTitle) ?? 0) + 1);
    if (record.transcriptStatus === "stored") {
      transcribedCount++;
      const source = record.transcriptSource ?? "unknown";
      sourceBreakdown[source] = (sourceBreakdown[source] ?? 0) + 1;
    } else {
      sourceBreakdown["not-transcribed"] = (sourceBreakdown["not-transcribed"] ?? 0) + 1;
    }
  }
  const showBreakdown = Array.from(showCounts.entries())
    .map(([show, count]) => ({ show, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.show.localeCompare(b.show)));
  return {
    totalEpisodes: episodes.length,
    showCount: showCounts.size,
    transcribedCount,
    sourceBreakdown,
    showBreakdown,
  };
}

export function buildDigest(options: {
  episodes: DigestEpisodeInput[];
  days: number;
  windowStart: Date;
  windowEnd: Date;
  generatedAt: Date;
}): { markdown: string; summary: DigestSummary } {
  const { episodes, days, windowStart, windowEnd, generatedAt } = options;
  const pattern = listeningPattern(episodes);
  const transcripts = episodes
    .map((e) => e.transcriptText)
    .filter((text): text is string => text !== undefined);
  const topics = recurringTopics(transcripts);
  const excerpts = notableExcerpts(episodes);

  const summary: DigestSummary = {
    episodes: episodes.length,
    shows: pattern.showCount,
    transcribed: pattern.transcribedCount,
    window: { days, start: windowStart.toISOString(), end: windowEnd.toISOString() },
  };

  const transcribedPct =
    pattern.totalEpisodes > 0 ? Math.round((pattern.transcribedCount / pattern.totalEpisodes) * 100) : 0;

  const lines: Array<string | undefined> = [
    "---",
    "status: pending-review",
    "privacy: private-source",
    "kind: digest",
    `window_days: ${days}`,
    `window_start: ${windowStart.toISOString()}`,
    `window_end: ${windowEnd.toISOString()}`,
    `episode_count: ${summary.episodes}`,
    `show_count: ${summary.shows}`,
    `transcribed_count: ${summary.transcribed}`,
    `generated_at: ${generatedAt.toISOString()}`,
    "---",
    "",
    `# Digest: last ${days} days`,
    "",
    "> This is a structural, heuristic aggregation generated from privately",
    "> stored listen history and transcripts. Nothing below is in durable",
    "> memory, and nothing below is a synthesized conclusion — it's counts,",
    "> term frequencies, and verbatim excerpts for you to make sense of.",
    "",
    "## Listening pattern",
    "",
    `- Episodes: ${pattern.totalEpisodes} across ${pattern.showCount} show${pattern.showCount === 1 ? "" : "s"}`,
    `- Transcribed: ${pattern.transcribedCount} of ${pattern.totalEpisodes} (${transcribedPct}%)`,
    `- By transcript source: ${formatBreakdown(pattern.sourceBreakdown)}`,
    `- By show: ${pattern.showBreakdown.map((s) => `${yamlString(s.show)} (${s.count})`).join(", ")}`,
    "",
    "## Recurring topics",
    "",
    topics.length > 0
      ? topics.map((t) => `${t.term} (${t.count})`).join(", ")
      : "_No transcribed episodes in this window; topics require at least one stored transcript._",
    "",
    "## Notable excerpts",
    "",
    excerpts.length > 0
      ? excerpts
          .map((e) => `### ${e.podcast} — ${e.episode}\n\n> ${e.excerpt}`)
          .join("\n\n")
      : "_No transcribed episodes in this window to excerpt from._",
    "",
    "## For the reviewing agent",
    "",
    "This digest deliberately stops at structure. Some questions worth sitting with, using the material above:",
    "",
    "- What have I actually been absorbing lately, across these shows and excerpts?",
    "- Do the recurring topics point at a thread I'm pulling on, or just noise from one long episode?",
    "- Do any of these excerpts connect to something I'm currently working on or thinking about?",
    "- Is there a durable idea here worth keeping, in my own words?",
    "",
    "## Reviewer notes",
    "",
    "- [ ] Anything here worth promoting into durable memory, in my own words?",
    "- [ ] Anything here change what I'm working on or thinking about?",
    "",
  ];

  return { markdown: `${lines.filter((line) => line !== undefined).join("\n")}\n`, summary };
}

function formatBreakdown(breakdown: Record<string, number>): string {
  const entries = Object.entries(breakdown).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries.length > 0 ? entries.map(([source, count]) => `${source}: ${count}`).join(", ") : "none";
}
