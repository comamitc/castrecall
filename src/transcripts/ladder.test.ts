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
    await fs.writeFile(
      path.join(binDir, "mlx_whisper"),
      "#!/bin/sh\n" +
        'audio="$1"; shift\n' +
        "outdir=\"\"\n" +
        'while [ "$#" -gt 0 ]; do\n' +
        '  if [ "$1" = "--output-dir" ]; then outdir="$2"; shift; fi\n' +
        "  shift\n" +
        "done\n" +
        'base=$(basename "$audio")\n' +
        'name="${base%.*}"\n' +
        'echo "transcribed via mlx preset" > "$outdir/$name.txt"\n',
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
  });
});
