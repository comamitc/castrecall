import { describe, expect, it } from "vitest";
import { buildPromotedNote } from "./review.js";
import type { ListenRecord, Provenance } from "./storage.js";

const RECORD: ListenRecord = {
  uuid: "ep-1",
  title: "Episode One",
  podcastUuid: "pod-1",
  podcastTitle: "Example Show",
  audioUrl: "https://cdn.example.com/ep1.mp3",
  firstSeenAt: "2026-07-04T18:12:00.000Z",
  transcriptStatus: "stored",
  updatedAt: "2026-07-04T18:12:00.000Z",
};

const PROVENANCE: Provenance = {
  platform: "pocketcasts",
  podcastTitle: "Example Show",
  podcastUuid: "pod-1",
  episodeTitle: "Episode One",
  episodeUuid: "ep-1",
  audioUrl: "https://cdn.example.com/ep1.mp3?token=secret-audio",
  transcriptSourceUrl: "https://cdn.example.com/ep1.vtt?sig=secret-transcript",
  transcriptSource: "rss",
  format: "vtt",
  fetchedAt: "2026-07-04T18:20:00.000Z",
  privacyClass: "private-source",
};

describe("buildPromotedNote", () => {
  it("includes attribution frontmatter and the exact human-chosen body", () => {
    const markdown = buildPromotedNote({
      record: RECORD,
      provenance: PROVENANCE,
      content: "The one durable idea from this episode.",
      resolvedAt: new Date("2026-07-06T00:00:00.000Z"),
    });
    expect(markdown).toContain('podcast: "Example Show"');
    expect(markdown).toContain('episode: "Episode One"');
    expect(markdown).toContain("listened: 2026-07-04T18:12:00.000Z");
    expect(markdown).toContain("transcript_source: rss");
    expect(markdown).toContain("episode_uuid: ep-1");
    expect(markdown).toContain("promoted_from: castrecall");
    expect(markdown).toContain("resolved_at: 2026-07-06T00:00:00.000Z");
    expect(markdown).toContain("# Episode One");
    expect(markdown).toContain("The one durable idea from this episode.");
  });

  it("uses the provided title over the episode title when given", () => {
    const markdown = buildPromotedNote({
      record: RECORD,
      provenance: PROVENANCE,
      content: "Body text.",
      title: "My custom note title",
      resolvedAt: new Date("2026-07-06T00:00:00.000Z"),
    });
    expect(markdown).toContain("# My custom note title");
    expect(markdown).not.toContain("# Episode One");
  });

  it("includes transcript_provider only when provenance.provider is set", () => {
    const withProvider = buildPromotedNote({
      record: RECORD,
      provenance: { ...PROVENANCE, provider: "assemblyai" },
      content: "Body text.",
      resolvedAt: new Date("2026-07-06T00:00:00.000Z"),
    });
    expect(withProvider).toContain("transcript_provider: assemblyai");

    const withoutProvider = buildPromotedNote({
      record: RECORD,
      provenance: PROVENANCE,
      content: "Body text.",
      resolvedAt: new Date("2026-07-06T00:00:00.000Z"),
    });
    expect(withoutProvider).not.toContain("transcript_provider");
  });

  it("never leaks secret query params from provenance URLs", () => {
    const markdown = buildPromotedNote({
      record: RECORD,
      provenance: PROVENANCE,
      content: "Body text.",
      resolvedAt: new Date("2026-07-06T00:00:00.000Z"),
    });
    expect(markdown).not.toContain("secret-audio");
    expect(markdown).not.toContain("secret-transcript");
  });

  it("renders the body verbatim, including YAML-breaking characters in the title", () => {
    const markdown = buildPromotedNote({
      record: { ...RECORD, title: 'Title with "quotes" and: a colon' },
      provenance: PROVENANCE,
      content: "Line one.\n\nLine two with a : colon and \"quotes\".",
      resolvedAt: new Date("2026-07-06T00:00:00.000Z"),
    });
    expect(markdown).toContain('episode: "Title with \\"quotes\\" and: a colon"');
    expect(markdown).toContain("Line one.\n\nLine two with a : colon and \"quotes\".");
  });
});
