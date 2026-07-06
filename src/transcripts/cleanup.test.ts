import { describe, expect, it } from "vitest";
import { cleanTranscript, spokenTokens, STANDALONE_CUE_ALLOWLIST } from "./cleanup.js";

describe("cleanTranscript", () => {
  describe("regression fixtures — STT defects", () => {
    it("de-glues a missing space after sentence-terminal punctuation", () => {
      const result = cleanTranscript("word ,next .Then");
      expect(result.text).toBe("word, next. Then");
      expect(result.applied).toContain("fix-punctuation-glue");
    });

    it("collapses doubled/glued terminal punctuation from caption merges", () => {
      const result = cleanTranscript("Wait, really?. That happened..");
      expect(result.text).toBe("Wait, really? That happened.");
      expect(result.applied).toContain("fix-punctuation-glue");
    });

    it("leaves decapitalized run-ons alone — never rewrites word casing or content", () => {
      const input = "and then we went to the store and it was closed so we left";
      const result = cleanTranscript(input);
      expect(result.text).toBe(input);
      expect(result.applied).toEqual([]);
    });

    it("preserves decimals, clock times, and URLs — never splits digit/domain punctuation", () => {
      const input = "The value is 3.14, arriving at 10:30, see example.com for details.";
      const result = cleanTranscript(input);
      expect(result.text).toBe(input);
      expect(result.applied).toEqual([]);
    });
  });

  describe("regression fixtures — caption-formatting defects", () => {
    it("strips standalone [MUSIC]/>>caret/blank-line-run artifacts", () => {
      const result = cleanTranscript("[MUSIC]\n>> Hello   world\n\n\n\nBye");
      expect(result.text).not.toContain("[MUSIC]");
      expect(result.text).not.toContain(">>");
      expect(result.text).not.toMatch(/\n{3,}/);
      expect(result.text).not.toMatch(/ {2,}/);
      expect(result.applied).toEqual(
        expect.arrayContaining(["strip-standalone-cues", "strip-caption-markers", "collapse-whitespace"]),
      );
    });

    it("strips a standalone (inaudible) cue line", () => {
      const result = cleanTranscript("Hello there.\n(inaudible)\nGoodbye.");
      expect(result.text).not.toContain("inaudible");
      expect(result.applied).toContain("strip-standalone-cues");
    });

    it("strips a leading dialogue dash at line start", () => {
      const result = cleanTranscript("- Hello there.\n- Hi back.");
      expect(result.text).toBe("Hello there.\nHi back.");
      expect(result.applied).toContain("strip-caption-markers");
    });

    it("strips a caret-prefixed standalone cue line", () => {
      const result = cleanTranscript("Hello there.\n>> [MUSIC]\nGoodbye.");
      expect(result.text).toBe("Hello there.\nGoodbye.");
      expect(result.applied).toEqual(
        expect.arrayContaining(["strip-caption-markers", "strip-standalone-cues"]),
      );
    });

    it("strips a dash-prefixed standalone cue line", () => {
      const result = cleanTranscript("Hello there.\n- (inaudible)\nGoodbye.");
      expect(result.text).toBe("Hello there.\nGoodbye.");
      expect(result.applied).toEqual(
        expect.arrayContaining(["strip-caption-markers", "strip-standalone-cues"]),
      );
    });

    it("leaves a mid-sentence cue in place — the allowlist only fires on standalone lines", () => {
      const input = "This is great [LAUGHTER] right?";
      const result = cleanTranscript(input);
      expect(result.text).toContain("[LAUGHTER]");
      expect(result.applied).not.toContain("strip-standalone-cues");
    });

    it("leaves a mid-sentence (inaudible) marker in place", () => {
      const input = "We went to the (inaudible) store yesterday.";
      const result = cleanTranscript(input);
      expect(result.text).toBe(input);
    });

    it("paragraph-separates single-newline speaker turns without touching labels", () => {
      const result = cleanTranscript("Alice: Hi there\nBob: Hello back");
      expect(result.text).toBe("Alice: Hi there\n\nBob: Hello back");
      expect(result.applied).toContain("separate-speaker-turns");
    });

    it("leaves already-paragraph-separated multi-turn speaker text unchanged", () => {
      const input = "Alice: Hi there\n\nBob: Hello back\n\nAlice: Great to hear.";
      const result = cleanTranscript(input);
      expect(result.text).toBe(input);
      expect(result.applied).toEqual([]);
    });
  });

  describe("invariants", () => {
    const FIXTURES = [
      "",
      "   \n\n  ",
      "word ,next .Then",
      "[MUSIC]\n>> Hello   world\n\n\n\nBye",
      "This is great [LAUGHTER] right?",
      "Alice: Hi there\nBob: Hello back",
      "Wait, really?. That happened..",
      "- Hello there.\n- Hi back.",
      "Already clean, perfectly normal prose. Nothing to fix here.",
      "(inaudible)\nWe went to the (inaudible) store yesterday.",
      "Hello there.\n>> [MUSIC]\nGoodbye.",
      "Hello there.\n- (inaudible)\nGoodbye.",
      "The value is 3.14, arriving at 10:30, see example.com for details.",
    ];

    it("is idempotent — cleaning already-clean output changes nothing further", () => {
      for (const fixture of FIXTURES) {
        const once = cleanTranscript(fixture);
        const twice = cleanTranscript(once.text);
        expect(twice.text).toBe(once.text);
      }
    });

    it("is deterministic — repeated calls on the same input return byte-identical results", () => {
      for (const fixture of FIXTURES) {
        expect(cleanTranscript(fixture)).toEqual(cleanTranscript(fixture));
      }
    });

    it("preserves every spoken token in order — no word added, removed, or reordered", () => {
      for (const fixture of FIXTURES) {
        const cleaned = cleanTranscript(fixture).text;
        expect(spokenTokens(cleaned)).toEqual(spokenTokens(fixture));
      }
    });

    it("returns already-clean prose unchanged with an empty applied list", () => {
      const input = "Already clean, perfectly normal prose. Nothing to fix here.";
      const result = cleanTranscript(input);
      expect(result.text).toBe(input);
      expect(result.applied).toEqual([]);
    });

    it("handles empty and whitespace-only input without throwing", () => {
      expect(cleanTranscript("").text).toBe("");
      expect(cleanTranscript("   \n\n  ").text).toBe("");
    });

    it("respects a caller-supplied cue allowlist override", () => {
      const result = cleanTranscript("[CUSTOM CUE]\nHello.", { cueAllowlist: ["CUSTOM CUE"] });
      expect(result.text).toBe("Hello.");
      expect(result.applied).toContain("strip-standalone-cues");
    });
  });
});

describe("spokenTokens", () => {
  it("drops only allowlisted standalone cue lines, not ordinary words", () => {
    expect(spokenTokens("[MUSIC]\nHello world")).toEqual(["hello", "world"]);
  });

  it("keeps a mid-sentence cue word since it isn't a standalone cue line", () => {
    expect(spokenTokens("This is great [LAUGHTER] right?")).toEqual([
      "this",
      "is",
      "great",
      "laughter",
      "right",
    ]);
  });

  it("uses the exported STANDALONE_CUE_ALLOWLIST by default", () => {
    expect(STANDALONE_CUE_ALLOWLIST).toContain("MUSIC");
  });
});
