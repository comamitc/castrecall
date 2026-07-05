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
import type { ListenRecord, Provenance } from "./storage.js";

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
 * Split transcript text into ordered, verbatim sections of roughly
 * `targetWords` words, never exceeding `maxWords`. Sections are exact
 * contiguous slices of the source text — never rewritten or whitespace-
 * collapsed — so gbrain and similar consumers see the transcript as-fetched.
 */
export function splitSections(
  text: string,
  options: { targetWords?: number; maxWords?: number } = {},
): string[] {
  const targetWords = options.targetWords ?? DEFAULT_TARGET_WORDS;
  const maxWords = options.maxWords ?? DEFAULT_MAX_WORDS;
  if (text.trim().length === 0) return [text];

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

  return sections.map((s) => text.slice(s.start, s.end));
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function firstWords(text: string, n: number): string {
  return text.trim().split(/\s+/).slice(0, n).join(" ");
}

type PageMeta = {
  show: string;
  episode: string;
  episodeUrl?: string;
  audioUrl?: string;
  listenDate: string;
  transcriptSource: string;
  contentHash: string;
};

function frontmatterLines(title: string, meta: PageMeta): string[] {
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
}): CorpusPage[] {
  const { record, provenance, text, contentHash } = options;
  const showSlug = slugify(record.podcastTitle, "show");
  const episodeSlug = episodeDirSlug(record);
  const sections = splitSections(text, {
    targetWords: options.targetWords,
    maxWords: options.maxWords,
  });
  const total = sections.length;
  const meta: PageMeta = {
    show: record.podcastTitle,
    episode: record.title,
    episodeUrl: provenance.episodeUrl,
    audioUrl: provenance.audioUrl,
    listenDate: (provenance.listenTimestamp ?? record.firstSeenAt).slice(0, 10),
    transcriptSource: provenance.transcriptSource,
    contentHash,
  };

  const pages: CorpusPage[] = [];
  const sectionLinks: Array<{ label: string; file: string }> = [];

  sections.forEach((sectionText, i) => {
    const nn = String(i + 1).padStart(2, "0");
    const slug = slugify(firstWords(sectionText, 8), "section");
    const file = `${nn}-${slug}.md`;
    const title = total > 1 ? `${record.title} — part ${i + 1} of ${total}` : record.title;
    const content = `${frontmatterLines(title, meta).join("\n")}\n\n${sectionText}\n`;
    pages.push({ relativePath: `podcasts/${showSlug}/${episodeSlug}/${file}`, content });
    sectionLinks.push({ label: slug.replace(/-/g, " "), file });
  });

  const indexLines = [
    ...frontmatterLines(record.title, meta),
    "",
    `# ${record.title}`,
    "",
    `From **${record.podcastTitle}**.`,
    "",
    "## Sections",
    "",
    ...sectionLinks.map((s, i) => `${i + 1}. [${s.label}](./${s.file})`),
    "",
  ];
  pages.push({
    relativePath: `podcasts/${showSlug}/${episodeSlug}/index.md`,
    content: `${indexLines.join("\n")}\n`,
  });

  return pages;
}

const CONTENT_HASH_LINE = /^content_hash: "([^"]*)"$/m;

async function readExistingContentHash(episodeDir: string): Promise<string | undefined> {
  try {
    const indexContent = await fs.readFile(path.join(episodeDir, "index.md"), "utf8");
    return indexContent.match(CONTENT_HASH_LINE)?.[1];
  } catch {
    return undefined;
  }
}

export type ExportResult = { exported: number; skipped: boolean; dir: string };

/**
 * Publishes corpus pages under `<exportDir>/podcasts/<show-slug>/<episode-slug>/`.
 * Idempotent by content hash: an unchanged episode re-exports nothing. A
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
  }): Promise<ExportResult> {
    const showSlug = slugify(options.record.podcastTitle, "show");
    const episodeSlug = episodeDirSlug(options.record);
    const targetDir = path.join(this.exportDir, "podcasts", showSlug, episodeSlug);

    const existingHash = await readExistingContentHash(targetDir);
    if (existingHash === options.contentHash) {
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
