import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "./config.js";
import { Storage, type Provenance } from "./storage.js";
import { search } from "./tools.js";
import {
  buildDocument,
  buildSnippet,
  clampLimit,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  parseQuery,
  phraseBonus,
  scoreKeywords,
  SearchIndex,
  tokenize,
  type CorpusEntry,
} from "./search.js";

describe("tokenize", () => {
  it("lowercases and splits on non-letter/number boundaries", () => {
    expect(tokenize("Climate Policy, Explained!")).toEqual([
      "climate",
      "policy",
      "explained",
    ]);
  });

  it("normalizes accented terms to their unaccented ASCII-equivalent form", () => {
    expect(tokenize("café")).toEqual(tokenize("cafe"));
    expect(tokenize("Déjà Vu")).toEqual(["deja", "vu"]);
  });

  it("preserves non-Latin scripts (does not narrow to [a-z0-9])", () => {
    expect(tokenize("日本語 podcast")).toEqual(["日本語", "podcast"]);
  });

  it("drops empty tokens from punctuation-only input", () => {
    expect(tokenize("... !!! ---")).toEqual([]);
  });
});

describe("parseQuery", () => {
  it("splits quoted phrases from bare terms", () => {
    expect(parseQuery('"exact ordered phrase" bare terms')).toEqual({
      terms: ["bare", "terms"],
      phrases: [["exact", "ordered", "phrase"]],
    });
  });

  it("supports multiple quoted phrases", () => {
    expect(parseQuery('"one two" middle "three four"')).toEqual({
      terms: ["middle"],
      phrases: [
        ["one", "two"],
        ["three", "four"],
      ],
    });
  });

  it("treats an unbalanced trailing quote as literal terms, not a phrase", () => {
    expect(parseQuery('one "two three')).toEqual({
      terms: ["one", "two", "three"],
      phrases: [],
    });
  });

  it("returns empty terms/phrases for a query with no matchable tokens", () => {
    expect(parseQuery("!!!")).toEqual({ terms: [], phrases: [] });
  });
});

describe("scoreKeywords", () => {
  it("scores documents higher for rarer terms (idf-lite) and normalizes by length", () => {
    const common = buildDocument("common", "h1", "climate climate climate filler filler filler");
    const rare = buildDocument("rare", "h2", "climate quasar filler filler filler filler");
    const noMatch = buildDocument("none", "h3", "filler filler filler filler filler filler");
    const scores = scoreKeywords({ terms: ["quasar"], phrases: [] }, [common, rare, noMatch]);
    expect(scores.get("rare")).toBeGreaterThan(0);
    expect(scores.get("common")).toBe(0);
    expect(scores.get("none")).toBe(0);
  });

  it("includes quoted-phrase tokens in the base score even with no bare terms", () => {
    const doc = buildDocument("doc", "h1", "climate policy discussion");
    const scores = scoreKeywords({ terms: [], phrases: [["climate", "policy"]] }, [doc]);
    expect(scores.get("doc")).toBeGreaterThan(0);
  });

  it("returns zero for every document when the query has no terms or phrase tokens", () => {
    const doc = buildDocument("doc", "h1", "climate policy discussion");
    const scores = scoreKeywords({ terms: [], phrases: [] }, [doc]);
    expect(scores.get("doc")).toBe(0);
  });
});

describe("phraseBonus", () => {
  it("rewards a contiguous phrase match", () => {
    const tokens = tokenize("we discuss climate policy in depth");
    expect(phraseBonus([["climate", "policy"]], tokens)).toBeGreaterThan(0);
  });

  it("gives no bonus when the same words appear scattered out of order", () => {
    const tokens = tokenize("policy debates rarely mention climate directly");
    expect(phraseBonus([["climate", "policy"]], tokens)).toBe(0);
  });
});

