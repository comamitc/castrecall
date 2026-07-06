import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ListenRecord, Provenance } from "./storage.js";
import { CorpusExporter, buildCorpusPages, slugify, splitSections } from "./corpus-export.js";

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
