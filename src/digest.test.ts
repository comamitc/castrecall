import { describe, expect, it } from "vitest";
import {
  buildDigest,
  listeningPattern,
  MAX_DIGEST_EXCERPTS,
  notableExcerpts,
  recurringTopics,
  type DigestEpisodeInput,
} from "./digest.js";
import type { ListenRecord } from "./storage.js";

function record(overrides: Partial<ListenRecord> & { uuid: string }): ListenRecord {
  return {
    title: `Episode ${overrides.uuid}`,
    podcastUuid: "pod-1",
    podcastTitle: "Example Show",
    audioUrl: "https://cdn.example.com/ep.mp3",
    firstSeenAt: "2026-07-01T00:00:00.000Z",
    transcriptStatus: "none",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

const LONG_PARAGRAPH = (topic: string) =>
  Array.from(
    { length: 4 },
    (_, i) =>
      `Paragraph ${i} exploring ${topic} in enough depth and detail that the excerpt picker treats it as a substantial candidate worth surfacing to a human reader.`,
  ).join("\n\n");

describe("recurringTopics", () => {
  it("ranks terms by frequency, breaking ties alphabetically", () => {
    const topics = recurringTopics(["memory memory habit habit habit apple"]);
    expect(topics[0]).toEqual({ term: "habit", count: 3 });
    expect(topics[1]).toEqual({ term: "memory", count: 2 });
    expect(topics[2]).toEqual({ term: "apple", count: 1 });
  });

  it("excludes stopwords and short tokens", () => {
    const topics = recurringTopics(["the and a it is reconstructive reconstructive reconstructive"]);
    const terms = topics.map((t) => t.term);
    expect(terms).not.toContain("the");
    expect(terms).not.toContain("and");
    expect(terms).toContain("reconstructive");
  });

  it("aggregates across multiple transcripts", () => {
    const topics = recurringTopics(["habit habit", "habit apple"]);
    expect(topics[0]).toEqual({ term: "habit", count: 3 });
  });
});

describe("notableExcerpts", () => {
  it("surfaces a verbatim excerpt attributed to its podcast and episode", () => {
    const episodes: DigestEpisodeInput[] = [
      {
        record: record({ uuid: "ep-1", title: "The One About Memory", podcastTitle: "Show A" }),
        transcriptText: LONG_PARAGRAPH("a distinctive marker phrase xyzzy123"),
      },
    ];
    const excerpts = notableExcerpts(episodes);
    expect(excerpts).toHaveLength(1);
    expect(excerpts[0].podcast).toBe("Show A");
    expect(excerpts[0].episode).toBe("The One About Memory");
    expect(excerpts[0].excerpt).toContain("xyzzy123");
  });

  it("skips episodes with no transcript text or no qualifying excerpt", () => {
    const episodes: DigestEpisodeInput[] = [
      { record: record({ uuid: "ep-1" }) },
      { record: record({ uuid: "ep-2" }), transcriptText: "too short" },
    ];
    expect(notableExcerpts(episodes)).toEqual([]);
  });

  it("caps at MAX_DIGEST_EXCERPTS and restores listen order", () => {
    const episodes: DigestEpisodeInput[] = Array.from({ length: MAX_DIGEST_EXCERPTS + 3 }, (_, i) => ({
      record: record({ uuid: `ep-${i}`, title: `Episode ${i}` }),
      transcriptText: LONG_PARAGRAPH(`topic ${i}`),
    }));
    const excerpts = notableExcerpts(episodes);
    expect(excerpts.length).toBe(MAX_DIGEST_EXCERPTS);
    const indices = excerpts.map((e) => Number(e.episode.replace("Episode ", "")));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });
});

describe("listeningPattern", () => {
  it("counts episodes, shows, and transcript-source breakdown", () => {
    const episodes: DigestEpisodeInput[] = [
      {
        record: record({ uuid: "ep-1", podcastTitle: "Show A", transcriptStatus: "stored", transcriptSource: "rss" }),
        transcriptText: "text",
      },
      {
        record: record({ uuid: "ep-2", podcastTitle: "Show A", transcriptStatus: "stored", transcriptSource: "rss" }),
        transcriptText: "text",
      },
      { record: record({ uuid: "ep-3", podcastTitle: "Show B", transcriptStatus: "none" }) },
    ];
    const pattern = listeningPattern(episodes);
    expect(pattern.totalEpisodes).toBe(3);
    expect(pattern.showCount).toBe(2);
    expect(pattern.transcribedCount).toBe(2);
    expect(pattern.sourceBreakdown).toEqual({ rss: 2, "not-transcribed": 1 });
    expect(pattern.showBreakdown).toEqual([
      { show: "Show A", count: 2 },
      { show: "Show B", count: 1 },
    ]);
  });
});

describe("buildDigest", () => {
  const windowStart = new Date("2026-06-06T00:00:00.000Z");
  const windowEnd = new Date("2026-07-06T00:00:00.000Z");
  const generatedAt = new Date("2026-07-06T00:00:00.000Z");

  it("emits pending-review frontmatter and structural sections only", () => {
    const episodes: DigestEpisodeInput[] = [
      {
        record: record({
          uuid: "ep-1",
          title: "Episode One",
          podcastTitle: "Show A",
          transcriptStatus: "stored",
          transcriptSource: "rss",
        }),
        transcriptText: LONG_PARAGRAPH("a distinctive marker phrase xyzzy123"),
      },
      { record: record({ uuid: "ep-2", podcastTitle: "Show B", transcriptStatus: "none" }) },
    ];
    const { markdown, summary } = buildDigest({ episodes, days: 30, windowStart, windowEnd, generatedAt });

    expect(summary).toEqual({
      episodes: 2,
      shows: 2,
      transcribed: 1,
      window: { days: 30, start: windowStart.toISOString(), end: windowEnd.toISOString() },
    });
    expect(markdown).toContain("status: pending-review");
    expect(markdown).toContain("privacy: private-source");
    expect(markdown).toContain("kind: digest");
    expect(markdown).toContain("## Listening pattern");
    expect(markdown).toContain("## Recurring topics");
    expect(markdown).toContain("## Notable excerpts");
    expect(markdown).toContain("## For the reviewing agent");
    expect(markdown).toContain("Show A");
    expect(markdown).toContain("xyzzy123");

    // Honesty contract: no fabricated theme/conclusion sentences — only a
    // delegation prompt phrased as questions, never assertions.
    expect(markdown).not.toMatch(/you are becoming/i);
    expect(markdown).not.toMatch(/your thinking has shifted/i);
    const agentSection = markdown.split("## For the reviewing agent")[1].split("## Reviewer notes")[0];
    const questionLines = agentSection.split("\n").filter((line) => line.trim().startsWith("-"));
    expect(questionLines.length).toBeGreaterThan(0);
    expect(questionLines.every((line) => line.trim().endsWith("?"))).toBe(true);
  });

  it("falls back to explanatory text when no episode in the window has a transcript", () => {
    const episodes: DigestEpisodeInput[] = [{ record: record({ uuid: "ep-1", transcriptStatus: "none" }) }];
    const { markdown, summary } = buildDigest({ episodes, days: 7, windowStart, windowEnd, generatedAt });
    expect(summary.transcribed).toBe(0);
    expect(markdown).toContain("No transcribed episodes in this window; topics require at least one stored transcript.");
    expect(markdown).toContain("No transcribed episodes in this window to excerpt from.");
  });
});
