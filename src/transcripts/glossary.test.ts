import { describe, expect, it } from "vitest";
import { CastrecallSetupError } from "../config.js";
import { applyGlossary, compileGlossary, parseGlossary } from "./glossary.js";

describe("glossary", () => {
  describe("safe corrections", () => {
    it("corrects a single-word variant to its canonical", () => {
      const compiled = compileGlossary([{ canonical: "ChatGPT", variants: ["chatgpt"] }]);
      const result = applyGlossary("I love chatgpt so much", compiled);
      expect(result.text).toBe("I love ChatGPT so much");
      expect(result.corrections).toEqual([{ canonical: "ChatGPT", variant: "chatgpt", count: 1 }]);
    });

    it("corrects a multi-word variant to its canonical", () => {
      const compiled = compileGlossary([{ canonical: "ChatGPT", variants: ["chat gpt"] }]);
      const result = applyGlossary("I love chat gpt", compiled);
      expect(result.text).toBe("I love ChatGPT");
      expect(result.corrections).toEqual([{ canonical: "ChatGPT", variant: "chat gpt", count: 1 }]);
    });

    it("supports multiple variants per canonical", () => {
      const compiled = compileGlossary([
        { canonical: "ChatGPT", variants: ["chat gpt", "chatgpt", "chat g p t"] },
      ]);
      const result = applyGlossary("chat gpt and chatgpt and chat g p t", compiled);
      expect(result.text).toBe("ChatGPT and ChatGPT and ChatGPT");
    });

    it("matches case-insensitively by default, producing canonical casing", () => {
      const compiled = compileGlossary([{ canonical: "ChatGPT", variants: ["chatgpt"] }]);
      const result = applyGlossary("CHATGPT and ChatGpt and chatGPT", compiled);
      expect(result.text).toBe("ChatGPT and ChatGPT and ChatGPT");
      expect(result.corrections).toEqual([{ canonical: "ChatGPT", variant: "chatgpt", count: 3 }]);
    });

    it("counts multiple occurrences of the same variant", () => {
      const compiled = compileGlossary([{ canonical: "Astra", variants: ["astral"] }]);
      const result = applyGlossary("astral won, then astral won again", compiled);
      expect(result.corrections).toEqual([{ canonical: "Astra", variant: "astral", count: 2 }]);
    });

    it("longest variant wins on overlap within a single entry", () => {
      const compiled = compileGlossary([
        { canonical: "OpenAI Labs", variants: ["open ai", "open ai labs"] },
      ]);
      const result = applyGlossary("visit open ai labs today", compiled);
      expect(result.text).toBe("visit OpenAI Labs today");
    });

    it("longest variant wins on a shifted (non-nested) overlap across entries", () => {
      const compiled = compileGlossary([
        { canonical: "New York", variants: ["new york"] },
        { canonical: "York City", variants: ["york city"] },
      ]);
      const result = applyGlossary("visit new york city today", compiled);
      expect(result.text).toBe("visit new York City today");
      expect(result.corrections).toEqual([{ canonical: "York City", variant: "york city", count: 1 }]);
    });
  });

  describe("near-misses that must NOT change", () => {
    it("never corrects inside a longer word (prefix/substring)", () => {
      const compiled = compileGlossary([{ canonical: "Dog", variants: ["cat"] }]);
      const result = applyGlossary("category cats concatenate", compiled);
      expect(result.text).toBe("category cats concatenate");
      expect(result.corrections).toEqual([]);
    });

    it("never corrects a proper noun that is a prefix of another (Astral/Astralis)", () => {
      const compiled = compileGlossary([{ canonical: "Astra", variants: ["Astral"] }]);
      const result = applyGlossary("Astralis won the match", compiled);
      expect(result.text).toBe("Astralis won the match");
      expect(result.corrections).toEqual([]);
    });

    it("does not record a correction when the matched text is already the canonical", () => {
      const compiled = compileGlossary([{ canonical: "ChatGPT", variants: ["ChatGPT"], matchCase: true }]);
      const result = applyGlossary("I use ChatGPT daily", compiled);
      expect(result.text).toBe("I use ChatGPT daily");
      expect(result.corrections).toEqual([]);
    });

    it("respects punctuation-adjacent token boundaries", () => {
      const compiled = compileGlossary([{ canonical: "ChatGPT", variants: ["chatgpt"] }]);
      const result = applyGlossary("Have you tried chatgpt? Yes, chatgpt!", compiled);
      expect(result.text).toBe("Have you tried ChatGPT? Yes, ChatGPT!");
    });
  });

  describe("cross-entry overlap and cascade safety", () => {
    it("resolves cross-entry overlap by global longest-match, regardless of entry order", () => {
      const compiled = compileGlossary([
        { canonical: "OpenAI", variants: ["open ai"] },
        { canonical: "OpenAI Labs", variants: ["open ai labs"] },
      ]);
      const result = applyGlossary("visit open ai labs today", compiled);
      expect(result.text).toBe("visit OpenAI Labs today");
      expect(result.corrections).toEqual([
        { canonical: "OpenAI Labs", variant: "open ai labs", count: 1 },
      ]);
    });

    it("never cascades: a fired canonical is not re-scanned by another entry's variant", () => {
      const compiled = compileGlossary([
        { canonical: "OpenAI", variants: ["oai"] },
        { canonical: "Foo", variants: ["OpenAI"] },
      ]);
      const result = applyGlossary("oai", compiled);
      expect(result.text).toBe("OpenAI");
      expect(result.corrections).toEqual([{ canonical: "OpenAI", variant: "oai", count: 1 }]);
    });

    it("throws CastrecallSetupError when one variant maps to two different canonicals", () => {
      expect(() =>
        compileGlossary([
          { canonical: "ChatGPT", variants: ["gpt"] },
          { canonical: "GPT-4", variants: ["gpt"] },
        ]),
      ).toThrow(CastrecallSetupError);
    });

    it("dedupes silently when the same variant maps to the same canonical twice", () => {
      const compiled = compileGlossary([
        { canonical: "ChatGPT", variants: ["chatgpt"] },
        { canonical: "ChatGPT", variants: ["chatgpt"] },
      ]);
      const result = applyGlossary("I use chatgpt", compiled);
      expect(result.text).toBe("I use ChatGPT");
    });
  });

  describe("safety", () => {
    it("escapes regex metacharacters in variants and matches them literally", () => {
      const compiled = compileGlossary([
        { canonical: "C++", variants: ["c++"] },
        { canonical: "A.I.", variants: ["a.i."] },
      ]);
      const result = applyGlossary("I write c++ and study a.i. topics", compiled);
      expect(result.text).toBe("I write C++ and study A.I. topics");
    });

    it("does not throw and is a no-op on an empty glossary", () => {
      const compiled = compileGlossary([]);
      const result = applyGlossary("nothing to change here", compiled);
      expect(result.text).toBe("nothing to change here");
      expect(result.corrections).toEqual([]);
    });

    it("is a no-op on empty text", () => {
      const compiled = compileGlossary([{ canonical: "ChatGPT", variants: ["chatgpt"] }]);
      const result = applyGlossary("", compiled);
      expect(result.text).toBe("");
      expect(result.corrections).toEqual([]);
    });

    it("matches Unicode word tokens correctly", () => {
      const compiled = compileGlossary([{ canonical: "Café Müller", variants: ["cafe muller"] }]);
      const result = applyGlossary("we visited cafe muller yesterday", compiled);
      expect(result.text).toBe("we visited Café Müller yesterday");
    });

    it("applies a case-insensitive match even when regex /iu case folding diverges from String.prototype.toLowerCase() (issue #46 review: Unicode case-folding pair)", () => {
      // /iu matches "ς" (Greek final sigma) against variant "σ" (regular
      // sigma), but "ς".toLowerCase() === "ς" — it does NOT normalize to
      // "σ". A lookup keyed by matched.toLowerCase() would miss this and
      // silently drop the correction.
      const compiled = compileGlossary([{ canonical: "Sigma", variants: ["σ"] }]);
      const result = applyGlossary("test ς here", compiled);
      expect(result.text).toBe("test Sigma here");
      expect(result.corrections).toEqual([{ canonical: "Sigma", variant: "σ", count: 1 }]);
    });

    it("matchCase: true only fires on exact case", () => {
      const compiled = compileGlossary([{ canonical: "NASA", variants: ["NASA"], matchCase: true }]);
      const result = applyGlossary("nasa launched a rocket, then NASA confirmed it", compiled);
      expect(result.text).toBe("nasa launched a rocket, then NASA confirmed it");
      expect(result.corrections).toEqual([]);
    });
  });

  describe("invariants", () => {
    it("is idempotent: re-applying to the corrected text is a no-op", () => {
      const compiled = compileGlossary([{ canonical: "ChatGPT", variants: ["chat gpt", "chatgpt"] }]);
      const first = applyGlossary("I use chat gpt and chatgpt", compiled);
      const second = applyGlossary(first.text, compiled);
      expect(second.text).toBe(first.text);
      expect(second.corrections).toEqual([]);
    });

    it("is deterministic across repeated calls", () => {
      const compiled = compileGlossary([
        { canonical: "OpenAI", variants: ["open ai"] },
        { canonical: "OpenAI Labs", variants: ["open ai labs"] },
      ]);
      const a = applyGlossary("visit open ai labs and open ai today", compiled);
      const b = applyGlossary("visit open ai labs and open ai today", compiled);
      expect(a).toEqual(b);
    });
  });

  describe("parseGlossary", () => {
    it("throws CastrecallSetupError when the input is not an object with a terms array", () => {
      expect(() => parseGlossary(null)).toThrow(CastrecallSetupError);
      expect(() => parseGlossary([])).toThrow(CastrecallSetupError);
      expect(() => parseGlossary({})).toThrow(CastrecallSetupError);
      expect(() => parseGlossary({ terms: "nope" })).toThrow(CastrecallSetupError);
    });

    it("throws CastrecallSetupError when canonical is missing or empty", () => {
      expect(() => parseGlossary({ terms: [{ variants: ["x"] }] })).toThrow(CastrecallSetupError);
      expect(() => parseGlossary({ terms: [{ canonical: "", variants: ["x"] }] })).toThrow(
        CastrecallSetupError,
      );
    });

    it("throws CastrecallSetupError when variants is missing, empty, or non-string", () => {
      expect(() => parseGlossary({ terms: [{ canonical: "X" }] })).toThrow(CastrecallSetupError);
      expect(() => parseGlossary({ terms: [{ canonical: "X", variants: [] }] })).toThrow(
        CastrecallSetupError,
      );
      expect(() => parseGlossary({ terms: [{ canonical: "X", variants: [42] }] })).toThrow(
        CastrecallSetupError,
      );
    });

    it("scales to large glossaries with a bounded number of scans (issue #46 review: no per-variant full-text passes)", () => {
      // 1,000 variants over a long transcript: the scanner does at most one
      // native pass per case class, so this must complete quickly AND still
      // apply corrections exactly like the small-glossary path.
      const entries = Array.from({ length: 1000 }, (_, i) => ({
        canonical: `Product${i}`,
        variants: [`produkt ${i}`],
      }));
      const compiled = compileGlossary(entries);
      const filler = "plain narration continues here with ordinary words. ";
      const text = `${filler.repeat(200)}we compared produkt 7 against produkt 421 today. ${filler.repeat(200)}`;

      const started = performance.now();
      const result = applyGlossary(text, compiled);
      const elapsedMs = performance.now() - started;

      expect(result.text).toContain("Product7 against Product421");
      expect(result.corrections).toEqual(
        expect.arrayContaining([
          { canonical: "Product7", variant: "produkt 7", count: 1 },
          { canonical: "Product421", variant: "produkt 421", count: 1 },
        ]),
      );
      // Generous smoke ceiling — the pre-fix per-variant scan (1,000 full
      // passes over ~20k chars) sat well above this on the same hardware.
      expect(elapsedMs).toBeLessThan(1500);
    });

    it("applies corrections when the micro sign folds to Greek mu under /iu but not under toLowerCase", () => {
      // U+00B5 MICRO SIGN case-folds to U+03BC GREEK SMALL MU under /iu, but
      // "\u00b5".toLowerCase() stays U+00B5 — the constant-time fast path
      // misses and the anchored-/iu fallback must identify the variant.
      const compiled = compileGlossary([
        { canonical: "MicroService", variants: ["\u03bcservice"] },
      ]);
      const result = applyGlossary("we shipped \u00b5service last week", compiled);
      expect(result.text).toContain("we shipped MicroService last week");
      expect(result.corrections).toEqual([
        { canonical: "MicroService", variant: "\u03bcservice", count: 1 },
      ]);
    });

    it("accepts a well-formed glossary", () => {
      const parsed = parseGlossary({
        terms: [{ canonical: "ChatGPT", variants: ["chat gpt"], matchCase: false }],
      });
      expect(parsed.terms).toEqual([{ canonical: "ChatGPT", variants: ["chat gpt"], matchCase: false }]);
    });
  });
});
