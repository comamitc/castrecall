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
import { randomUUID } from "node:crypto";
import path from "node:path";
const DEFAULT_TARGET_WORDS = 1500;
const DEFAULT_MAX_WORDS = 2000;
const PARAGRAPH_BOUNDARY = /\n{2,}|\n(?=[A-Z][\w .'-]{0,40}: )/g;
const SENTENCE_BOUNDARY = /(?<=[.!?])\s+/g;
/** Kebab-case slug; never empty — falls back when the input has no alphanumerics. */
export function slugify(value, fallback) {
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
function wordCount(text) {
    return text.split(/\s+/).filter(Boolean).length;
}
/** Boundary matches split `range` into contiguous, verbatim sub-ranges of `text`. */
function splitByBoundary(text, range, boundary) {
    const slice = text.slice(range.start, range.end);
    const units = [];
    let last = 0;
    boundary.lastIndex = 0;
    for (const match of slice.matchAll(boundary)) {
        const idx = match.index ?? 0;
        if (idx > last)
            units.push({ start: range.start + last, end: range.start + idx });
        last = idx + match[0].length;
    }
    if (last < slice.length)
        units.push({ start: range.start + last, end: range.start + slice.length });
    return units.length > 0 ? units : [range];
}
/** Terminal fallback: chop a range on whitespace boundaries into ≤maxWords slices. */
function hardSplit(text, range, maxWords) {
    const slice = text.slice(range.start, range.end);
    const tokens = Array.from(slice.matchAll(/\S+/g));
    if (tokens.length === 0)
        return [range];
    const chunks = [];
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
function atomize(text, range, maxWords) {
    if (wordCount(text.slice(range.start, range.end)) <= maxWords)
        return [range];
    const sentenceUnits = splitByBoundary(text, range, SENTENCE_BOUNDARY);
    return sentenceUnits.flatMap((unit) => wordCount(text.slice(unit.start, unit.end)) > maxWords ? hardSplit(text, unit, maxWords) : [unit]);
}
/**
 * Split transcript text into ordered, verbatim sections of roughly
 * `targetWords` words, never exceeding `maxWords`. Sections are exact
 * contiguous slices of the source text — never rewritten or whitespace-
 * collapsed — so gbrain and similar consumers see the transcript as-fetched.
 */
export function splitSections(text, options = {}) {
    const targetWords = options.targetWords ?? DEFAULT_TARGET_WORDS;
    const maxWords = options.maxWords ?? DEFAULT_MAX_WORDS;
    if (text.trim().length === 0)
        return [text];
    const paragraphUnits = splitByBoundary(text, { start: 0, end: text.length }, PARAGRAPH_BOUNDARY);
    const atomicUnits = paragraphUnits.flatMap((unit) => atomize(text, unit, maxWords));
    const sections = [];
    let sectionStart;
    let sectionEnd = 0;
    let sectionWords = 0;
    for (const unit of atomicUnits) {
        const unitWords = wordCount(text.slice(unit.start, unit.end));
        if (sectionStart !== undefined && sectionWords + unitWords > maxWords) {
            sections.push({ start: sectionStart, end: sectionEnd });
            sectionStart = undefined;
            sectionWords = 0;
        }
        if (sectionStart === undefined)
            sectionStart = unit.start;
        sectionEnd = unit.end;
        sectionWords += unitWords;
        if (sectionWords >= targetWords) {
            sections.push({ start: sectionStart, end: sectionEnd });
            sectionStart = undefined;
            sectionWords = 0;
        }
    }
    if (sectionStart !== undefined)
        sections.push({ start: sectionStart, end: sectionEnd });
    return sections.map((s) => text.slice(s.start, s.end));
}
function yamlString(value) {
    return JSON.stringify(value);
}
function firstWords(text, n) {
    return text.trim().split(/\s+/).slice(0, n).join(" ");
}
function frontmatterLines(title, meta) {
    const lines = [
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
    return lines.filter((line) => line !== undefined);
}
/**
 * Build the full set of markdown pages for one episode: one page per
 * transcript section plus an episode index page. Pure — no filesystem
 * access; `CorpusExporter` handles publishing these to disk.
 */
export function buildCorpusPages(options) {
    const { record, provenance, text, contentHash } = options;
    const showSlug = slugify(record.podcastTitle, "show");
    const episodeSlug = slugify(record.title, "episode");
    const sections = splitSections(text, {
        targetWords: options.targetWords,
        maxWords: options.maxWords,
    });
    const total = sections.length;
    const meta = {
        show: record.podcastTitle,
        episode: record.title,
        episodeUrl: provenance.episodeUrl,
        audioUrl: provenance.audioUrl,
        listenDate: (provenance.listenTimestamp ?? record.firstSeenAt).slice(0, 10),
        transcriptSource: provenance.transcriptSource,
        contentHash,
    };
    const pages = [];
    const sectionLinks = [];
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
async function readExistingContentHash(episodeDir) {
    try {
        const indexContent = await fs.readFile(path.join(episodeDir, "index.md"), "utf8");
        return indexContent.match(CONTENT_HASH_LINE)?.[1];
    }
    catch {
        return undefined;
    }
}
/**
 * Publishes corpus pages under `<exportDir>/podcasts/<show-slug>/<episode-slug>/`.
 * Idempotent by content hash: an unchanged episode re-exports nothing. A
 * changed hash replaces the whole episode directory so no stale section
 * files from a previous, longer transcript survive.
 */
export class CorpusExporter {
    exportDir;
    constructor(exportDir) {
        this.exportDir = exportDir;
    }
    async exportEpisode(options) {
        const showSlug = slugify(options.record.podcastTitle, "show");
        const episodeSlug = slugify(options.record.title, "episode");
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
            // merging, so a changed-hash re-export must clear the stale episode
            // dir first — otherwise section files from a previously longer
            // transcript would survive alongside the new, shorter set.
            await fs.rm(targetDir, { recursive: true, force: true });
            await fs.rename(stagingDir, targetDir);
            return { exported: pages.length, skipped: false, dir: targetDir };
        }
        finally {
            await fs.rm(stagingDir, { recursive: true, force: true });
        }
    }
}
