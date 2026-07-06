import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../config.js";
import type { ListenRecord } from "../storage.js";
import { runTranscriptLadder } from "./ladder.js";

function config(env: NodeJS.ProcessEnv = {}) {
  return resolveConfig({}, env);
}

const RECORD: ListenRecord = {
  uuid: "ep-1",
  title: "Episode One",
  podcastUuid: "pod-1",
  podcastTitle: "Example Show",
  audioUrl: "https://cdn.example.com/ep1.mp3",
  firstSeenAt: "2026-07-04T00:00:00.000Z",
  transcriptStatus: "none",
};

// Carries the listened episode with a matching enclosure URL: Listen Notes
// candidates are only accepted after strong episode verification, so the
// candidate feed must actually contain this episode.
const CANDIDATE_FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Example Show</title>
<item><title>Episode One</title><guid>ep-1</guid>
<enclosure url="https://cdn.example.com/ep1.mp3" type="audio/mpeg"/></item>
</channel></rss>`;

function fetchImplWithListenNotes() {
  const calls = { listenNotes: 0 };
  const fetchImpl = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("refresh.pocketcasts.com")) {
      return new Response(JSON.stringify({ result: {} }), { status: 200 });
    }
    if (url.includes("itunes.apple.com")) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (url.includes("listen-api.listennotes.com")) {
      calls.listenNotes++;
      return new Response(
        JSON.stringify({
          results: [{ title_original: "Example Show", rss: "https://feeds.example.com/from-listennotes.xml" }],
        }),
        { status: 200 },
      );
    }
    if (url === "https://feeds.example.com/from-listennotes.xml") {
      return new Response(CANDIDATE_FEED_XML, { status: 200 });
    }
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("runTranscriptLadder feed resolution with Listen Notes configured", () => {
  it("resolves a feed URL via Listen Notes when Pocket Casts and iTunes both miss", async () => {
    const { fetchImpl, calls } = fetchImplWithListenNotes();

    const result = await runTranscriptLadder(
      config({ LISTENNOTES_API_KEY: "ln_x" }),
      RECORD,
      { fetchImpl, env: { PATH: "" }, skipStt: true },
    );

    expect(calls.listenNotes).toBe(1);
    const rss = result.rungs.find((r) => r.rung === "rss")!;
    expect(rss.outcome).not.toBe("failed");
  });

  it("stays failed with the Pocket-Casts-and-iTunes-only message when LISTENNOTES_API_KEY is unset", async () => {
    const { fetchImpl, calls } = fetchImplWithListenNotes();

    const result = await runTranscriptLadder(config({}), RECORD, {
      fetchImpl,
      env: { PATH: "" },
      skipStt: true,
    });

    expect(calls.listenNotes).toBe(0);
    const rss = result.rungs.find((r) => r.rung === "rss")!;
    expect(rss.outcome).toBe("failed");
    expect(rss.detail).toBe(
      "Could not resolve the podcast's RSS feed URL (Pocket Casts feed export and iTunes search both missed).",
    );
  });
});

describe("runTranscriptLadder local-whisper rung with mlx-whisper detected", () => {
  let binDir: string;
  const missAll = (async () => new Response("nope", { status: 404 })) as typeof fetch;

  beforeEach(async () => {
    binDir = await fs.mkdtemp(path.join(os.tmpdir(), "castrecall-bin-"));
    await fs.writeFile(path.join(binDir, "mlx_whisper"), "#!/bin/sh\n", { mode: 0o755 });
  });

  afterEach(async () => {
    await fs.rm(binDir, { recursive: true, force: true });
  });

  it("skips (not hit, not failed) with an actionable CASTRECALL_WHISPER_MODEL message when no model is set", async () => {
    const result = await runTranscriptLadder(config({}), RECORD, {
      fetchImpl: missAll,
      env: { PATH: binDir },
      skipStt: true,
    });

    const whisperRung = result.rungs.find((r) => r.rung === "local-whisper")!;
    expect(whisperRung.outcome).toBe("skipped");
    expect(whisperRung.detail).toContain("CASTRECALL_WHISPER_MODEL=mlx-community/whisper-large-v3-turbo");
  });

  it("names the preset-resolved concrete model in the local-whisper hit detail and transcript provider", async () => {
    // Real subprocess (mirrors the "custom command" tests elsewhere): a stub
    // script that mimics mlx_whisper's --output-dir/--output-format txt
    // contract, so the ladder's real (non-injectable) exec path is exercised.
    // Writes nothing when --output-dir is absent (e.g. issue #54's
    // best-effort `--version` probe), the same as a real CLI would.
    await fs.writeFile(
      path.join(binDir, "mlx_whisper"),
      "#!/bin/sh\n" +
        'audio="$1"; shift\n' +
        "outdir=\"\"\n" +
        'while [ "$#" -gt 0 ]; do\n' +
        '  if [ "$1" = "--output-dir" ]; then outdir="$2"; shift; fi\n' +
        "  shift\n" +
        "done\n" +
        'if [ -n "$outdir" ]; then\n' +
        'base=$(basename "$audio")\n' +
        'name="${base%.*}"\n' +
        'echo "transcribed via mlx preset" > "$outdir/$name.txt"\n' +
        "fi\n",
      { mode: 0o755 },
    );

    const audioFetch = (async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("ep1.mp3")) {
        return new Response("fake audio bytes", { status: 200 });
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;

    const result = await runTranscriptLadder(
      config({ CASTRECALL_LOCAL_WHISPER_PRESET: "best" }),
      RECORD,
      {
        fetchImpl: audioFetch,
        env: { PATH: binDir },
        skipStt: true,
      },
    );

    const whisperRung = result.rungs.find((r) => r.rung === "local-whisper")!;
    expect(whisperRung.outcome).toBe("hit");
    expect(whisperRung.detail).toContain("whisper-large-v3-turbo");
    expect(result.transcript?.provider).toBe("local-whisper:mlx-whisper:whisper-large-v3-turbo");
    // Issue #54: the exact generation provenance rides along on the ladder hit,
    // not just the "local-whisper:<model>" provider label.
    expect(result.transcript?.generation).toMatchObject({
      kind: "local-whisper",
      backend: "mlx-whisper",
      model: "mlx-community/whisper-large-v3-turbo",
      modelSource: "preset",
      preset: "best",
    });
  });

  it("skips the local-whisper rung with skipLocalWhisper on an otherwise-ready config, and never invokes the executable (issue #55)", async () => {
    // A marker file the stub writes only if it's actually invoked, so
    // "never invokes the executable" is proven by the real (non-injectable)
    // exec path, not merely by inspecting the ladder's return value.
    const markerPath = path.join(binDir, "invoked.marker");
    await fs.writeFile(
      path.join(binDir, "mlx_whisper"),
      `#!/bin/sh\ntouch '${markerPath}'\n`,
      { mode: 0o755 },
    );

    const result = await runTranscriptLadder(
      config({ CASTRECALL_LOCAL_WHISPER_PRESET: "best" }),
      RECORD,
      {
        fetchImpl: missAll,
        env: { PATH: binDir },
        skipStt: true,
        skipLocalWhisper: true,
      },
    );

    const whisperRung = result.rungs.find((r) => r.rung === "local-whisper")!;
    expect(whisperRung.outcome).toBe("skipped");
    expect(whisperRung.detail).toContain("Corpus-scale preflight blocked");
    expect(result.transcript).toBeUndefined();
    await expect(fs.access(markerPath)).rejects.toThrow();
  });

  it("still returns an RSS hit before reaching the local-whisper rung when skipLocalWhisper is set (free rungs unaffected)", async () => {
    const feedXml =
      '<?xml version="1.0"?>' +
      '<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0">' +
      "<channel><item><title>Episode One</title><guid>ep-1</guid>" +
      '<enclosure url="https://cdn.example.com/ep1.mp3" />' +
      '<podcast:transcript url="https://cdn.example.com/ep1.vtt" type="text/vtt" />' +
      "</item></channel></rss>";
    const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nAn RSS-provided transcript body.";
    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("export_feed_urls")) {
        return new Response(JSON.stringify({ result: { "pod-1": "https://example.com/feed.xml" } }), {
          status: 200,
        });
      }
      if (url === "https://example.com/feed.xml") {
        return new Response(feedXml, { status: 200 });
      }
      if (url === "https://cdn.example.com/ep1.vtt") {
        return new Response(vtt, { status: 200, headers: { "content-type": "text/vtt" } });
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;

    const result = await runTranscriptLadder(
      config({ CASTRECALL_LOCAL_WHISPER_PRESET: "best" }),
      RECORD,
      { fetchImpl, env: { PATH: binDir }, skipStt: true, skipLocalWhisper: true },
    );

    expect(result.transcript?.source).toBe("rss");
    expect(result.transcript?.text).toContain("An RSS-provided transcript body.");
    // The RSS hit returns before the ladder ever reaches rung 4.
    expect(result.rungs.find((r) => r.rung === "local-whisper")).toBeUndefined();
  });
});

