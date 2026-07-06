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

import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { isLocalWhisperGeneration, type ListenRecord, type Provenance } from "./storage.js";
import type { LocalWhisperGeneration } from "./transcripts/local-whisper.js";
import type { TranscriptSegment } from "./transcripts/normalize.js";
import type { TranscriptQuality } from "./transcripts/quality.js";
import type { RemoteSttGeneration } from "./transcripts/remote-stt.js";

const DEFAULT_TARGET_WORDS = 1500;
const DEFAULT_MAX_WORDS = 2000;

const PARAGRAPH_BOUNDARY = /\n{2,}|\n(?=[A-Z][\w .'-]{0,40}: )/g;
const SENTENCE_BOUNDARY = /(?<=[.!?])\s+/g;

type Range = { start: number; end: number };

export type CorpusPage = { relativePath: string; content: string };

/** Kebab-case slug; never empty — falls back when the input has no alphanumerics. */
export function slugify(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || fallback;
}

/**
 * Episode directory slug, disambiguated by the episode's globally unique
 * uuid so two episodes that title-slugify (or fallback-slugify) to the same
 * string never share — and one export overwrite — the other's directory.
 */
function episodeDirSlug(record: ListenRecord): string {
  const slug = slugify(record.title, "episode");
  const suffix = createHash("sha256").update(record.uuid).digest("hex").slice(0, 8);
  return `${slug}-${suffix}`;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Boundary matches split `range` into contiguous, verbatim sub-ranges of `text`. */
function splitByBoundary(text: string, range: Range, boundary: RegExp): Range[] {
  const slice = text.slice(range.start, range.end);
  const units: Range[] = [];
  let last = 0;
  boundary.lastIndex = 0;
  for (const match of slice.matchAll(boundary)) {
    const idx = match.index ?? 0;
    if (idx > last) units.push({ start: range.start + last, end: range.start + idx });
    last = idx + match[0].length;
  }
  if (last < slice.length) units.push({ start: range.start + last, end: range.start + slice.length });
  return units.length > 0 ? units : [range];
}

/** Terminal fallback: chop a range on whitespace boundaries into ≤maxWords slices. */
function hardSplit(text: string, range: Range, maxWords: number): Range[] {
  const slice = text.slice(range.start, range.end);
  const tokens = Array.from(slice.matchAll(/\S+/g));
  if (tokens.length === 0) return [range];
  const chunks: Range[] = [];
  let chunkStart = range.start + tokens[0].index;
  let chunkEnd = chunkStart;
  let count = 0;
  for (const token of tokens) {
    if (count >= maxWords) {
      chunks.push({ start: chunkStart, end: chunkEnd });
      chunkStart = range.start + token.index;
      count = 0;
    }
    chunkEnd = range.start + token.index + token[0].length;
    count += 1;
  }
  chunks.push({ start: chunkStart, end: chunkEnd });
  return chunks;
}

/**
 * Break a too-large unit down: sentence boundaries first, then a hard
 * whitespace split for any resulting piece still over `maxWords` (e.g. one
 * unbroken sentence or a blob with no sentence-ending punctuation at all).
 */
function atomize(text: string, range: Range, maxWords: number): Range[] {
  if (wordCount(text.slice(range.start, range.end)) <= maxWords) return [range];
  const sentenceUnits = splitByBoundary(text, range, SENTENCE_BOUNDARY);
  return sentenceUnits.flatMap((unit) =>
    wordCount(text.slice(unit.start, unit.end)) > maxWords ? hardSplit(text, unit, maxWords) : [unit],
  );
}

/**
 * Split transcript text into ordered, non-overlapping section ranges of
 * roughly `targetWords` words, never exceeding `maxWords`. The pure range
 * computation behind `splitSections` — exposed separately so callers that
 * need section boundaries (e.g. mapping segment timestamps onto sections)
 * don't have to re-derive them from slice content.
 */
export function splitSectionRanges(
  text: string,
  options: { targetWords?: number; maxWords?: number } = {},
): Range[] {
  const targetWords = options.targetWords ?? DEFAULT_TARGET_WORDS;
  const maxWords = options.maxWords ?? DEFAULT_MAX_WORDS;
  if (text.trim().length === 0) return [{ start: 0, end: text.length }];

  const paragraphUnits = splitByBoundary(text, { start: 0, end: text.length }, PARAGRAPH_BOUNDARY);
  const atomicUnits = paragraphUnits.flatMap((unit) => atomize(text, unit, maxWords));

  const sections: Range[] = [];
  let sectionStart: number | undefined;
  let sectionEnd = 0;
  let sectionWords = 0;
  for (const unit of atomicUnits) {
    const unitWords = wordCount(text.slice(unit.start, unit.end));
    if (sectionStart !== undefined && sectionWords + unitWords > maxWords) {
      sections.push({ start: sectionStart, end: sectionEnd });
      sectionStart = undefined;
      sectionWords = 0;
    }
    if (sectionStart === undefined) sectionStart = unit.start;
    sectionEnd = unit.end;
    sectionWords += unitWords;
    if (sectionWords >= targetWords) {
      sections.push({ start: sectionStart, end: sectionEnd });
      sectionStart = undefined;
      sectionWords = 0;
    }
  }
  if (sectionStart !== undefined) sections.push({ start: sectionStart, end: sectionEnd });

  return sections;
}

/**
 * Split transcript text into ordered, verbatim sections of roughly
 * `targetWords` words, never exceeding `maxWords`. Sections are exact
 * contiguous slices of the source text — never rewritten or whitespace-
 * collapsed — so gbrain and similar consumers see the transcript as-fetched.
 */
export function splitSections(
  text: string,
  options: { targetWords?: number; maxWords?: number } = {},
): string[] {
  return splitSectionRanges(text, options).map((s) => text.slice(s.start, s.end));
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function firstWords(text: string, n: number): string {
  return text.trim().split(/\s+/).slice(0, n).join(" ");
}

/** Format seconds as `HH:MM:SS` (supports durations of an hour or more). */
export function formatTimecode(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return [hours, minutes, secs].map((n) => String(n).padStart(2, "0")).join(":");
}

export type SectionTiming = { approxStart?: number; approxEnd?: number };

type TimelineAnchor = { charStart: number; charEnd: number; startSeconds: number; endSeconds: number };

/**
 * Cumulative char-offset timeline over segment text, in segment order.
 * Empty-text segments are skipped entirely (they contribute no characters).
 * A segment with text but no numeric `startSeconds`/`endSeconds` still
 * advances the character cursor (so later segments keep their proportional
 * position) but is not added as a timed anchor — that stretch of characters
 * becomes an untimed gap between the neighboring anchors.
 */
function buildSegmentTimeline(segments: TranscriptSegment[] | undefined): {
  anchors: TimelineAnchor[];
  totalChars: number;
} {
  const anchors: TimelineAnchor[] = [];
  let cursor = 0;
  for (const segment of segments ?? []) {
    const text = segment.text ?? "";
    if (!text.trim()) continue;
    const charStart = cursor;
    cursor += text.length;
    if (segment.startSeconds !== undefined && segment.endSeconds !== undefined) {
      anchors.push({ charStart, charEnd: cursor, startSeconds: segment.startSeconds, endSeconds: segment.endSeconds });
    }
  }
  return { anchors, totalChars: cursor };
}

/**
 * Map a target character offset (in the segment-timeline's char space) to
 * seconds: linear interpolation within the covering anchor, clamped to the
 * first/last anchor's time when the offset falls before/after the timed
 * range, and `undefined` when it falls in an untimed gap between anchors.
 */
function mapOffsetToSeconds(anchors: TimelineAnchor[], targetChar: number): number | undefined {
  if (anchors.length === 0) return undefined;
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  if (targetChar <= first.charStart) return first.startSeconds;
  if (targetChar >= last.charEnd) return last.endSeconds;
  for (const anchor of anchors) {
    if (targetChar >= anchor.charStart && targetChar <= anchor.charEnd) {
      const span = anchor.charEnd - anchor.charStart;
      if (span <= 0) return anchor.startSeconds;
      const fraction = (targetChar - anchor.charStart) / span;
      return anchor.startSeconds + fraction * (anchor.endSeconds - anchor.startSeconds);
    }
  }
  return undefined;
}

/**
 * Map each section range onto an approximate `{ approxStart, approxEnd }` in
 * seconds, by proportionally scaling the range's position in `text` onto the
 * segment timeline built from `segments`. This is inherently approximate:
 * `text` is the deduped/whitespace-collapsed transcript (see `segmentsToText`),
 * so character offsets don't line up exactly with segment boundaries.
 *
 * Contract: never returns `NaN`. Returns all-`undefined` entries when there
 * is no usable timing signal at all (empty text, no ranges, or no segment
 * carries numeric times). Emitted times are non-decreasing across ordered
 * sections, and within a section `approxEnd >= approxStart` whenever both are
 * defined.
 */
export function sectionTimestamps(
  segments: TranscriptSegment[] | undefined,
  ranges: Range[],
  textLength: number,
): SectionTiming[] {
  if (textLength <= 0 || ranges.length === 0) return ranges.map(() => ({}));
  const { anchors, totalChars } = buildSegmentTimeline(segments);
  if (anchors.length === 0 || totalChars === 0) return ranges.map(() => ({}));

  const results: SectionTiming[] = [];
  let floor = 0;
  for (const range of ranges) {
    const startTarget = (range.start / textLength) * totalChars;
    const endTarget = (range.end / textLength) * totalChars;
    let approxStart = mapOffsetToSeconds(anchors, startTarget);
    let approxEnd = mapOffsetToSeconds(anchors, endTarget);
    if (approxStart !== undefined) {
      approxStart = Math.max(approxStart, floor);
      floor = approxStart;
    }
    if (approxEnd !== undefined) {
      approxEnd = Math.max(approxEnd, floor, approxStart ?? approxEnd);
      floor = approxEnd;
    }
    results.push({ approxStart, approxEnd });
  }
  return results;
}

/**
 * Distinct, ordered, non-empty speaker labels carried by `segments` (issue
 * #44) — provider-given labels only, never invented. `[]` when no segment
 * carries a speaker (e.g. local Whisper), so callers can omit the frontmatter
 * line entirely rather than emit an empty array.
 */
export function distinctSpeakers(segments: TranscriptSegment[] | undefined): string[] {
  const seen = new Set<string>();
  for (const segment of segments ?? []) {
    const speaker = segment.speaker?.trim();
    if (speaker) seen.add(speaker);
  }
  return [...seen];
}

type PageMeta = {
  show: string;
  episode: string;
  episodeUrl?: string;
  audioUrl?: string;
  listenDate: string;
  transcriptSource: string;
  contentHash: string;
  generation?: LocalWhisperGeneration | RemoteSttGeneration;
  quality?: TranscriptQuality;
  /** Distinct speaker labels present in this episode's segments (issue #44); omitted from frontmatter when empty. */
  speakers?: string[];
};

function frontmatterLines(title: string, meta: PageMeta, timing?: SectionTiming): string[] {
  const gen = meta.generation;
  const localGen = isLocalWhisperGeneration(gen) ? gen : undefined;
  const remoteGen = gen?.kind === "remote-stt" ? gen : undefined;
  const lines: Array<string | undefined> = [
    "---",
    `title: ${yamlString(title)}`,
    `show: ${yamlString(meta.show)}`,
    `episode: ${yamlString(meta.episode)}`,
    meta.episodeUrl ? `episode_url: ${yamlString(meta.episodeUrl)}` : undefined,
    meta.audioUrl ? `audio_url: ${yamlString(meta.audioUrl)}` : undefined,
    `listen_date: ${yamlString(meta.listenDate)}`,
    `transcript_source: ${yamlString(meta.transcriptSource)}`,
    `content_hash: ${yamlString(meta.contentHash)}`,
    "generated: false",
    localGen ? `transcript_backend: ${yamlString(localGen.backend)}` : undefined,
    localGen?.model ? `transcript_model: ${yamlString(localGen.model)}` : undefined,
    localGen ? `transcript_model_source: ${yamlString(localGen.modelSource)}` : undefined,
    localGen?.preset ? `transcript_preset: ${yamlString(localGen.preset)}` : undefined,
    localGen ? `transcript_output_format: ${yamlString(localGen.outputFormat)}` : undefined,
    localGen ? `transcript_word_timestamps: ${localGen.wordTimestamps}` : undefined,
    localGen && Object.keys(localGen.decode.applied).length > 0
      ? `transcript_decode_options: ${yamlString(JSON.stringify(localGen.decode.applied))}`
      : undefined,
    localGen && localGen.decode.ignored.length > 0
      ? `transcript_decode_ignored: ${yamlString(JSON.stringify(localGen.decode.ignored.map((entry) => entry.option)))}`
      : undefined,
    localGen?.toolVersion ? `transcript_tool_version: ${yamlString(localGen.toolVersion)}` : undefined,
    remoteGen?.implementation ? `transcript_implementation: ${yamlString(remoteGen.implementation)}` : undefined,
    remoteGen?.model ? `transcript_model: ${yamlString(remoteGen.model)}` : undefined,
    remoteGen ? `transcript_remote_host: ${yamlString(remoteGen.baseUrlHost)}` : undefined,
    meta.quality ? `transcript_quality_score: ${meta.quality.score}` : undefined,
    meta.quality ? `transcript_quality_tier: ${yamlString(meta.quality.tier)}` : undefined,
    meta.quality ? `transcript_quality_reasons: ${JSON.stringify(meta.quality.reasons)}` : undefined,
    meta.speakers && meta.speakers.length > 0 ? `speakers: ${JSON.stringify(meta.speakers)}` : undefined,
    timing?.approxStart !== undefined ? `approx_start: ${yamlString(formatTimecode(timing.approxStart))}` : undefined,
    timing?.approxEnd !== undefined ? `approx_end: ${yamlString(formatTimecode(timing.approxEnd))}` : undefined,
    "---",
  ];
  return lines.filter((line): line is string => line !== undefined);
}

/**
 * Build the full set of markdown pages for one episode: one page per
 * transcript section plus an episode index page. Pure — no filesystem
 * access; `CorpusExporter` handles publishing these to disk.
 */
export function buildCorpusPages(options: {
  record: ListenRecord;
  provenance: Provenance;
  text: string;
  contentHash: string;
  targetWords?: number;
  maxWords?: number;
  /** Normalized transcript segments (issue #43) — when present, section/index pages get approximate timestamps. */
  segments?: TranscriptSegment[];
}): CorpusPage[] {
  const { record, provenance, text, contentHash, segments } = options;
  const showSlug = slugify(record.podcastTitle, "show");
  const episodeSlug = episodeDirSlug(record);
  const ranges = splitSectionRanges(text, {
    targetWords: options.targetWords,
    maxWords: options.maxWords,
  });
  const sections = ranges.map((r) => text.slice(r.start, r.end));
  const timings = sectionTimestamps(segments, ranges, text.length);
  const total = sections.length;
  const meta: PageMeta = {
    show: record.podcastTitle,
    episode: record.title,
    episodeUrl: provenance.episodeUrl,
    audioUrl: provenance.audioUrl,
    listenDate: (provenance.listenTimestamp ?? record.firstSeenAt).slice(0, 10),
    transcriptSource: provenance.transcriptSource,
    contentHash,
    generation: provenance.generation,
    quality: provenance.quality,
    speakers: distinctSpeakers(segments),
  };

  const pages: CorpusPage[] = [];
  const sectionLinks: Array<{ label: string; file: string; approxStart?: number }> = [];

  sections.forEach((sectionText, i) => {
    const nn = String(i + 1).padStart(2, "0");
    const slug = slugify(firstWords(sectionText, 8), "section");
    const file = `${nn}-${slug}.md`;
    const title = total > 1 ? `${record.title} — part ${i + 1} of ${total}` : record.title;
    const content = `${frontmatterLines(title, meta, timings[i]).join("\n")}\n\n${sectionText}\n`;
    pages.push({ relativePath: `podcasts/${showSlug}/${episodeSlug}/${file}`, content });
    sectionLinks.push({ label: slug.replace(/-/g, " "), file, approxStart: timings[i]?.approxStart });
  });

  // Episode-level span for index.md frontmatter — the first section's
  // approxStart through the last section's approxEnd — doubles as the sole
  // reconciliation marker `readExistingExportMeta` looks for (it reads only
  // index.md), so it is emitted only when at least one section on each end
  // actually resolved a time; both-or-neither, never a half span.
  const definedStarts = timings.map((t) => t.approxStart).filter((v): v is number => v !== undefined);
  const definedEnds = timings.map((t) => t.approxEnd).filter((v): v is number => v !== undefined);
  const episodeTiming: SectionTiming | undefined =
    definedStarts.length > 0 && definedEnds.length > 0
      ? { approxStart: definedStarts[0], approxEnd: definedEnds[definedEnds.length - 1] }
      : undefined;

  const indexLines = [
    ...frontmatterLines(record.title, meta, episodeTiming),
    "",
    `# ${record.title}`,
    "",
    `From **${record.podcastTitle}**.`,
    "",
    "## Sections",
    "",
    ...sectionLinks.map(
      (s, i) =>
        `${i + 1}. [${s.label}](./${s.file})${s.approxStart !== undefined ? ` — ${formatTimecode(s.approxStart)}` : ""}`,
    ),
    "",
  ];
  pages.push({
    relativePath: `podcasts/${showSlug}/${episodeSlug}/index.md`,
    content: `${indexLines.join("\n")}\n`,
  });

  return pages;
}

const CONTENT_HASH_LINE = /^content_hash: "([^"]*)"$/m;
const QUALITY_SCORE_LINE = /^transcript_quality_score: (\d+)$/m;
const QUALITY_TIER_LINE = /^transcript_quality_tier: "([^"]*)"$/m;
const QUALITY_REASONS_LINE = /^transcript_quality_reasons: (\[[^\]]*\])$/m;
const APPROX_START_LINE = /^approx_start: "([^"]*)"$/m;
const SPEAKERS_LINE = /^speakers: (\[[^\]]*\])$/m;

