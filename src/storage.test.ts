import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PocketCastsEpisode } from "./pocketcasts/client.js";
import { Storage, type Provenance } from "./storage.js";

const EPISODE: PocketCastsEpisode = {
  uuid: "ep-1",
  title: "Episode One",
  url: "https://cdn.example.com/ep1.mp3",
  podcastUuid: "pod-1",
  podcastTitle: "Example Show",
  published: "2026-07-01T00:00:00Z",
};

const PROVENANCE: Provenance = {
  platform: "pocketcasts",
  podcastTitle: "Example Show",
  episodeTitle: "Episode One",
  episodeUuid: "ep-1",
  audioUrl: "https://cdn.example.com/ep1.mp3",
  feedUrl: "https://example.com/feed.xml",
  transcriptSource: "rss",
  transcriptSourceUrl: "https://cdn.example.com/ep1.vtt",
  format: "vtt",
  fetchedAt: "2026-07-04T00:00:00Z",
  privacyClass: "private-source",
};

describe("Storage", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "castrecall-test-"));
    storage = new Storage(dir);
    await storage.init();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("records listens idempotently by uuid", async () => {
    const first = await storage.recordListens([EPISODE]);
    expect(first.added).toHaveLength(1);
    expect(first.totalSeen).toBe(1);

    const second = await storage.recordListens([EPISODE, { ...EPISODE, uuid: "ep-2" }]);
    expect(second.added.map((r) => r.uuid)).toEqual(["ep-2"]);
    expect(second.totalSeen).toBe(2);
  });

  it("stores transcripts with provenance sidecars and never overwrites", async () => {
    const stored = await storage.storeTranscript("ep-1", {
      raw: "WEBVTT\n\nfirst",
      ext: "vtt",
      text: "first version",
      provenance: PROVENANCE,
    });
    expect(stored.alreadyStored).toBe(false);
    expect(await fs.readFile(stored.textPath, "utf8")).toBe("first version");
    const provenance = JSON.parse(await fs.readFile(stored.provenancePath, "utf8")) as Provenance;
    expect(provenance.privacyClass).toBe("private-source");
    expect(provenance.transcriptSource).toBe("rss");

    const again = await storage.storeTranscript("ep-1", {
      raw: "different",
      ext: "txt",
      text: "second version",
      provenance: { ...PROVENANCE, transcriptSource: "stt" },
    });
    expect(again.alreadyStored).toBe(true);
    expect(await fs.readFile(stored.textPath, "utf8")).toBe("first version");
  });

  it("keeps raw artifacts separate from review candidates", async () => {
    await storage.storeTranscript("ep-1", {
      raw: "raw",
      ext: "txt",
      text: "text",
      provenance: PROVENANCE,
    });
    const review = await storage.writeReviewCandidate("ep-1", "# Review\n");
    expect(review.path).toContain(`${path.sep}review${path.sep}pending${path.sep}`);
    expect(storage.sourceDir("ep-1")).toContain(`${path.sep}sources${path.sep}`);
  });

  it("writes review candidates once and never overwrites pending reviews", async () => {
    const first = await storage.writeReviewCandidate("ep-1", "original\n");
    expect(first.alreadyExists).toBe(false);
    const second = await storage.writeReviewCandidate("ep-1", "replacement\n");
    expect(second.alreadyExists).toBe(true);
    expect(await fs.readFile(first.path, "utf8")).toBe("original\n");
    expect(await storage.listPendingReviews()).toEqual(["ep-1.md"]);
  });

  it("sanitizes hostile episode uuids used in paths", async () => {
    const evil = "../../escape";
    await storage.storeTranscript(evil, {
      raw: "x",
      ext: "txt",
      text: "x",
      provenance: PROVENANCE,
    });
    const resolved = path.resolve(storage.sourceDir(evil));
    expect(resolved.startsWith(path.resolve(dir))).toBe(true);
  });

  it("survives a missing or corrupt state file", async () => {
    await fs.writeFile(path.join(dir, "state.json"), "{corrupt", "utf8");
    const state = await storage.loadState();
    expect(state.episodes).toEqual({});
  });
});
