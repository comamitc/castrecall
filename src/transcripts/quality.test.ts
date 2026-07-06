import { describe, expect, it } from "vitest";
import { scoreTranscriptQuality } from "./quality.js";

function words(n: number, seed = "word"): string {
  return Array.from({ length: n }, (_, i) => `${seed}${i}`).join(" ");
}

describe("scoreTranscriptQuality", () => {
  it("returns score 0, tier search-only, reasons [empty] for empty text", () => {
    expect(scoreTranscriptQuality({ text: "", source: "stt" })).toEqual({
      score: 0,
      tier: "search-only",
      reasons: ["empty"],
    });
  });

  it("treats whitespace-only text the same as empty, with no other reason", () => {
    expect(scoreTranscriptQuality({ text: "   \n\t ", source: "rss" })).toEqual({
      score: 0,
      tier: "search-only",
      reasons: ["empty"],
    });
  });

  it("scores a long, timestamped, speaker-labeled RSS transcript as quote-safe with no penalty reasons", () => {
    const segments = Array.from({ length: 10 }, (_, i) => ({
      start: `00:00:${String(i * 2).padStart(2, "0")}.000`,
      end: `00:00:${String(i * 2 + 2).padStart(2, "0")}.000`,
      speaker: i % 2 === 0 ? "Host" : "Guest",
      text: `Segment number ${i} covers a distinct topic with plenty of unique words.`,
    }));
    const text = segments.map((s) => s.text).join(" ") + " " + words(60, "extra");
    const result = scoreTranscriptQuality({ text, source: "rss", segments });
    expect(result.tier).toBe("quote-safe");
    expect(result.reasons).toEqual([]);
    expect(result.score).toBe(100);
  });

  it("flags too-short for a transcript under the minimum word count", () => {
    const result = scoreTranscriptQuality({ text: "Hi there, thanks for listening.", source: "rss" });
    expect(result.reasons).toContain("too-short");
    expect(result.score).toBeLessThan(100);
  });

  it("does not flag too-short right at and above the boundary", () => {
    const atBoundary = scoreTranscriptQuality({ text: words(50), source: "rss" });
    expect(atBoundary.reasons).not.toContain("too-short");
    const justBelow = scoreTranscriptQuality({ text: words(49), source: "rss" });
    expect(justBelow.reasons).toContain("too-short");
  });

  it("flags repetition-loop and forces tier search-only even when the base score would clear reviewable", () => {
    const looped = Array.from({ length: 40 }, () => "Thank you for watching.").join(" ");
    const result = scoreTranscriptQuality({ text: looped, source: "rss" });
    expect(result.reasons).toContain("repetition-loop");
    expect(result.tier).toBe("search-only");
  });

  it("flags low-lexical-variety for a long transcript that repeats a small vocabulary", () => {
    const lowVariety = Array.from({ length: 80 }, (_, i) => (i % 3 === 0 ? "alpha" : i % 3 === 1 ? "beta" : "gamma")).join(
      " ",
    );
    const result = scoreTranscriptQuality({ text: lowVariety, source: "rss" });
    expect(result.reasons).toContain("low-lexical-variety");
  });

  it("exempts short transcripts from the lexical-variety check", () => {
    const shortLowVariety = "alpha beta alpha beta alpha beta alpha beta alpha beta";
    const result = scoreTranscriptQuality({ text: shortLowVariety, source: "rss" });
    expect(result.reasons).not.toContain("low-lexical-variety");
  });

  it("flags suspicious-segment-lengths when most segments are empty-text", () => {
    const segments = [
      { text: words(60) },
      { text: "" },
      { text: "" },
      { text: "" },
    ];
    const result = scoreTranscriptQuality({ text: words(60), source: "rss", segments });
    expect(result.reasons).toContain("suspicious-segment-lengths");
  });

  it("flags suspicious-segment-lengths for one giant merged segment", () => {
    const giantText = words(600);
    const segments = [{ text: giantText }];
    const result = scoreTranscriptQuality({ text: giantText, source: "rss", segments });
    expect(result.reasons).toContain("suspicious-segment-lengths");
  });

  it("does not flag suspicious-segment-lengths when no segments are supplied", () => {
    const result = scoreTranscriptQuality({ text: words(60), source: "rss" });
    expect(result.reasons).not.toContain("suspicious-segment-lengths");
  });

  it("flags no-timestamps, no-speaker-labels, and low-source-confidence for plain stt text with no segments, capped at reviewable", () => {
    const result = scoreTranscriptQuality({ text: words(80), source: "stt" });
    expect(result.reasons).toContain("no-timestamps");
    expect(result.reasons).toContain("no-speaker-labels");
    expect(result.reasons).toContain("low-source-confidence");
    expect(result.tier === "reviewable" || result.tier === "search-only").toBe(true);
    expect(result.tier).not.toBe("quote-safe");
  });

  it("does not penalize low-source-confidence for a published source", () => {
    const result = scoreTranscriptQuality({ text: words(80), source: "taddy" });
    expect(result.reasons).not.toContain("low-source-confidence");
  });

  it("treats an empty segments array the same as no segments for timestamps/speaker checks", () => {
    const result = scoreTranscriptQuality({ text: words(80), source: "rss", segments: [] });
    expect(result.reasons).toContain("no-timestamps");
    expect(result.reasons).toContain("no-speaker-labels");
  });

  it("does not flag no-timestamps/no-speaker-labels when at least one segment has them", () => {
    const segments = [
      { start: "00:00:00.000", end: "00:00:02.000", speaker: "Host", text: words(30, "a") },
      { text: words(30, "b") },
    ];
    const text = words(60);
    const result = scoreTranscriptQuality({ text, source: "rss", segments });
    expect(result.reasons).not.toContain("no-timestamps");
    expect(result.reasons).not.toContain("no-speaker-labels");
  });

  it("is deterministic across repeated calls on identical input", () => {
    const input = { text: words(80), source: "stt" as const };
    expect(scoreTranscriptQuality(input)).toEqual(scoreTranscriptQuality(input));
  });

  it("changes the outcome at a boundary when thresholds are overridden", () => {
    const text = words(40);
    const defaultResult = scoreTranscriptQuality({ text, source: "rss" });
    expect(defaultResult.reasons).toContain("too-short");
    const overridden = scoreTranscriptQuality({ text, source: "rss" }, { MIN_WORDS: 10 });
    expect(overridden.reasons).not.toContain("too-short");
  });
});