type ExistingExportMeta = {
  contentHash?: string;
  quality?: TranscriptQuality;
  hasTimestamps: boolean;
  hasSpeakers: boolean;
};

async function readExistingExportMeta(episodeDir: string): Promise<ExistingExportMeta | undefined> {
  try {
    const indexContent = await fs.readFile(path.join(episodeDir, "index.md"), "utf8");
    const scoreMatch = indexContent.match(QUALITY_SCORE_LINE);
    const tierMatch = indexContent.match(QUALITY_TIER_LINE);
    const reasonsMatch = indexContent.match(QUALITY_REASONS_LINE);
    const quality =
      scoreMatch && tierMatch && reasonsMatch
        ? {
            score: Number(scoreMatch[1]),
            tier: tierMatch[1] as TranscriptQuality["tier"],
            reasons: JSON.parse(reasonsMatch[1]) as TranscriptQuality["reasons"],
          }
        : undefined;
    return {
      contentHash: indexContent.match(CONTENT_HASH_LINE)?.[1],
      quality,
      // index.md is the only page read here, so it must carry the
      // reconciliation signal itself — see buildCorpusPages' episodeTiming,
      // which emits approx_start/approx_end on index.md together or not at all.
      hasTimestamps: APPROX_START_LINE.test(indexContent),
      hasSpeakers: SPEAKERS_LINE.test(indexContent),
    };
  } catch {
    return undefined;
  }
}

