import { describe, expect, it } from "vitest";
import { detectFormat, htmlToText, normalizeTranscript } from "./normalize.js";

const VTT = `WEBVTT

NOTE this is a comment

1
00:00:00.000 --> 00:00:04.000
<v Alice>Welcome to the show.

00:00:04.000 --> 00:00:08.000
<v Bob>Thanks for having me.

00:00:08.000 --> 00:00:12.000
<v Bob>Thanks for having me.
`;

const SRT = `1
00:00:00,000 --> 00:00:04,000
Alice: Welcome to the show.

2
00:00:04,000 --> 00:00:08,000
It is <i>great</i> to be here.
`;

const JSON_TRANSCRIPT = JSON.stringify({
  version: "1.0.0",
  segments: [
    { startTime: 0, endTime: 4, speaker: "Alice", body: "Welcome to the show." },
    { startTime: 4, endTime: 8, speaker: "Bob", body: "Thanks for having me." },
  ],
});

describe("detectFormat", () => {
  it("uses the MIME type first", () => {
    expect(detectFormat({ contentType: "text/vtt", body: "anything" })).toBe("vtt");
    expect(detectFormat({ contentType: "application/x-subrip", body: "x" })).toBe("srt");
  });

  it("falls back to URL extension, then content sniffing", () => {
    expect(detectFormat({ url: "https://a/t.srt?x=1", body: "x" })).toBe("srt");
    expect(detectFormat({ body: VTT })).toBe("vtt");
    expect(detectFormat({ body: SRT })).toBe("srt");
    expect(detectFormat({ body: JSON_TRANSCRIPT })).toBe("json");
    expect(detectFormat({ body: "<html><body>hi</body></html>" })).toBe("html");
    expect(detectFormat({ body: "plain words here" })).toBe("txt");
  });
});

describe("normalizeTranscript", () => {
  it("parses VTT with voice tags, skipping headers and duplicate cues", () => {
    const result = normalizeTranscript(VTT, "vtt");
    expect(result.text).toContain("Alice: Welcome to the show.");
    expect(result.text).toContain("Bob: Thanks for having me.");
    expect(result.text.match(/Thanks for having me/g)).toHaveLength(1);
    expect(result.segments?.[0]).toMatchObject({ speaker: "Alice", start: "00:00:00.000" });
  });

  it("parses SRT with speaker prefixes and strips formatting tags", () => {
    const result = normalizeTranscript(SRT, "srt");
    expect(result.text).toContain("Welcome to the show.");
    expect(result.text).toContain("It is great to be here.");
    expect(result.text).not.toContain("<i>");
    expect(result.segments).toHaveLength(2);
  });

  it("parses podcast-namespace JSON segments", () => {
    const result = normalizeTranscript(JSON_TRANSCRIPT, "json");
    expect(result.text).toContain("Alice: Welcome to the show.");
    expect(result.text).toContain("Bob: Thanks for having me.");
    expect(result.segments).toHaveLength(2);
  });

  it("throws a clear error for malformed JSON", () => {
    expect(() => normalizeTranscript("not json", "json")).toThrowError(/could not be parsed/);
    expect(() => normalizeTranscript("{}", "json")).toThrowError(/segments/);
  });

  it("normalizes plain text whitespace", () => {
    const result = normalizeTranscript("hello   world\r\n\r\n\r\nnext  line", "txt");
    expect(result.text).toBe("hello world\n\nnext line");
  });
});

describe("htmlToText", () => {
  it("strips tags, scripts, and decodes entities", () => {
    const html = `<html><script>alert(1)</script><body><p>Hello &amp; welcome.</p><p>Second&nbsp;para</p></body></html>`;
    const text = htmlToText(html);
    expect(text).toBe("Hello & welcome.\nSecond para");
    expect(text).not.toContain("alert");
  });
});
