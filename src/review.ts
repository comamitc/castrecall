/**
 * Review candidate generation.
 *
 * CastRecall never promotes transcripts into durable memory itself. Instead it
 * writes a pending review document per episode: listen metadata, provenance,
 * and heuristic excerpt candidates. A human (or a human-approved agent flow)
 * decides what — if anything — graduates into curated memory.
 */

import type { ListenRecord, Provenance } from "./storage.js";

const MAX_EXCERPTS = 5;
const MAX_EXCERPT_CHARS = 600;
const MIN_EXCERPT_CHARS = 120;

export function buildReviewCandidate(options: {
  record: ListenRecord;
  provenance: Provenance;
  transcriptText: string;
  transcriptPath: string;
  generatedAt: Date;
}): string {
  const { record, provenance, transcriptText, transcriptPath, generatedAt } = options;
  const excerpts = pickExcerpts(transcriptText);
  const wordCount = transcriptText.split(/\s+/).filter(Boolean).length;

  const lines: Array<string | undefined> = [
    "---",
    "status: pending-review",
    "privacy: private-source",
    `episode_uuid: ${record.uuid}`,
    `podcast: ${yamlString(record.podcastTitle)}`,
    `episode: ${yamlString(record.title)}`,
    `listened: ${record.firstSeenAt}`,
    `transcript_source: ${provenance.transcriptSource}`,
    `transcript_format: ${provenance.format}`,
    provenance.provider ? `transcript_provider: ${provenance.provider}` : undefined,
    `generated_at: ${generatedAt.toISOString()}`,
    "---",
    "",
    `# Review: ${record.title}`,
    "",
    `From **${record.podcastTitle}**${record.author ? ` by ${record.author}` : ""}.`,
    "",
    "> This is a review candidate generated from a privately stored transcript.",
    "> Nothing below is in durable memory. Promote only what is worth keeping,",
    "> in your own words where possible, and discard the rest.",
    "",
    "## Provenance",
    "",
    `- Platform: Pocket Casts (listen history)`,
    provenance.feedUrl ? `- Feed: ${reviewUrl(provenance.feedUrl)}` : undefined,
    provenance.episodeUrl ? `- Episode page: ${reviewUrl(provenance.episodeUrl)}` : undefined,
    provenance.audioUrl ? `- Audio: ${reviewUrl(provenance.audioUrl)}` : undefined,
    `- Transcript: ${provenance.transcriptSource}${provenance.transcriptSourceUrl ? ` (${reviewUrl(provenance.transcriptSourceUrl)})` : ""}`,
    `- Fetched: ${provenance.fetchedAt}`,
    `- Full transcript (${wordCount.toLocaleString()} words): ${transcriptPath}`,
    "",
    "## Excerpt candidates",
    "",
    excerpts.length > 0
      ? excerpts.map((excerpt, i) => `${i + 1}. ${excerpt}`).join("\n\n")
      : "_Transcript too short or unstructured for automatic excerpts; read the full transcript above._",
    "",
    "## Reviewer notes",
    "",
    "- [ ] Worth keeping? What is the one durable idea?",
    "- [ ] Anything here change what I'm working on or thinking about?",
    "",
  ];
  return `${lines.filter((line) => line !== undefined).join("\n")}\n`;
}

/**
 * Render a human-chosen promotion into a frontmattered note for the
 * configured notes destination. The body is exactly the human's `content` —
 * no heuristic excerpts, no full transcript — but attribution (podcast,
 * episode, listen date, transcript source, episode UUID) travels with it so
 * a promoted note is still traceable back to its source.
 */
export function buildPromotedNote(options: {
  record: ListenRecord;
  provenance: Provenance;
  content: string;
  title?: string;
  resolvedAt: Date;
}): string {
  const { record, provenance, content, title, resolvedAt } = options;
  const heading = title?.trim() || record.title;

  const lines: Array<string | undefined> = [
    "---",
    `podcast: ${yamlString(record.podcastTitle)}`,
    `episode: ${yamlString(record.title)}`,
    `listened: ${record.firstSeenAt}`,
    `transcript_source: ${provenance.transcriptSource}`,
    provenance.provider ? `transcript_provider: ${provenance.provider}` : undefined,
    `episode_uuid: ${record.uuid}`,
    "promoted_from: castrecall",
    `resolved_at: ${resolvedAt.toISOString()}`,
    "---",
    "",
    `# ${heading}`,
    "",
    content.trim(),
    "",
  ];
  return `${lines.filter((line) => line !== undefined).join("\n")}\n`;
}

/**
 * Heuristic excerpt selection: split into paragraph-ish chunks, keep the
 * most substantial ones in original order. Deliberately simple and honest —
 * semantic summarization belongs to the reviewing agent/human, not this plugin.
 */
export function pickExcerpts(text: string): string[] {
  const paragraphs = text
    .split(/\n{2,}|\n(?=[A-Z][\w .'-]{0,40}: )/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length >= MIN_EXCERPT_CHARS);

  const chunks = paragraphs.length > 0 ? paragraphs : sentenceChunks(text);
  const ranked = chunks
    .map((chunk, index) => ({ chunk, index, score: chunk.length }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_EXCERPTS)
    .sort((a, b) => a.index - b.index);

  return ranked.map(({ chunk }) =>
    chunk.length > MAX_EXCERPT_CHARS ? `${chunk.slice(0, MAX_EXCERPT_CHARS).trimEnd()}…` : chunk,
  );
}

function sentenceChunks(text: string): string[] {
  const sentences = text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    current = current ? `${current} ${sentence}` : sentence;
    if (current.length >= MIN_EXCERPT_CHARS * 2) {
      chunks.push(current);
      current = "";
    }
  }
  if (current.length >= MIN_EXCERPT_CHARS) chunks.push(current);
  return chunks;
}

export function yamlString(value: string): string {
  return JSON.stringify(value);
}

function reviewUrl(value: string): string {
  try {
    const url = new URL(value);
    const hadPrivateParts = url.search.length > 0 || url.hash.length > 0;
    url.search = "";
    url.hash = "";
    return hadPrivateParts
      ? `${url.toString()} (query removed; full URL is in provenance.json)`
      : url.toString();
  } catch {
    return value;
  }
}