export type ExportResult = { exported: number; skipped: boolean; dir: string };

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
export class CorpusExporter {
  constructor(private readonly exportDir: string) {}

  async exportEpisode(options: {
    record: ListenRecord;
    provenance: Provenance;
    text: string;
    contentHash: string;
    targetWords?: number;
    maxWords?: number;
    /** Normalized transcript segments (issue #43), read from the storage sidecar — see readSegments. */
    segments?: TranscriptSegment[];
  }): Promise<ExportResult> {
    const showSlug = slugify(options.record.podcastTitle, "show");
    const episodeSlug = episodeDirSlug(options.record);
    const targetDir = path.join(this.exportDir, "podcasts", showSlug, episodeSlug);

    const existing = await readExistingExportMeta(targetDir);
    // Quality reconciliation only runs when the incoming provenance
    // actually carries a quality value: legacy pre-#41 sidecars have none,
    // and re-exporting a same-hash episode against an already-scored page
    // just to REMOVE its score/tier/reasons would erase the only
    // machine-readable quality signal downstream consumers have. A scored
    // page therefore only re-exports when the incoming quality disagrees.
    const qualityStale =
      existing !== undefined &&
      options.provenance.quality !== undefined &&
      JSON.stringify(existing.quality) !== JSON.stringify(options.provenance.quality);
    // Same idea for timestamps (issue #43): an episode exported before
    // segments were available lacks approx_start/approx_end on index.md;
    // once segments carry enough timing to actually emit an anchor (matching
    // buildSegmentTimeline's own criteria — non-empty text with both
    // startSeconds and endSeconds), re-export once to backfill them, then
    // settle (readExistingExportMeta will report hasTimestamps: true on the
    // next call). Partial timing (only one of start/end, or timed-but-empty
    // text) never yields an anchor, so it must not mark this stale either —
    // otherwise buildCorpusPages can never emit approx_start and the export
    // would re-run forever.
    const canEmitTimestamps = buildSegmentTimeline(options.segments).anchors.length > 0;
    const timestampsStale = existing !== undefined && canEmitTimestamps && !existing.hasTimestamps;
    // Same idea for speaker labels (issue #44): an episode exported before
    // segments carried speakers lacks the `speakers:` line on index.md; once
    // segments carry at least one non-empty speaker, re-export once to
    // backfill it, then settle. Gated the same both-or-neither way as
    // timestamps so a speaker-less transcript never triggers a perpetual
    // re-export loop.
    const speakersStale =
      existing !== undefined && distinctSpeakers(options.segments).length > 0 && !existing.hasSpeakers;
    if (existing?.contentHash === options.contentHash && !qualityStale && !timestampsStale && !speakersStale) {
      return { exported: 0, skipped: true, dir: targetDir };
    }

    const pages = buildCorpusPages(options);
    const stagingDir = path.join(this.exportDir, ".staging", `${episodeSlug}-${randomUUID()}`);
    await fs.mkdir(stagingDir, { recursive: true });
    try {
      for (const page of pages) {
        await fs.writeFile(path.join(stagingDir, path.basename(page.relativePath)), page.content, "utf8");
      }
      await fs.mkdir(path.dirname(targetDir), { recursive: true });
      // fs.rename onto a populated directory fails on POSIX rather than
      // merging, so a changed-hash re-export must move the stale episode
      // dir out of the way first. It is moved to a backup — not deleted —
      // so an interrupted or failed promotion below can restore it instead
      // of leaving the user's corpus missing the last good export.
      const backupDir = path.join(this.exportDir, ".staging", `${episodeSlug}-backup-${randomUUID()}`);
      const hadExisting = await fs
        .rename(targetDir, backupDir)
        .then(() => true)
        .catch(() => false);
      try {
        await fs.rename(stagingDir, targetDir);
      } catch (err) {
        if (hadExisting) await fs.rename(backupDir, targetDir);
        throw err;
      }
      if (hadExisting) await fs.rm(backupDir, { recursive: true, force: true });
      return { exported: pages.length, skipped: false, dir: targetDir };
    } finally {
      await fs.rm(stagingDir, { recursive: true, force: true });
    }
  }
}
