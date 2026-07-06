import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ListenRecord, Provenance } from "./storage.js";
import type { TranscriptSegment } from "./transcripts/normalize.js";
import {
  CorpusExporter,
  buildCorpusPages,
  distinctSpeakers,
  formatTimecode,
  sectionTimestamps,
  slugify,
  splitSectionRanges,
  splitSections,
} from "./corpus-export.js";

// Deterministic sha256("ep-1").slice(0, 8) disambiguator the exporter appends
// to RECORD's episode slug (see episodeDirSlug in corpus-export.ts).
const EP1_DIR = "episode-one-a-deep-dive-25422834";

const RECORD: ListenRecord = {
  uuid: "ep-1",
  title: "Episode One: A Deep Dive",
  podcastUuid: "pod-1",
  podcastTitle: "Example Show",
  audioUrl: "https://cdn.example.com/ep1.mp3",
  firstSeenAt: "2026-07-04T00:00:00Z",
  transcriptStatus: "stored",
  updatedAt: "2026-07-04T00:00:00Z",
};

const PROVENANCE: Provenance = {
  platform: "pocketcasts",
  podcastTitle: "Example Show",
  podcastUuid: "pod-1",
  episodeTitle: "Episode One: A Deep Dive",
  episodeUuid: "ep-1",
  episodeUrl: "https://example.com/ep1",
  audioUrl: "https://cdn.example.com/ep1.mp3",
  transcriptSource: "rss",
  format: "vtt",
  fetchedAt: "2026-07-04T00:00:00Z",
  privacyClass: "private-source",
};

function paragraph(words: number, seed: string): string {
  return Array.from({ length: words }, (_, i) => `${seed}${i}`).join(" ");
}

describe("formatTimecode", () => {
  it("formats seconds as HH:MM:SS, rounding and supporting durations over an hour", () => {
    expect(formatTimecode(0)).toBe("00:00:00");
    expect(formatTimecode(90.5)).toBe("00:01:31");
    expect(formatTimecode(3661)).toBe("01:01:01");
  });
});

describe("sectionTimestamps", () => {
  function seg(text: string, startSeconds?: number, endSeconds?: number): TranscriptSegment {
    return { text, startSeconds, endSeconds };
  }

  it("returns all-undefined entries when there is no usable timing signal", () => {
    expect(sectionTimestamps(undefined, [{ start: 0, end: 10 }], 10)).toEqual([{}]);
    expect(sectionTimestamps([seg("hi")], [{ start: 0, end: 2 }], 2)).toEqual([{}]);
    expect(sectionTimestamps([seg("hi", 0, 1)], [], 2)).toEqual([]);
    expect(sectionTimestamps([seg("hi", 0, 1)], [{ start: 0, end: 0 }], 0)).toEqual([{}]);
  });

  it("interpolates proportionally and clamps to the final segment's endSeconds past the timed range", () => {
    const segments = [seg("AAAA", 0, 4), seg("BBBB", 4, 8), seg("CCCC", 8, 12)];
    const ranges = [
      { start: 0, end: 4 },
      { start: 4, end: 8 },
      { start: 8, end: 12 },
    ];
    const result = sectionTimestamps(segments, ranges, 12);
    expect(result).toEqual([
      { approxStart: 0, approxEnd: 4 },
      { approxStart: 4, approxEnd: 8 },
      { approxStart: 8, approxEnd: 12 },
    ]);
  });

  it("yields undefined (never NaN) for a section mapping into a gap left by an untimed middle segment, and stays monotonic", () => {
    const segments = [seg("AAAA", 0, 4), seg("BBBB"), seg("CCCC", 8, 12)];
    const ranges = [
      { start: 0, end: 4 },
      { start: 5, end: 7 },
      { start: 8, end: 12 },
    ];
    const result = sectionTimestamps(segments, ranges, 12);
    expect(result[0]).toEqual({ approxStart: 0, approxEnd: 4 });
    expect(result[1]).toEqual({ approxStart: undefined, approxEnd: undefined });
    expect(result[2]).toEqual({ approxStart: 8, approxEnd: 12 });
    for (const entry of result) {
      if (entry.approxStart !== undefined) expect(Number.isNaN(entry.approxStart)).toBe(false);
      if (entry.approxEnd !== undefined) expect(Number.isNaN(entry.approxEnd)).toBe(false);
    }
  });
});