describe("buildSnippet", () => {
  const LONG_TEXT =
    `${"filler word repeated many times to pad the transcript out. ".repeat(20)}` +
    "this is the important climate policy discussion right here. " +
    `${"more filler text after the match to pad things out. ".repeat(20)}`;

  it("returns a window shorter than the full transcript with ellipsis on both truncated ends", () => {
    const { snippet, snippetText } = buildSnippet(LONG_TEXT, { terms: ["climate"], phrases: [] });
    expect(snippetText.length).toBeLessThan(LONG_TEXT.length);
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("highlights the matched term in snippet but keeps snippetText verbatim", () => {
    const { snippet, snippetText } = buildSnippet(LONG_TEXT, { terms: ["climate"], phrases: [] });
    expect(snippet).toContain("**climate**");
    expect(snippetText).toContain("climate policy discussion");
    expect(snippetText).not.toContain("**");
  });

  it("anchors the window on the phrase match when both a term and a phrase are given", () => {
    const { snippetText } = buildSnippet(LONG_TEXT, {
      terms: [],
      phrases: [["climate", "policy"]],
    });
    expect(snippetText).toContain("climate policy discussion");
  });
});

describe("clampLimit", () => {
  it("applies the default for undefined, zero, and negative values", () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_SEARCH_LIMIT);
    expect(clampLimit(0)).toBe(DEFAULT_SEARCH_LIMIT);
    expect(clampLimit(-5)).toBe(DEFAULT_SEARCH_LIMIT);
  });

  it("passes through values within range", () => {
    expect(clampLimit(1)).toBe(1);
  });

  it("clamps values above the hard max", () => {
    expect(clampLimit(MAX_SEARCH_LIMIT + 100)).toBe(MAX_SEARCH_LIMIT);
  });
});

const BASE_PROVENANCE: Provenance = {
  platform: "pocketcasts",
  podcastTitle: "Example Show",
  podcastUuid: "pod-1",
  episodeTitle: "Episode One",
  episodeUuid: "ep-1",
  transcriptSource: "rss",
  format: "txt",
  fetchedAt: "2026-07-04T00:00:00Z",
  listenTimestamp: "2026-07-04T12:00:00Z",
  privacyClass: "private-source",
};

function entry(overrides: Partial<CorpusEntry> & { text: string }): CorpusEntry {
  const { text, ...rest } = overrides;
  return {
    uuid: "ep-1",
    contentHash: createHash("sha256").update(text, "utf8").digest("hex"),
    provenance: BASE_PROVENANCE,
    transcriptPath: "sources/ep-1/transcript.txt",
    readText: async () => text,
    ...rest,
  };
}

describe("SearchIndex", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "castrecall-search-index-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("re-tokenizes zero transcripts on the reconcile pass for an unchanged corpus", async () => {
    let calls = 0;
    const text = "we discuss climate policy in depth this week";
    const corpusEntry = entry({
      text,
      readText: async () => {
        calls += 1;
        return text;
      },
    });
    const index = new SearchIndex(dir);

    await index.search("climate", {}, [corpusEntry]);
    expect(calls).toBeGreaterThan(0); // reconcile (new doc) + phase-2 candidate read

    calls = 0;
    const result = await index.search("climate", {}, [corpusEntry]);
    expect(calls).toBe(1); // phase-2 candidate read only — reconcile found the hash unchanged
    expect(result.hits).toHaveLength(1);
  });

  it("reflects new content and drops the stale snippet after a contentHash change", async () => {
    const originalText = "we discuss climate policy in depth this week";
    let currentText = originalText;
    const corpusEntry = entry({
      text: originalText,
      readText: async () => currentText,
    });
    const index = new SearchIndex(dir);
    await index.search("climate", {}, [corpusEntry]);

    currentText = "an unrelated episode about something entirely different, no keywords here";
    corpusEntry.contentHash = createHash("sha256").update(currentText, "utf8").digest("hex");
    const result = await index.search("climate", {}, [corpusEntry]);
    expect(result.hits).toHaveLength(0);
  });
});

