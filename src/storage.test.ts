import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PocketCastsEpisode } from "./pocketcasts/client.js";
import { Storage, type Provenance, type StoredProvenance } from "./storage.js";

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
  podcastUuid: "pod-1",
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

  it("stamps provenance.json with a stable content hash of the transcript text", async () => {
    const stored = await storage.storeTranscript("ep-1", {
      raw: "WEBVTT\n\nfirst",
      ext: "vtt",
      text: "first version",
      provenance: PROVENANCE,
    });
    const provenance = JSON.parse(
      await fs.readFile(stored.provenancePath, "utf8"),
    ) as StoredProvenance;
    expect(provenance.contentHash).toBe(
      createHash("sha256").update("first version", "utf8").digest("hex"),
    );
    expect(provenance.schemaVersion).toBe(1);
    expect(provenance.podcastUuid).toBe("pod-1");

    // Re-storing with different text must not overwrite the hash: it is
    // computed once, at first write, and stable across re-runs.
    await storage.storeTranscript("ep-1", {
      raw: "different",
      ext: "txt",
      text: "second version",
      provenance: { ...PROVENANCE, transcriptSource: "stt" },
    });
    const stillFirst = JSON.parse(
      await fs.readFile(stored.provenancePath, "utf8"),
    ) as StoredProvenance;
    expect(stillFirst.contentHash).toBe(provenance.contentHash);
  });

  it("stays consistent under concurrent same-episode stores", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        storage.storeTranscript("ep-1", {
          raw: `raw-${i}`,
          ext: "txt",
          text: `text-${i}`,
          provenance: PROVENANCE,
        }),
      ),
    );
    expect(results.filter((r) => !r.alreadyStored)).toHaveLength(1);

    const text = await fs.readFile(path.join(storage.sourceDir("ep-1"), "transcript.txt"), "utf8");
    const provenance = JSON.parse(
      await fs.readFile(path.join(storage.sourceDir("ep-1"), "provenance.json"), "utf8"),
    ) as StoredProvenance;
    expect(provenance.contentHash).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
    const raw = await fs.readFile(
      path.join(storage.sourceDir("ep-1"), `raw.txt`),
      "utf8",
    );
    expect(raw).toBe(`raw-${text.replace("text-", "")}`);

    const entries = await fs.readdir(path.join(dir, "sources"));
    expect(entries).toEqual(["ep-1"]);
  });

  it("produces a valid content hash for empty transcript text", async () => {
    const stored = await storage.storeTranscript("ep-1", {
      raw: "",
      ext: "txt",
      text: "",
      provenance: PROVENANCE,
    });
    const provenance = JSON.parse(
      await fs.readFile(stored.provenancePath, "utf8"),
    ) as StoredProvenance;
    expect(provenance.contentHash).toBe(createHash("sha256").update("", "utf8").digest("hex"));
  });

  it("stamps schemaVersion on state.json alongside the internal version guard", async () => {
    await storage.recordListens([EPISODE]);
    const state = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
    expect(state.version).toBe(1);
    expect(state.schemaVersion).toBe(1);
  });

  it("loads legacy state.json missing schemaVersion without dropping episodes", async () => {
    const legacy = {
      version: 1,
      episodes: { "ep-1": { ...EPISODE, transcriptStatus: "none", firstSeenAt: "x", updatedAt: "x" } },
    };
    await fs.writeFile(path.join(dir, "state.json"), JSON.stringify(legacy), "utf8");
    const state = await storage.loadState();
    expect(state.episodes["ep-1"]).toBeDefined();
    expect(state.schemaVersion).toBe(1);
  });

  it("reads legacy provenance.json missing schemaVersion/contentHash/podcastUuid without throwing", async () => {
    const legacyDir = storage.sourceDir("ep-1");
    await fs.mkdir(legacyDir, { recursive: true });
    const legacyProvenance = {
      platform: "pocketcasts",
      podcastTitle: "Example Show",
      episodeTitle: "Episode One",
      episodeUuid: "ep-1",
      transcriptSource: "rss",
      format: "vtt",
      fetchedAt: "2026-07-04T00:00:00Z",
      privacyClass: "private-source",
    };
    await fs.writeFile(path.join(legacyDir, "provenance.json"), JSON.stringify(legacyProvenance), "utf8");
    const read = await storage.readProvenance("ep-1");
    expect(read?.transcriptSource).toBe("rss");
    expect(read?.contentHash).toBeUndefined();
  });

  it("throws instead of reporting alreadyStored when a stale partial directory blocks publish", async () => {
    const legacyDir = storage.sourceDir("ep-1");
    await fs.mkdir(legacyDir, { recursive: true });
    // Simulates a directory left behind by a pre-atomic-publish writer:
    // raw/provenance present, but transcript.txt never landed.
    await fs.writeFile(path.join(legacyDir, "raw.txt"), "raw", "utf8");
    await fs.writeFile(path.join(legacyDir, "provenance.json"), "{}", "utf8");

    await expect(
      storage.storeTranscript("ep-1", {
        raw: "raw",
        ext: "txt",
        text: "text",
        provenance: PROVENANCE,
      }),
    ).rejects.toThrow(/missing transcript\.txt/);

    // The stale directory must be left untouched for manual inspection, not
    // silently deleted along with the discarded staging directory.
    expect(await fs.readFile(path.join(legacyDir, "raw.txt"), "utf8")).toBe("raw");
  });

  it("never allows updateEpisode to change stable identifiers", async () => {
    await storage.recordListens([EPISODE]);
    const updated = await storage.updateEpisode("ep-1", {
      transcriptStatus: "stored",
      // Smuggle an attempt to change stable IDs past the type system.
      podcastUuid: "evil",
      uuid: "evil",
    } as any);
    expect(updated?.uuid).toBe("ep-1");
    expect(updated?.podcastUuid).toBe("pod-1");
    expect(updated?.transcriptStatus).toBe("stored");
  });
});