describe("slugify", () => {
  it("kebab-cases normal titles", () => {
    expect(slugify("Episode One: A Deep Dive", "x")).toBe("episode-one-a-deep-dive");
  });

  it("strips unicode diacritics and punctuation", () => {
    expect(slugify("Café — Déjà Vu!! (Part 2)", "x")).toBe("cafe-deja-vu-part-2");
  });

  it("falls back to the given default for an all-symbol input", () => {
    expect(slugify("*** !!! ---", "fallback")).toBe("fallback");
  });

  it("falls back for an empty string", () => {
    expect(slugify("", "fallback")).toBe("fallback");
  });

  it("truncates long titles without a trailing hyphen", () => {
    const long = "word ".repeat(40).trim();
    const slug = slugify(long, "x");
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("splitSectionRanges", () => {
  it("produces ranges whose slices equal splitSections' output", () => {
    const text = `Intro paragraph with some words.\n\nSecond paragraph continues the idea further.\n\nThird and final paragraph wraps up.`;
    const ranges = splitSectionRanges(text, { targetWords: 5, maxWords: 8 });
    expect(ranges.map((r) => text.slice(r.start, r.end))).toEqual(splitSections(text, { targetWords: 5, maxWords: 8 }));
  });
});

describe("splitSections", () => {
  it("splits a multi-paragraph transcript into ordered sections within the cap", () => {
    const paragraphs = Array.from({ length: 12 }, (_, i) => paragraph(50, `p${i}-w`));
    const text = paragraphs.join("\n\n");
    const sections = splitSections(text, { targetWords: 150, maxWords: 200 });
    expect(sections.length).toBeGreaterThanOrEqual(3);
    for (const section of sections) {
      expect(section.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(200);
    }
    // Sections are ordered and verbatim: rejoining recovers the original text.
    expect(sections.join("\n\n").length).toBeLessThanOrEqual(text.length + sections.length * 2);
    expect(text).toContain(sections[0]);
    expect(text).toContain(sections[sections.length - 1]);
  });

  it("falls back to sentence chunking for one giant paragraph with no blank lines", () => {
    const sentences = Array.from({ length: 200 }, (_, i) => `This is sentence number ${i}.`);
    const text = sentences.join(" ");
    const sections = splitSections(text, { targetWords: 150, maxWords: 200 });
    expect(sections.length).toBeGreaterThan(1);
    for (const section of sections) {
      expect(section.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(200);
    }
  });

  it("hard-splits a single unbroken blob with no punctuation at all", () => {
    const words = Array.from({ length: 5000 }, (_, i) => `word${i}`);
    const text = words.join(" ");
    const sections = splitSections(text, { targetWords: 1500, maxWords: 2000 });
    expect(sections.length).toBeGreaterThanOrEqual(3);
    for (const section of sections) {
      expect(section.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(2000);
    }
    // Sections are verbatim slices; single-space word separators at section
    // boundaries are the only characters dropped (they belong to neither
    // section), so rejoining with a space recovers the original text.
    expect(sections.join(" ")).toBe(text);
  });

  it("produces section bodies that are exact verbatim slices of the source", () => {
    const text = `Intro paragraph with some words.\n\nSecond paragraph continues the idea further.\n\nThird and final paragraph wraps up.`;
    const sections = splitSections(text, { targetWords: 5, maxWords: 8 });
    for (const section of sections) {
      expect(text.includes(section)).toBe(true);
    }
  });

  it("returns the text unchanged for empty/whitespace-only input", () => {
    expect(splitSections("   \n\n  ")).toEqual(["   \n\n  "]);
  });
});

describe("buildCorpusPages", () => {
  it("emits generated: false and the stamped content hash on every page", () => {
    const pages = buildCorpusPages({
      record: RECORD,
      provenance: PROVENANCE,
      text: "Some short transcript body text for a single section.",
      contentHash: "abc123",
    });
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      expect(page.content).toContain("generated: false");
      expect(page.content).toContain('content_hash: "abc123"');
    }
  });

  it("omits audio_url and episode_url when absent instead of emitting empty values", () => {
    const pages = buildCorpusPages({
      record: RECORD,
      provenance: { ...PROVENANCE, audioUrl: undefined, episodeUrl: undefined },
      text: "Body text.",
      contentHash: "hash",
    });
    for (const page of pages) {
      expect(page.content).not.toContain("audio_url:");
      expect(page.content).not.toContain("episode_url:");
    }
  });

  it("round-trips a colon-bearing title safely quoted", () => {
    const pages = buildCorpusPages({
      record: RECORD,
      provenance: PROVENANCE,
      text: "Body text.",
      contentHash: "hash",
    });
    const withTitle = pages.find((p) => p.content.includes('title: "Episode One'));
    expect(withTitle).toBeDefined();
  });

  it("lays out relative paths as podcasts/<show>/<episode>/<nn>-<slug>.md plus an index page", () => {
    const longText = Array.from({ length: 10 }, (_, i) => paragraph(60, `s${i}-w`)).join("\n\n");
    const pages = buildCorpusPages({
      record: RECORD,
      provenance: PROVENANCE,
      text: longText,
      contentHash: "hash",
      targetWords: 150,
      maxWords: 200,
    });
    const sectionPages = pages.filter((p) => !p.relativePath.endsWith("index.md"));
    const indexPage = pages.find((p) => p.relativePath.endsWith("index.md"));
    expect(indexPage).toBeDefined();
    expect(sectionPages.length).toBeGreaterThanOrEqual(1);
    for (const [i, page] of sectionPages.entries()) {
      const nn = String(i + 1).padStart(2, "0");
      expect(page.relativePath).toMatch(
        new RegExp(`^podcasts/example-show/${EP1_DIR}/${nn}-[a-z0-9-]+\\.md$`),
      );
    }
    expect(indexPage?.relativePath).toBe(`podcasts/example-show/${EP1_DIR}/index.md`);
  });

  it("gives a non-empty fallback show/episode slug for all-symbol titles", () => {
    const pages = buildCorpusPages({
      record: { ...RECORD, podcastTitle: "!!!", title: "???" },
      provenance: PROVENANCE,
      text: "Body text.",
      contentHash: "hash",
    });
    for (const page of pages) {
      expect(page.relativePath).toMatch(/^podcasts\/show\/episode-[0-9a-f]{8}\//);
    }
  });

  it("disambiguates two episodes whose titles collapse to the same fallback slug", () => {
    const first = buildCorpusPages({
      record: { ...RECORD, uuid: "ep-a", title: "???" },
      provenance: PROVENANCE,
      text: "Body text one.",
      contentHash: "hash",
    });
    const second = buildCorpusPages({
      record: { ...RECORD, uuid: "ep-b", title: "!!!" },
      provenance: PROVENANCE,
      text: "Body text two.",
      contentHash: "hash",
    });
    const firstDir = first[0].relativePath.split("/")[2];
    const secondDir = second[0].relativePath.split("/")[2];
    expect(firstDir).not.toBe(secondDir);
  });

  it("surfaces exact local-whisper generation provenance in frontmatter when present (issue #54)", () => {
    const pages = buildCorpusPages({
      record: RECORD,
      provenance: {
        ...PROVENANCE,
        transcriptSource: "local-whisper",
        generation: {
          kind: "local-whisper",
          backend: "mlx-whisper",
          model: "mlx-community/whisper-large-v3-turbo",
          modelSource: "preset",
          usesBackendDefault: false,
          preset: "best",
          outputFormat: "json",
          wordTimestamps: true,
          decode: {
            applied: { conditionOnPreviousText: false, wordTimestamps: true },
            ignored: [{ option: "noSpeechThreshold", reason: "not configured" }],
          },
          toolVersion: "mlx_whisper 1.2.3",
        },
      },
      text: "Body text.",
      contentHash: "hash",
    });
    for (const page of pages) {
      expect(page.content).toContain('transcript_backend: "mlx-whisper"');
      expect(page.content).toContain('transcript_model: "mlx-community/whisper-large-v3-turbo"');
      expect(page.content).toContain('transcript_model_source: "preset"');
      expect(page.content).toContain('transcript_preset: "best"');
      expect(page.content).toContain('transcript_output_format: "json"');
      expect(page.content).toContain("transcript_word_timestamps: true");
      expect(page.content).toContain("transcript_decode_options:");
      expect(page.content).toContain("conditionOnPreviousText");
      expect(page.content).toContain("transcript_decode_ignored:");
      expect(page.content).toContain("noSpeechThreshold");
      expect(page.content).toContain('transcript_tool_version: "mlx_whisper 1.2.3"');
    }
  });

  it("omits every transcript_* generation line for a legacy provenance with no generation", () => {
    const pages = buildCorpusPages({
      record: RECORD,
      provenance: PROVENANCE,
      text: "Body text.",
      contentHash: "hash",
    });
    for (const page of pages) {
      expect(page.content).not.toContain("transcript_backend:");
      expect(page.content).not.toContain("transcript_model:");
      expect(page.content).not.toContain("transcript_model_source:");
      expect(page.content).not.toContain("transcript_preset:");
      expect(page.content).not.toContain("transcript_output_format:");
      expect(page.content).not.toContain("transcript_word_timestamps:");
      expect(page.content).not.toContain("transcript_decode_options:");
      expect(page.content).not.toContain("transcript_decode_ignored:");
      expect(page.content).not.toContain("transcript_tool_version:");
    }
  });

  it("surfaces transcript quality score/tier/reasons in frontmatter when present (issue #41)", () => {
    const pages = buildCorpusPages({
      record: RECORD,
      provenance: {
        ...PROVENANCE,
        quality: { score: 82, tier: "reviewable", reasons: ["no-speaker-labels", "no-timestamps"] },
      },
      text: "Body text.",
      contentHash: "hash",
    });
    for (const page of pages) {
      expect(page.content).toContain("transcript_quality_score: 82");
      expect(page.content).toContain('transcript_quality_tier: "reviewable"');
      expect(page.content).toContain('transcript_quality_reasons: ["no-speaker-labels","no-timestamps"]');
    }
  });

  it("omits every transcript_quality_* line for a legacy provenance with no quality", () => {
    const pages = buildCorpusPages({
      record: RECORD,
      provenance: PROVENANCE,
      text: "Body text.",
      contentHash: "hash",
    });
    for (const page of pages) {
      expect(page.content).not.toContain("transcript_quality_score:");
      expect(page.content).not.toContain("transcript_quality_tier:");
      expect(page.content).not.toContain("transcript_quality_reasons:");
    }
  });

  it("computes approximate section timestamps from segments (issue #43): quoted frontmatter plus index timecode suffixes", () => {
    const longText = Array.from({ length: 10 }, (_, i) => paragraph(60, `s${i}-w`)).join("\n\n");
    const half = Math.floor(longText.length / 2);
    const segments: TranscriptSegment[] = [
      { text: longText.slice(0, half), startSeconds: 0, endSeconds: 100 },
      { text: longText.slice(half), startSeconds: 100, endSeconds: 200 },
    ];
    const pages = buildCorpusPages({
      record: RECORD,
      provenance: PROVENANCE,
      text: longText,
      contentHash: "hash",
      targetWords: 150,
      maxWords: 200,
      segments,
    });
    const sectionPages = pages.filter((p) => !p.relativePath.endsWith("index.md"));
    const indexPage = pages.find((p) => p.relativePath.endsWith("index.md"))!;
    expect(sectionPages.length).toBeGreaterThan(1);
    for (const page of sectionPages) {
      expect(page.content).toMatch(/approx_start: "\d{2}:\d{2}:\d{2}"/);
      expect(page.content).toMatch(/approx_end: "\d{2}:\d{2}:\d{2}"/);
    }
    expect(indexPage.content).toContain('approx_start: "00:00:00"');
    expect(indexPage.content).toContain('approx_end: "00:03:20"');
    expect(indexPage.content).toMatch(/\[.+\]\(.+\) — \d{2}:\d{2}:\d{2}/);
  });

  it("omits approx_start/approx_end entirely when segments are not supplied (backward compatible)", () => {
    const pages = buildCorpusPages({
      record: RECORD,
      provenance: PROVENANCE,
      text: "Body text.",
      contentHash: "hash",
    });
    for (const page of pages) {
      expect(page.content).not.toContain("approx_start:");
      expect(page.content).not.toContain("approx_end:");
    }
  });

  it("always emits approx_start and approx_end on index.md together, never one without the other", () => {
    const withSegments = buildCorpusPages({
      record: RECORD,
      provenance: PROVENANCE,
      text: "Body text for timing.",
      contentHash: "hash",
      segments: [{ text: "Body text for timing.", startSeconds: 5, endSeconds: 15 }],
    });
    const withIndex = withSegments.find((p) => p.relativePath.endsWith("index.md"))!;
    expect(withIndex.content).toContain("approx_start:");
    expect(withIndex.content).toContain("approx_end:");

    const withoutSegments = buildCorpusPages({
      record: RECORD,
      provenance: PROVENANCE,
      text: "Body text for timing.",
      contentHash: "hash",
    });
    const withoutIndex = withoutSegments.find((p) => p.relativePath.endsWith("index.md"))!;
    expect(withoutIndex.content).not.toContain("approx_start:");
    expect(withoutIndex.content).not.toContain("approx_end:");
  });

  it("never emits NaN and keeps section approx_start non-decreasing when a middle segment has no timing", () => {
    const longText = Array.from({ length: 10 }, (_, i) => paragraph(60, `m${i}-w`)).join("\n\n");
    const third = Math.floor(longText.length / 3);
    const segments: TranscriptSegment[] = [
      { text: longText.slice(0, third), startSeconds: 0, endSeconds: 50 },
      { text: longText.slice(third, third * 2) },
      { text: longText.slice(third * 2), startSeconds: 100, endSeconds: 150 },
    ];
    const pages = buildCorpusPages({
      record: RECORD,
      provenance: PROVENANCE,
      text: longText,
      contentHash: "hash",
      targetWords: 150,
      maxWords: 200,
      segments,
    });
    const sectionPages = pages.filter((p) => !p.relativePath.endsWith("index.md"));
    const starts: number[] = [];
    for (const page of sectionPages) {
      expect(page.content).not.toContain("NaN");
      const match = page.content.match(/approx_start: "(\d{2}):(\d{2}):(\d{2})"/);
      if (match) starts.push(Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]));
    }
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]).toBeGreaterThanOrEqual(starts[i - 1]);
    }
  });
});

describe("distinctSpeakers", () => {
  it("returns ordered, de-duplicated speaker labels", () => {
    const segments: TranscriptSegment[] = [
      { text: "a", speaker: "Alice" },
      { text: "b", speaker: "Bob" },
      { text: "c", speaker: "Alice" },
    ];
    expect(distinctSpeakers(segments)).toEqual(["Alice", "Bob"]);
  });

  it("excludes empty/whitespace speaker strings and returns [] for undefined/speaker-less segments", () => {
    expect(distinctSpeakers(undefined)).toEqual([]);
    expect(distinctSpeakers([{ text: "a" }, { text: "b", speaker: "   " }])).toEqual([]);
  });
});

describe("buildCorpusPages speaker frontmatter (issue #44)", () => {
  it("emits a speakers: line on both a section page and index.md when segments carry distinct speakers", () => {
    const segments: TranscriptSegment[] = [
      { text: "Hello.", speaker: "Alice" },
      { text: "Hi back.", speaker: "Bob" },
    ];
    const pages = buildCorpusPages({
      record: RECORD,
      provenance: PROVENANCE,
      text: "Hello. Hi back.",
      contentHash: "hash",
      segments,
    });
    for (const page of pages) {
      expect(page.content).toContain('speakers: ["Alice","Bob"]');
    }
  });

  it("omits the speakers: line entirely when segments carry no speaker labels", () => {
    const pages = buildCorpusPages({
      record: RECORD,
      provenance: PROVENANCE,
      text: "Some transcript text.",
      contentHash: "hash",
      segments: [{ text: "Some transcript text." }],
    });
    for (const page of pages) {
      expect(page.content).not.toContain("speakers:");
    }
  });
});

describe("CorpusExporter", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "castrecall-export-test-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function listFiles(root: string): Promise<string[]> {
    const out: string[] = [];
    async function walk(current: string) {
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else {
          out.push(path.relative(root, full));
        }
      }
    }
    await walk(root).catch(() => {});
    return out.sort();
  }

  it("exports the expected file tree for a fresh episode", async () => {
    const exporter = new CorpusExporter(dir);
    const longText = Array.from({ length: 6 }, (_, i) => paragraph(60, `w${i}-`)).join("\n\n");
    const result = await exporter.exportEpisode({
      record: RECORD,
      provenance: PROVENANCE,
      text: longText,
      contentHash: "hash-1",
    });
    expect(result.skipped).toBe(false);
    expect(result.exported).toBeGreaterThan(0);
    const files = await listFiles(dir);
    expect(files.some((f) => f.endsWith("index.md"))).toBe(true);
    expect(files.every((f) => f.includes(`podcasts/example-show/${EP1_DIR}`))).toBe(true);
  });

  it("is idempotent: re-exporting the same content hash writes nothing", async () => {
    const exporter = new CorpusExporter(dir);
    await exporter.exportEpisode({
      record: RECORD,
      provenance: PROVENANCE,
      text: "Some transcript text.",
      contentHash: "stable-hash",
    });
    const before = await listFiles(dir);
    const beforeStats = await Promise.all(
      before.map(async (f) => [f, (await fs.stat(path.join(dir, f))).mtimeMs] as const),
    );

    const second = await exporter.exportEpisode({
      record: RECORD,
      provenance: PROVENANCE,
      text: "Some transcript text.",
      contentHash: "stable-hash",
    });
    expect(second.skipped).toBe(true);
    expect(second.exported).toBe(0);

    const after = await listFiles(dir);
    expect(after).toEqual(before);
    for (const [f, mtime] of beforeStats) {
      expect((await fs.stat(path.join(dir, f))).mtimeMs).toBe(mtime);
    }
  });

  it("re-exports on an unchanged content hash to backfill quality frontmatter missing from a pre-upgrade export (issue #41)", async () => {
    const exporter = new CorpusExporter(dir);
    await exporter.exportEpisode({
      record: RECORD,
      provenance: PROVENANCE,
      text: "Some transcript text.",
      contentHash: "stable-hash",
    });
    const beforeIndex = await fs.readFile(path.join(dir, "podcasts", "example-show", EP1_DIR, "index.md"), "utf8");
    expect(beforeIndex).not.toContain("transcript_quality_score:");

    const second = await exporter.exportEpisode({
      record: RECORD,
      provenance: { ...PROVENANCE, quality: { score: 82, tier: "reviewable", reasons: ["no-timestamps"] } },
      text: "Some transcript text.",
      contentHash: "stable-hash",
    });
    expect(second.skipped).toBe(false);
    expect(second.exported).toBeGreaterThan(0);

    const afterIndex = await fs.readFile(path.join(dir, "podcasts", "example-show", EP1_DIR, "index.md"), "utf8");
    expect(afterIndex).toContain("transcript_quality_score: 82");

    const third = await exporter.exportEpisode({
      record: RECORD,
      provenance: { ...PROVENANCE, quality: { score: 82, tier: "reviewable", reasons: ["no-timestamps"] } },
      text: "Some transcript text.",
      contentHash: "stable-hash",
    });
    expect(third.skipped).toBe(true);
  });

  it("re-exports on an unchanged content hash when quality is rescored, so frontmatter never goes stale (issue #41)", async () => {
    const exporter = new CorpusExporter(dir);
    await exporter.exportEpisode({
      record: RECORD,
      provenance: { ...PROVENANCE, quality: { score: 82, tier: "reviewable", reasons: ["no-timestamps"] } },
      text: "Some transcript text.",
      contentHash: "stable-hash",
    });
    const beforeIndex = await fs.readFile(path.join(dir, "podcasts", "example-show", EP1_DIR, "index.md"), "utf8");
    expect(beforeIndex).toContain("transcript_quality_score: 82");

    const second = await exporter.exportEpisode({
      record: RECORD,
      provenance: { ...PROVENANCE, quality: { score: 55, tier: "search-only", reasons: ["no-timestamps", "no-speaker-labels"] } },
      text: "Some transcript text.",
      contentHash: "stable-hash",
    });
    expect(second.skipped).toBe(false);
    expect(second.exported).toBeGreaterThan(0);

    const afterIndex = await fs.readFile(path.join(dir, "podcasts", "example-show", EP1_DIR, "index.md"), "utf8");
    expect(afterIndex).toContain("transcript_quality_score: 55");
    expect(afterIndex).toContain('transcript_quality_tier: "search-only"');
    expect(afterIndex).toContain('transcript_quality_reasons: ["no-timestamps","no-speaker-labels"]');
  });

  it("never erases an already-scored export when legacy provenance without quality re-exports the same hash (issue #41 review)", async () => {
    const exporter = new CorpusExporter(dir);
    await exporter.exportEpisode({
      record: RECORD,
      provenance: { ...PROVENANCE, quality: { score: 82, tier: "reviewable", reasons: ["no-timestamps"] } },
      text: "Some transcript text.",
      contentHash: "stable-hash",
    });
    const beforeIndex = await fs.readFile(path.join(dir, "podcasts", "example-show", EP1_DIR, "index.md"), "utf8");
    expect(beforeIndex).toContain("transcript_quality_score: 82");

    // A pre-#41 sidecar carries no quality field. Re-exporting the same
    // content with it must NOT count the scored page as stale — that would
    // rewrite the page without any transcript_quality_* lines and destroy
    // the only machine-readable quality signal consumers have.
    const legacy = await exporter.exportEpisode({
      record: RECORD,
      provenance: PROVENANCE,
      text: "Some transcript text.",
      contentHash: "stable-hash",
    });
    expect(legacy.skipped).toBe(true);
    expect(legacy.exported).toBe(0);

    const afterIndex = await fs.readFile(path.join(dir, "podcasts", "example-show", EP1_DIR, "index.md"), "utf8");
    expect(afterIndex).toContain("transcript_quality_score: 82");
  });

  it("re-exports on an unchanged content hash to backfill timestamps once segments become available, then settles (issue #43)", async () => {
    const exporter = new CorpusExporter(dir);
    await exporter.exportEpisode({
      record: RECORD,
      provenance: PROVENANCE,
      text: "Some transcript text.",
      contentHash: "stable-hash",
    });
    const beforeIndex = await fs.readFile(path.join(dir, "podcasts", "example-show", EP1_DIR, "index.md"), "utf8");
    expect(beforeIndex).not.toContain("approx_start:");

    const segments: TranscriptSegment[] = [{ text: "Some transcript text.", startSeconds: 0, endSeconds: 10 }];
    const second = await exporter.exportEpisode({
      record: RECORD,
      provenance: PROVENANCE,
      text: "Some transcript text.",
      contentHash: "stable-hash",
      segments,
    });
    expect(second.skipped).toBe(false);
    expect(second.exported).toBeGreaterThan(0);

    const afterIndex = await fs.readFile(path.join(dir, "podcasts", "example-show", EP1_DIR, "index.md"), "utf8");
    expect(afterIndex).toContain("approx_start:");
    expect(afterIndex).toContain("approx_end:");

    const third = await exporter.exportEpisode({
      record: RECORD,
      provenance: PROVENANCE,
      text: "Some transcript text.",
      contentHash: "stable-hash",
      segments,
    });
    expect(third.skipped).toBe(true);
  });

  it("stays idempotent on an unchanged content hash when segments only carry partial timing that can never emit approx_start (issue #43 review)", async () => {
    const exporter = new CorpusExporter(dir);
    await exporter.exportEpisode({
      record: RECORD,
      provenance: PROVENANCE,
      text: "Some transcript text.",
      contentHash: "stable-hash",
    });

    const partialSegments: TranscriptSegment[] = [{ text: "Some transcript text.", startSeconds: 0 }];
    const second = await exporter.exportEpisode({
      record: RECORD,
      provenance: PROVENANCE,
      text: "Some transcript text.",
      contentHash: "stable-hash",
      segments: partialSegments,
    });
    expect(second.skipped).toBe(true);

    const third = await exporter.exportEpisode({
      record: RECORD,
      provenance: PROVENANCE,
      text: "Some transcript text.",
      contentHash: "stable-hash",
      segments: partialSegments,
    });
    expect(third.skipped).toBe(true);
  });

  it("re-exports on an unchanged content hash to backfill speakers once segments carry them, then settles (issue #44)", async () => {
    const exporter = new CorpusExporter(dir);
    await exporter.exportEpisode({
      record: RECORD,
      provenance: PROVENANCE,
      text: "Some transcript text.",
      contentHash: "stable-hash",
    });
    const beforeIndex = await fs.readFile(path.join(dir, "podcasts", "example-show", EP1_DIR, "index.md"), "utf8");
    expect(beforeIndex).not.toContain("speakers:");

    const segments: TranscriptSegment[] = [{ text: "Some transcript text.", speaker: "Alice" }];
    const second = await exporter.exportEpisode({
      record: RECORD,
      provenance: PROVENANCE,
      text: "Some transcript text.",
      contentHash: "stable-hash",
      segments,
    });
    expect(second.skipped).toBe(false);
    expect(second.exported).toBeGreaterThan(0);

    const afterIndex = await fs.readFile(path.join(dir, "podcasts", "example-show", EP1_DIR, "index.md"), "utf8");
    expect(afterIndex).toContain('speakers: ["Alice"]');

    const third = await exporter.exportEpisode({
      record: RECORD,
      provenance: PROVENANCE,
      text: "Some transcript text.",
      contentHash: "stable-hash",
      segments,
    });
    expect(third.skipped).toBe(true);
  });

  it("stays idempotent on an unchanged content hash when segments carry no speaker labels (local Whisper — issue #44)", async () => {
    const exporter = new CorpusExporter(dir);
    await exporter.exportEpisode({
      record: RECORD,
      provenance: PROVENANCE,
      text: "Some transcript text.",
      contentHash: "stable-hash",
    });

    const speakerlessSegments: TranscriptSegment[] = [{ text: "Some transcript text." }];
    const second = await exporter.exportEpisode({
      record: RECORD,
      provenance: PROVENANCE,
      text: "Some transcript text.",
      contentHash: "stable-hash",
      segments: speakerlessSegments,
    });
    expect(second.skipped).toBe(true);

    const indexContent = await fs.readFile(
      path.join(dir, "podcasts", "example-show", EP1_DIR, "index.md"),
      "utf8",
    );
    expect(indexContent).not.toContain("speakers:");
  });

  it("replaces the episode dir with no stale files when the content hash changes", async () => {
    const exporter = new CorpusExporter(dir);
    const longText = Array.from({ length: 10 }, (_, i) => paragraph(60, `long${i}-`)).join("\n\n");
    await exporter.exportEpisode({
      record: RECORD,
      provenance: PROVENANCE,
      text: longText,
      contentHash: "hash-a",
      targetWords: 100,
      maxWords: 150,
    });
    const firstFiles = await listFiles(dir);
    expect(firstFiles.length).toBeGreaterThan(2);

    const shortText = "A much shorter transcript body.";
    const result = await exporter.exportEpisode({
      record: RECORD,
      provenance: PROVENANCE,
      text: shortText,
      contentHash: "hash-b",
    });
    expect(result.skipped).toBe(false);

    const secondFiles = await listFiles(dir);
    // Only index.md + one section file should remain — none of the many
    // section files from the longer first transcript survive.
    expect(secondFiles.length).toBeLessThan(firstFiles.length);
    const staleSectionFiles = firstFiles.filter((f) => !f.endsWith("index.md"));
    for (const stale of staleSectionFiles) {
      expect(secondFiles).not.toContain(stale);
    }
    const indexContent = await fs.readFile(
      path.join(dir, `podcasts/example-show/${EP1_DIR}/index.md`),
      "utf8",
    );
    expect(indexContent).toContain('content_hash: "hash-b"');
  });

  it("keeps distinct episode directories for two episodes with colliding fallback slugs", async () => {
    const exporter = new CorpusExporter(dir);
    await exporter.exportEpisode({
      record: { ...RECORD, uuid: "ep-a", title: "???" },
      provenance: PROVENANCE,
      text: "First colliding episode.",
      contentHash: "hash-first",
    });
    const result = await exporter.exportEpisode({
      record: { ...RECORD, uuid: "ep-b", title: "!!!" },
      provenance: PROVENANCE,
      text: "Second colliding episode.",
      contentHash: "hash-second",
    });
    expect(result.skipped).toBe(false);

    // Both episodes fall back to the "episode" slug but carry distinct
    // uuids, so each must keep — not overwrite — its own directory.
    const firstIndex = await fs.readFile(
      path.join(dir, "podcasts/example-show/episode-152a27ea/index.md"),
      "utf8",
    );
    const secondIndex = await fs.readFile(
      path.join(dir, "podcasts/example-show/episode-455a9080/index.md"),
      "utf8",
    );
    expect(firstIndex).toContain('content_hash: "hash-first"');
    expect(secondIndex).toContain('content_hash: "hash-second"');
  });

  it("restores the previous export if promotion fails after the old dir is moved aside", async () => {
    const exporter = new CorpusExporter(dir);
    await exporter.exportEpisode({
      record: RECORD,
      provenance: PROVENANCE,
      text: "Original good export.",
      contentHash: "hash-good",
    });
    const episodeDir = path.join(dir, `podcasts/example-show/${EP1_DIR}`);
    const goodIndex = await fs.readFile(path.join(episodeDir, "index.md"), "utf8");
    expect(goodIndex).toContain('content_hash: "hash-good"');

    // Fail only the second rename of the promotion (staging -> target),
    // letting the first (target -> backup) succeed for real, so this
    // exercises "backup made, promotion failed" — not a backup-step failure.
    const realRename = fs.rename.bind(fs);
    let renameCalls = 0;
    const renameSpy = vi
      .spyOn(fs, "rename")
      .mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
        renameCalls += 1;
        if (renameCalls === 2) throw new Error("simulated disk failure during promotion");
        return realRename(...args);
      });

    await expect(
      exporter.exportEpisode({
        record: RECORD,
        provenance: PROVENANCE,
        text: "New export that never lands.",
        contentHash: "hash-new",
      }),
    ).rejects.toThrow("simulated disk failure during promotion");

    renameSpy.mockRestore();

    const survivingIndex = await fs.readFile(path.join(episodeDir, "index.md"), "utf8");
    expect(survivingIndex).toContain('content_hash: "hash-good"');
  });

  it("never writes state.json, review/ paths, or pending-review status under the export dir", async () => {
    const exporter = new CorpusExporter(dir);
    const longText = Array.from({ length: 6 }, (_, i) => paragraph(60, `x${i}-`)).join("\n\n");
    await exporter.exportEpisode({
      record: RECORD,
      provenance: PROVENANCE,
      text: longText,
      contentHash: "hash-scan",
    });
    const files = await listFiles(dir);
    for (const f of files) {
      expect(f).not.toBe("state.json");
      expect(f).not.toMatch(/(^|\/)review\//);
      const content = await fs.readFile(path.join(dir, f), "utf8");
      expect(content).not.toContain("status: pending-review");
    }
  });
});
