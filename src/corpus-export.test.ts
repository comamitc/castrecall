import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ListenRecord, Provenance } from "./storage.js";
import { CorpusExporter, buildCorpusPages, slugify, splitSections } from "./corpus-export.js";

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
        new RegExp(`^podcasts/example-show/episode-one-a-deep-dive/${nn}-[a-z0-9-]+\\.md$`),
      );
    }
    expect(indexPage?.relativePath).toBe(
      "podcasts/example-show/episode-one-a-deep-dive/index.md",
    );
  });

  it("gives a non-empty fallback show/episode slug for all-symbol titles", () => {
    const pages = buildCorpusPages({
      record: { ...RECORD, podcastTitle: "!!!", title: "???" },
      provenance: PROVENANCE,
      text: "Body text.",
      contentHash: "hash",
    });
    for (const page of pages) {
      expect(page.relativePath).toMatch(/^podcasts\/show\/episode\//);
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
    expect(files.every((f) => f.includes("podcasts/example-show/episode-one-a-deep-dive"))).toBe(
      true,
    );
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
      path.join(dir, "podcasts/example-show/episode-one-a-deep-dive/index.md"),
      "utf8",
    );
    expect(indexContent).toContain('content_hash: "hash-b"');
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
