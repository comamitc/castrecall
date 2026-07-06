import { describe, expect, it } from "vitest";
import { buildPromotedNote, buildReviewCandidate } from "./review.js";
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

describe("buildReviewCandidate", () => {
  const TRANSCRIPT_TEXT =
    "This is a long enough paragraph of transcript text for the excerpt picker to consider it substantial. ".repeat(
      3,
    );

  it("surfaces exact local-whisper generation provenance in frontmatter and the provenance section (issue #54)", () => {
    const markdown = buildReviewCandidate({
      record: RECORD,
      provenance: {
        ...PROVENANCE,
        transcriptSource: "local-whisper",
        generation: {
          kind: "local-whisper",
          backend: "mlx-whisper",
          model: undefined,
          modelSource: "backend-default",
          usesBackendDefault: true,
          preset: "quality",
          outputFormat: "txt",
          wordTimestamps: false,
          decode: {
            applied: { conditionOnPreviousText: false },
            ignored: [{ option: "wordTimestamps", reason: "txt output cannot carry word timing" }],
          },
          toolVersion: "mlx-whisper 0.4.0",
        },
      },
      transcriptText: TRANSCRIPT_TEXT,
      transcriptPath: "/tmp/transcript.txt",
      generatedAt: new Date("2026-07-06T00:00:00.000Z"),
    });
    expect(markdown).toContain("transcript_backend: mlx-whisper");
    expect(markdown).toContain("transcript_model_source: backend-default");
    expect(markdown).not.toContain("transcript_model:");
    expect(markdown).toContain('transcript_preset: "quality"');
    expect(markdown).toContain("transcript_output_format: txt");
    expect(markdown).toContain("transcript_word_timestamps: false");
    expect(markdown).toContain("transcript_decode_options:");
    expect(markdown).toContain("conditionOnPreviousText");
    expect(markdown).toContain("transcript_decode_ignored:");
    expect(markdown).toContain("wordTimestamps");
    expect(markdown).toContain('transcript_tool_version: "mlx-whisper 0.4.0"');
    expect(markdown).toContain("- Generation: mlx-whisper (backend-default, backend default — check corpus quality)");
    expect(markdown).toContain("dropped decode options: wordTimestamps");
  });

  it("treats local-whisper generation written before the kind discriminator existed as local-whisper (issue #61 regression)", () => {
    // Sidecars from before #61 introduced generation.kind never had it —
    // they were the only generation shape, so nothing wrote a discriminator.
    const preDiscriminatorGeneration = {
      backend: "mlx-whisper",
      model: "mlx-community/whisper-large-v3-turbo",
      modelSource: "explicit",
      usesBackendDefault: false,
      outputFormat: "txt",
      wordTimestamps: false,
      decode: { applied: {}, ignored: [] },
    } as unknown as NonNullable<Provenance["generation"]>;
    const markdown = buildReviewCandidate({
      record: RECORD,
      provenance: { ...PROVENANCE, transcriptSource: "local-whisper", generation: preDiscriminatorGeneration },
      transcriptText: TRANSCRIPT_TEXT,
      transcriptPath: "/tmp/transcript.txt",
      generatedAt: new Date("2026-07-06T00:00:00.000Z"),
    });
    expect(markdown).toContain("transcript_backend: mlx-whisper");
    expect(markdown).toContain('transcript_model: "mlx-community/whisper-large-v3-turbo"');
    expect(markdown).toContain("transcript_model_source: explicit");
    expect(markdown).toContain("- Generation: mlx-whisper:mlx-community/whisper-large-v3-turbo (explicit)");
  });

  it("omits every transcript_* generation line and the Generation provenance line for a legacy provenance with no generation", () => {
    const markdown = buildReviewCandidate({
      record: RECORD,
      provenance: PROVENANCE,
      transcriptText: TRANSCRIPT_TEXT,
      transcriptPath: "/tmp/transcript.txt",
      generatedAt: new Date("2026-07-06T00:00:00.000Z"),
    });
    expect(markdown).not.toContain("transcript_backend:");
    expect(markdown).not.toContain("transcript_model:");
    expect(markdown).not.toContain("transcript_model_source:");
    expect(markdown).not.toContain("transcript_preset:");
    expect(markdown).not.toContain("transcript_output_format:");
    expect(markdown).not.toContain("transcript_word_timestamps:");
    expect(markdown).not.toContain("transcript_decode_options:");
    expect(markdown).not.toContain("transcript_decode_ignored:");
    expect(markdown).not.toContain("transcript_tool_version:");
    expect(markdown).not.toContain("- Generation:");
  });

  it("renders an older generation shape (decode.ignored only, no applied/outputFormat/wordTimestamps) without crashing or printing undefined", () => {
    // Provenance persisted by a build before the newer fields existed:
    // decode carries only `ignored`, and outputFormat/wordTimestamps are
    // absent entirely. Review generation must degrade gracefully, not
    // throw or emit literal "undefined".
    const legacyGeneration = {
      kind: "local-whisper",
      backend: "mlx-whisper",
      modelSource: "explicit",
      usesBackendDefault: false,
      model: "mlx-community/whisper-large-v3-turbo",
      decode: {
        ignored: [{ option: "wordTimestamps", reason: "older shape" }],
      },
    } as unknown as NonNullable<Provenance["generation"]>;
    const markdown = buildReviewCandidate({
      record: RECORD,
      provenance: { ...PROVENANCE, transcriptSource: "local-whisper", generation: legacyGeneration },
      transcriptText: TRANSCRIPT_TEXT,
      transcriptPath: "/tmp/transcript.txt",
      generatedAt: new Date("2026-07-06T00:00:00.000Z"),
    });
    expect(markdown).toContain("transcript_backend: mlx-whisper");
    expect(markdown).not.toContain("transcript_decode_options:");
    expect(markdown).toContain("transcript_decode_ignored:");
    expect(markdown).not.toContain("transcript_output_format:");
    expect(markdown).not.toContain("transcript_word_timestamps:");
    expect(markdown).not.toContain("undefined");
    expect(markdown).toContain("dropped decode options: wordTimestamps");

    // The fully-absent-decode shape degrades the same way.
    const noDecode = {
      kind: "local-whisper",
      backend: "mlx-whisper",
      modelSource: "explicit",
      usesBackendDefault: false,
    } as unknown as NonNullable<Provenance["generation"]>;
    const minimal = buildReviewCandidate({
      record: RECORD,
      provenance: { ...PROVENANCE, transcriptSource: "local-whisper", generation: noDecode },
      transcriptText: TRANSCRIPT_TEXT,
      transcriptPath: "/tmp/transcript.txt",
      generatedAt: new Date("2026-07-06T00:00:00.000Z"),
    });
    expect(minimal).toContain("transcript_backend: mlx-whisper");
    expect(minimal).not.toContain("transcript_decode_options:");
    expect(minimal).not.toContain("transcript_decode_ignored:");
    expect(minimal).not.toContain("undefined");
  });
});
