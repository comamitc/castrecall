import { describe, expect, it } from "vitest";
import { DEFAULT_LOOP_THRESHOLDS, detectRepetitionLoop } from "./loop-detection.js";

/** Distinct, non-repeating filler tokens — never trips any loop rule on their own. */
function uniqueWords(count: number, prefix = "w"): string {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(" ");
}

function repeatPhrase(phrase: string, times: number): string {
  return Array.from({ length: times }, () => phrase).join(" ");
}

describe("detectRepetitionLoop", () => {
  describe("regression fixtures (known loop patterns)", () => {
    it("flags a real Whisper phrase-loop hallucination", () => {
      const text = repeatPhrase("Thank you for watching.", 40);
      const result = detectRepetitionLoop(text);
      expect(result.looped).toBe(true);
      expect(result.phrase).toBe("thank you for watching");
      expect(result.repetitions).toBe(40);
      expect(result.coverage).toBeCloseTo(1, 5);
      expect(result.reason).toContain("thank you for watching");
      expect(result.reason).toContain("40×");
    });

    it("flags a single-token flood ('you you you...')", () => {
      const text = `${uniqueWords(150)} ${repeatPhrase("you", 20)}`;
      const result = detectRepetitionLoop(text);
      expect(result.looped).toBe(true);
      expect(result.phrase).toBe("you");
      expect(result.repetitions).toBe(20);
    });

    it("flags a real intro followed by a long looped tail covering most of the transcript", () => {
      const intro =
        "in this episode we sit down with a guest to talk about their new book and " +
        "career journey across several distinct chapters";
      const text = `${intro} ${repeatPhrase("please subscribe and rate this podcast", 20)}`;
      const result = detectRepetitionLoop(text);
      expect(result.looped).toBe(true);
      expect(result.phrase).toBe("please subscribe and rate this podcast");
      expect(result.coverage).toBeGreaterThanOrEqual(DEFAULT_LOOP_THRESHOLDS.COVERAGE_THRESHOLD);
    });

    it("flags a loop across whitespace/punctuation/case variants of the same phrase", () => {
      const prefix = "in this episode we cover several interesting topics related to technology";
      const variants = ["Thank you.", "thank you…", "Thank you", "THANK YOU!"];
      const tail = Array.from({ length: 40 }, (_, i) => variants[i % variants.length]).join(" ");
      const result = detectRepetitionLoop(`${prefix} ${tail}`);
      expect(result.looped).toBe(true);
      expect(result.phrase).toBe("thank you");
      expect(result.repetitions).toBe(40);
    });
  });

  describe("false-positive guards", () => {
    it("does not flag normal prose", () => {
      const text =
        "the guest opened the conversation by describing how they got started in the industry, " +
        "then walked through the biggest lessons from their first few years, touching on hiring, " +
        "fundraising, and the moment they realized the original plan needed to change entirely " +
        "before the company could grow";
      expect(detectRepetitionLoop(text).looped).toBe(false);
    });

    it("does not flag a legitimate 3x chorus repeat", () => {
      const verse1 = uniqueWords(20, "verse1_");
      const verse2 = uniqueWords(20, "verse2_");
      const chorus = "we will rock you";
      const text = `${verse1} ${chorus} ${chorus} ${chorus} ${verse2}`;
      expect(detectRepetitionLoop(text).looped).toBe(false);
    });

    it("does not flag frequent but non-consecutive stopwords", () => {
      const text = Array.from(
        { length: 20 },
        (_, i) => `the topic${i} and the detail${i}`,
      ).join(" ");
      expect(detectRepetitionLoop(text).looped).toBe(false);
    });

    it("does not flag a transcript under MIN_TOKENS even if it loops", () => {
      const text = repeatPhrase("test", 8);
      expect(detectRepetitionLoop(text).looped).toBe(false);
    });
  });

  describe("threshold precedence and boundaries", () => {
    it("flags a phrase repeated exactly MIN_REPEATS times spanning exactly MIN_LOOP_TOKENS", () => {
      const prefix = uniqueWords(65);
      const phrase = "thank you for listening today";
      const text = `${prefix} ${repeatPhrase(phrase, DEFAULT_LOOP_THRESHOLDS.MIN_REPEATS)}`;
      const result = detectRepetitionLoop(text);
      expect(result.looped).toBe(true);
      expect(result.repetitions).toBe(DEFAULT_LOOP_THRESHOLDS.MIN_REPEATS);
      expect(result.coverage).toBeLessThan(DEFAULT_LOOP_THRESHOLDS.COVERAGE_THRESHOLD);
    });

    it("does not flag the same phrase one repeat fewer (below both MIN_LOOP_TOKENS and COVERAGE_THRESHOLD)", () => {
      const prefix = uniqueWords(65);
      const phrase = "thank you for listening today";
      const text = `${prefix} ${repeatPhrase(phrase, DEFAULT_LOOP_THRESHOLDS.MIN_REPEATS - 1)}`;
      expect(detectRepetitionLoop(text).looped).toBe(false);
    });

    it("flags via COVERAGE_THRESHOLD alone when span is below MIN_LOOP_TOKENS", () => {
      const prefix = uniqueWords(36);
      const phrase = "one two three four";
      const text = `${prefix} ${repeatPhrase(phrase, 6)}`;
      const result = detectRepetitionLoop(text);
      expect(result.repetitions).toBe(6);
      expect(result.coverage).toBeGreaterThanOrEqual(DEFAULT_LOOP_THRESHOLDS.COVERAGE_THRESHOLD);
      // span (24 tokens) stays below MIN_LOOP_TOKENS (30) — coverage alone qualifies it.
      expect(result.looped).toBe(true);
    });

    it("does not flag when span is below MIN_LOOP_TOKENS and coverage is just under COVERAGE_THRESHOLD", () => {
      const prefix = uniqueWords(46);
      const phrase = "one two three four";
      const text = `${prefix} ${repeatPhrase(phrase, 6)}`;
      expect(detectRepetitionLoop(text).looped).toBe(false);
    });

    it("resolves an n=1 loop to a single detection (flood and phrase rules never double-count)", () => {
      const text = repeatPhrase("yes", 70);
      const result = detectRepetitionLoop(text);
      expect(result.looped).toBe(true);
      expect(result.phrase).toBe("yes");
      expect(result.repetitions).toBe(70);
      expect(Object.keys(result).sort()).toEqual(
        ["coverage", "looped", "phrase", "reason", "repetitions"].sort(),
      );
    });
  });

  describe("performance", () => {
    it("handles a ~50k-word transcript well under a second", () => {
      const text = uniqueWords(50_000);
      const start = performance.now();
      const result = detectRepetitionLoop(text);
      const elapsed = performance.now() - start;
      expect(result.looped).toBe(false);
      expect(elapsed).toBeLessThan(1000);
    });
  });
});