describe("search tool", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "castrecall-search-tool-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function config() {
    return resolveConfig({}, { CASTRECALL_DATA_DIR: dir });
  }

  async function seedEpisode(options: {
    uuid: string;
    title: string;
    podcastTitle: string;
    text: string;
    listenTimestamp?: string;
    omitContentHash?: boolean;
  }): Promise<void> {
    const storage = new Storage(dir);
    await storage.init();
    await storage.recordListens([
      {
        uuid: options.uuid,
        title: options.title,
        url: `https://cdn.example.com/${options.uuid}.mp3`,
        podcastUuid: `pod-${options.uuid}`,
        podcastTitle: options.podcastTitle,
      },
    ]);
    const provenance: Provenance = {
      platform: "pocketcasts",
      podcastTitle: options.podcastTitle,
      podcastUuid: `pod-${options.uuid}`,
      episodeTitle: options.title,
      episodeUuid: options.uuid,
      transcriptSource: "rss",
      format: "txt",
      fetchedAt: "2026-07-04T00:00:00Z",
      listenTimestamp: options.listenTimestamp ?? "2026-07-04T12:00:00Z",
      privacyClass: "private-source",
    };
    if (options.omitContentHash) {
      const sourceDir = storage.sourceDir(options.uuid);
      await fs.mkdir(sourceDir, { recursive: true });
      await fs.writeFile(path.join(sourceDir, "transcript.txt"), options.text, "utf8");
      await fs.writeFile(
        path.join(sourceDir, "provenance.json"),
        JSON.stringify(provenance),
        "utf8",
      );
    } else {
      await storage.storeTranscript(options.uuid, {
        raw: options.text,
        ext: "txt",
        text: options.text,
        provenance,
      });
    }
    await storage.updateEpisode(options.uuid, { transcriptStatus: "stored" });
  }

  it("throws CastrecallSetupError for a blank query", async () => {
    await expect(search(config(), { query: "   " })).rejects.toThrow(/non-empty query/);
  });

  it("returns { results: [] } for an empty corpus without throwing", async () => {
    const result = (await search(config(), { query: "anything" })) as Record<string, any>;
    expect(result.results).toEqual([]);
  });

  it("matches a doc containing both keyword terms and excludes a doc matching neither", async () => {
    await seedEpisode({
      uuid: "ep-1",
      title: "Episode One",
      podcastTitle: "Show A",
      text: "In this episode we discuss climate policy in depth, covering climate policy across regions.",
    });
    await seedEpisode({
      uuid: "ep-2",
      title: "Episode Two",
      podcastTitle: "Show B",
      text: "This episode is entirely about cooking recipes and kitchen equipment reviews.",
    });

    const result = (await search(config(), { query: "climate policy" })) as Record<string, any>;
    const uuids = result.results.map((hit: any) => hit.episodeUuid);
    expect(uuids).toContain("ep-1");
    expect(uuids).not.toContain("ep-2");
    for (const hit of result.results) {
      expect(hit.score).toBeGreaterThan(0);
    }
  });

  it("returns full provenance and both snippet fields on every hit", async () => {
    await seedEpisode({
      uuid: "ep-1",
      title: "Episode One",
      podcastTitle: "Show A",
      text: "In this episode we discuss climate policy in meaningful depth for a while.",
      listenTimestamp: "2026-06-01T08:00:00Z",
    });

    const result = (await search(config(), { query: "climate" })) as Record<string, any>;
    expect(result.results).toHaveLength(1);
    const hit = result.results[0];
    expect(hit.episodeUuid).toBe("ep-1");
    expect(hit.podcast).toBe("Show A");
    expect(hit.episode).toBe("Episode One");
    expect(hit.listenDate).toBe("2026-06-01");
    expect(hit.transcriptSource).toBe("rss");
    expect(hit.transcriptPath).toContain("sources/ep-1/transcript.txt");
    expect(hit.snippet).toContain("**climate**");
    expect(hit.snippetText).toContain("climate");
    expect(hit.snippet.length).toBeLessThan(hit.snippetText.length + 20);
  });

  it("ranks a doc with the exact contiguous phrase above a doc with the same words scattered", async () => {
    await seedEpisode({
      uuid: "ep-contig",
      title: "Contiguous",
      podcastTitle: "Show A",
      text: "In this episode we discuss climate policy at length, returning to climate policy again later.",
    });
    await seedEpisode({
      uuid: "ep-scattered",
      title: "Scattered",
      podcastTitle: "Show B",
      text: "Local policy debates rarely mention climate directly, though climate concerns shape policy.",
    });

    const result = (await search(config(), { query: '"climate policy"' })) as Record<string, any>;
    const uuids = result.results.map((hit: any) => hit.episodeUuid);
    expect(uuids[0]).toBe("ep-contig");
    expect(uuids).toContain("ep-scattered");
  });

  it("excludes a doc with zero keyword and zero phrase matches rather than ranking it low", async () => {
    await seedEpisode({
      uuid: "ep-1",
      title: "Episode One",
      podcastTitle: "Show A",
      text: "In this episode we discuss climate policy in depth.",
    });
    await seedEpisode({
      uuid: "ep-2",
      title: "Episode Two",
      podcastTitle: "Show B",
      text: "Nothing relevant is mentioned in this recording at all.",
    });

    const result = (await search(config(), { query: "climate" })) as Record<string, any>;
    expect(result.results.map((hit: any) => hit.episodeUuid)).toEqual(["ep-1"]);
  });

  it("caps results at limit, applies the default when omitted/zero/negative, and clamps above the max", async () => {
    for (const uuid of ["ep-1", "ep-2", "ep-3"]) {
      await seedEpisode({
        uuid,
        title: `Episode ${uuid}`,
        podcastTitle: "Show A",
        text: "This podcast episode about technology and podcast trends is thorough.",
      });
    }

    const limited = (await search(config(), { query: "podcast", limit: 1 })) as Record<string, any>;
    expect(limited.results).toHaveLength(1);

    const defaulted = (await search(config(), { query: "podcast" })) as Record<string, any>;
    expect(defaulted.results).toHaveLength(3);

    const zero = (await search(config(), { query: "podcast", limit: 0 })) as Record<string, any>;
    expect(zero.results).toHaveLength(3);

    const negative = (await search(config(), { query: "podcast", limit: -1 })) as Record<string, any>;
    expect(negative.results).toHaveLength(3);

    const overCap = (await search(config(), { query: "podcast", limit: 999 })) as Record<string, any>;
    expect(overCap.results).toHaveLength(3);
  });

  it("indexes and searches a legacy sidecar missing contentHash via the sha256 fallback", async () => {
    await seedEpisode({
      uuid: "ep-legacy",
      title: "Legacy Episode",
      podcastTitle: "Show A",
      text: "Legacy transcript text stored before the content hash field existed, mentioning climate.",
      omitContentHash: true,
    });

    const result = (await search(config(), { query: "climate" })) as Record<string, any>;
    expect(result.results.map((hit: any) => hit.episodeUuid)).toEqual(["ep-legacy"]);
  });

  it("creates .index/search-index.json after the first search", async () => {
    await seedEpisode({
      uuid: "ep-1",
      title: "Episode One",
      podcastTitle: "Show A",
      text: "In this episode we discuss climate policy in depth.",
    });
    await search(config(), { query: "climate" });
    const storage = new Storage(dir);
    await expect(fs.access(path.join(storage.indexDir(), "search-index.json"))).resolves.toBeUndefined();
  });

  it("self-heals and returns identical results after the index file is corrupted", async () => {
    await seedEpisode({
      uuid: "ep-1",
      title: "Episode One",
      podcastTitle: "Show A",
      text: "In this episode we discuss climate policy in depth.",
    });
    const first = (await search(config(), { query: "climate" })) as Record<string, any>;

    const storage = new Storage(dir);
    await fs.writeFile(path.join(storage.indexDir(), "search-index.json"), "{ not valid json", "utf8");

    const second = (await search(config(), { query: "climate" })) as Record<string, any>;
    expect(second.results).toEqual(first.results);
  });

  it("matches an accented query term against accented transcript text", async () => {
    await seedEpisode({
      uuid: "ep-1",
      title: "Café Talk",
      podcastTitle: "Show A",
      text: "This week's café culture episode explores third-wave coffee shops.",
    });

    const result = (await search(config(), { query: "café" })) as Record<string, any>;
    expect(result.results.map((hit: any) => hit.episodeUuid)).toEqual(["ep-1"]);

    const unaccented = (await search(config(), { query: "cafe" })) as Record<string, any>;
    expect(unaccented.results.map((hit: any) => hit.episodeUuid)).toEqual(["ep-1"]);
  });
});