describe("runTranscriptLadder local-whisper rung with structured output (issue #53)", () => {
  let binDir: string;

  beforeEach(async () => {
    binDir = await fs.mkdtemp(path.join(os.tmpdir(), "castrecall-bin-"));
  });

  afterEach(async () => {
    await fs.rm(binDir, { recursive: true, force: true });
  });

  it("returns a json transcript.format/raw/text trio and surfaces an ignored decode option in the hit detail", async () => {
    // Real subprocess mimicking whisper.cpp's -oj/-of contract: parses argv
    // for -of's value and writes whisper.cpp-shaped JSON (a "transcription"
    // array with nested "offsets") to <that base>.json. Writes nothing when
    // -of is absent (e.g. issue #54's best-effort `--version` probe), the
    // same as a real CLI would for a version check.
    await fs.writeFile(
      path.join(binDir, "whisper-cli"),
      "#!/bin/sh\n" +
        'outbase=""\n' +
        'while [ "$#" -gt 0 ]; do\n' +
        '  if [ "$1" = "-of" ]; then outbase="$2"; fi\n' +
        "  shift\n" +
        "done\n" +
        'if [ -n "$outbase" ]; then\n' +
        "cat > \"$outbase.json\" <<'JSON'\n" +
        '{"transcription":[{"text":"Hello from whisper.cpp.","offsets":{"from":0,"to":1200}}]}\n' +
        "JSON\n" +
        "fi\n",
      { mode: 0o755 },
    );

    const audioFetch = (async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("ep1.wav")) return new Response("fake wav bytes", { status: 200 });
      return new Response("nope", { status: 404 });
    }) as typeof fetch;

    const result = await runTranscriptLadder(
      config({
        CASTRECALL_WHISPER_MODEL: "/path/to/ggml.bin",
        CASTRECALL_WHISPER_OUTPUT_FORMAT: "json",
        CASTRECALL_WHISPER_HALLUCINATION_SILENCE_THRESHOLD: "2",
      }),
      { ...RECORD, audioUrl: "https://cdn.example.com/ep1.wav" },
      { fetchImpl: audioFetch, env: { PATH: binDir }, skipStt: true },
    );

    expect(result.transcript?.format).toBe("json");
    expect(result.transcript?.raw).toContain("Hello from whisper.cpp.");
    expect(result.transcript?.text).toContain("Hello from whisper.cpp.");

    const whisperRung = result.rungs.find((r) => r.rung === "local-whisper")!;
    expect(whisperRung.outcome).toBe("hit");
    expect(whisperRung.detail).toContain("hallucinationSilenceThreshold");
  });
});
