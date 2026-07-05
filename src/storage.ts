/**
 * Local, private storage for CastRecall.
 *
 * Layout under the data dir (default ~/.openclaw/castrecall):
 *   state.json                     — sync state: seen listens, transcript status
 *   sources/<episodeUuid>/         — raw transcript artifacts (private source material)
 *     raw.<ext>                    — original transcript as fetched/generated
 *     transcript.txt               — normalized plain text
 *     provenance.json              — where it came from and when
 *   review/pending/<episodeUuid>.md — approval-gated review candidates
 *
 * Nothing here is ever written into OpenClaw's durable memory by CastRecall.
 */

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { PocketCastsEpisode } from "./pocketcasts/client.js";

/**
 * Version of the on-disk data-dir contract (provenance.json / state.json
 * shape). Bump only for breaking changes; new fields are additive within a
 * major version — see docs/ARCHITECTURE.md.
 */
export const SCHEMA_VERSION = 1;

export type TranscriptStatus = "none" | "stored" | "failed";

export type ListenRecord = {
  uuid: string;
  title: string;
  podcastUuid: string;
  podcastTitle: string;
  audioUrl: string;
  published?: string;
  duration?: number;
  playedUpTo?: number;
  playingStatus?: number;
  author?: string;
  firstSeenAt: string;
  transcriptStatus: TranscriptStatus;
  transcriptSource?: string;
  transcriptError?: string;
  reviewGeneratedAt?: string;
  updatedAt: string;
};

export type CastrecallState = {
  version: 1;
  /** External data-dir contract version — see SCHEMA_VERSION. */
  schemaVersion: number;
  lastSyncAt?: string;
  episodes: Record<string, ListenRecord>;
};

export type Provenance = {
  platform: "pocketcasts";
  podcastTitle: string;
  podcastUuid: string;
  episodeTitle: string;
  episodeUuid: string;
  episodeUrl?: string;
  audioUrl?: string;
  feedUrl?: string;
  listenTimestamp?: string;
  transcriptSource: "rss" | "taddy" | "local-whisper" | "stt";
  transcriptSourceUrl?: string;
  format: string;
  provider?: string;
  fetchedAt: string;
  privacyClass: "private-source";
};

/**
 * The shape actually persisted to provenance.json: a Provenance plus the
 * fields storage stamps on write (schema version, content hash). Sidecars
 * written before v1 may lack these two fields.
 */
export type StoredProvenance = Provenance & {
  schemaVersion: number;
  contentHash: string;
};

export type StoredTranscript = {
  rawPath: string;
  textPath: string;
  provenancePath: string;
  alreadyStored: boolean;
};

const EMPTY_STATE: CastrecallState = { version: 1, schemaVersion: SCHEMA_VERSION, episodes: {} };

export class Storage {
  constructor(readonly dataDir: string) {}

  private get statePath(): string {
    return path.join(this.dataDir, "state.json");
  }

  sourceDir(episodeUuid: string): string {
    return path.join(this.dataDir, "sources", safeName(episodeUuid));
  }

  reviewPendingDir(): string {
    return path.join(this.dataDir, "review", "pending");
  }

  async init(): Promise<void> {
    await fs.mkdir(path.join(this.dataDir, "sources"), { recursive: true });
    await fs.mkdir(this.reviewPendingDir(), { recursive: true });
  }

  async loadState(): Promise<CastrecallState> {
    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<CastrecallState>;
      if (parsed.version !== 1 || typeof parsed.episodes !== "object") return { ...EMPTY_STATE };
      // schemaVersion is additive: legacy state.json predating it still loads.
      return {
        version: 1,
        lastSyncAt: parsed.lastSyncAt,
        episodes: parsed.episodes,
        schemaVersion: parsed.schemaVersion ?? SCHEMA_VERSION,
      };
    } catch {
      return { ...EMPTY_STATE, episodes: {} };
    }
  }

  async saveState(state: CastrecallState): Promise<void> {
    await this.init();
    const tmpPath = `${this.statePath}.tmp`;
    const stamped: CastrecallState = { ...state, version: 1, schemaVersion: SCHEMA_VERSION };
    await fs.writeFile(tmpPath, `${JSON.stringify(stamped, null, 2)}\n`, "utf8");
    await fs.rename(tmpPath, this.statePath);
  }

  /** Record listens idempotently by episode UUID. Returns only newly seen episodes. */
  async recordListens(
    episodes: PocketCastsEpisode[],
    now: () => Date = () => new Date(),
  ): Promise<{ added: ListenRecord[]; totalSeen: number }> {
    const state = await this.loadState();
    const added: ListenRecord[] = [];
    const timestamp = now().toISOString();
    for (const episode of episodes) {
      if (!episode.uuid || state.episodes[episode.uuid]) continue;
      const record: ListenRecord = {
        uuid: episode.uuid,
        title: episode.title,
        podcastUuid: episode.podcastUuid,
        podcastTitle: episode.podcastTitle,
        audioUrl: episode.url,
        published: episode.published,
        duration: episode.duration,
        playedUpTo: episode.playedUpTo,
        playingStatus: episode.playingStatus,
        author: episode.author,
        firstSeenAt: timestamp,
        transcriptStatus: "none",
        updatedAt: timestamp,
      };
      state.episodes[episode.uuid] = record;
      added.push(record);
    }
    state.lastSyncAt = timestamp;
    await this.saveState(state);
    return { added, totalSeen: Object.keys(state.episodes).length };
  }

  async updateEpisode(
    episodeUuid: string,
    patch: Partial<Omit<ListenRecord, "uuid" | "podcastUuid">>,
    now: () => Date = () => new Date(),
  ): Promise<ListenRecord | undefined> {
    const state = await this.loadState();
    const existing = state.episodes[episodeUuid];
    if (!existing) return undefined;
    // uuid/podcastUuid are stable identifiers: re-pin them post-merge so even
    // an `as any` smuggle can't mutate them.
    const updated = {
      ...existing,
      ...patch,
      uuid: existing.uuid,
      podcastUuid: existing.podcastUuid,
      updatedAt: now().toISOString(),
    };
    state.episodes[episodeUuid] = updated;
    await this.saveState(state);
    return updated;
  }

  async hasTranscript(episodeUuid: string): Promise<boolean> {
    try {
      await fs.access(path.join(this.sourceDir(episodeUuid), "transcript.txt"));
      return true;
    } catch {
      return false;
    }
  }

  async readTranscript(episodeUuid: string): Promise<string | undefined> {
    try {
      return await fs.readFile(path.join(this.sourceDir(episodeUuid), "transcript.txt"), "utf8");
    } catch {
      return undefined;
    }
  }

  async readProvenance(episodeUuid: string): Promise<StoredProvenance | undefined> {
    try {
      const raw = await fs.readFile(
        path.join(this.sourceDir(episodeUuid), "provenance.json"),
        "utf8",
      );
      // Tolerant cast: sidecars written before schemaVersion/contentHash
      // existed may lack them; no downstream reader depends on their presence.
      return JSON.parse(raw) as StoredProvenance;
    } catch {
      return undefined;
    }
  }

  /**
   * Store a transcript with its provenance sidecar. Idempotent: if a
   * transcript already exists for the episode, nothing is overwritten — the
   * content hash is computed once, at first write, and is stable thereafter.
   *
   * Atomic across concurrent same-episode stores: the artifact triad is
   * assembled in a private staging directory and published with a single
   * `rename`, which POSIX guarantees fails (ENOTEMPTY/EEXIST) rather than
   * merges when the destination is already a populated directory. So a
   * racing writer can never land only some of its files — either its whole
   * staged set becomes `dir`, or none of it does and it falls back to
   * `alreadyStored`.
   */
  async storeTranscript(
    episodeUuid: string,
    artifact: { raw: string; ext: string; text: string; provenance: Provenance },
  ): Promise<StoredTranscript> {
    const dir = this.sourceDir(episodeUuid);
    const rawPath = path.join(dir, `raw.${artifact.ext.replace(/^\./, "")}`);
    const textPath = path.join(dir, "transcript.txt");
    const provenancePath = path.join(dir, "provenance.json");
    if (await this.hasTranscript(episodeUuid)) {
      return { rawPath, textPath, provenancePath, alreadyStored: true };
    }
    const contentHash = createHash("sha256").update(artifact.text, "utf8").digest("hex");
    const provenance: StoredProvenance = {
      ...artifact.provenance,
      schemaVersion: SCHEMA_VERSION,
      contentHash,
    };
    const stagingDir = `${dir}.tmp-${randomUUID()}`;
    await fs.mkdir(stagingDir, { recursive: true });
    try {
      await fs.writeFile(path.join(stagingDir, path.basename(rawPath)), artifact.raw, "utf8");
      await fs.writeFile(
        path.join(stagingDir, "provenance.json"),
        `${JSON.stringify(provenance, null, 2)}\n`,
        "utf8",
      );
      await fs.writeFile(path.join(stagingDir, "transcript.txt"), artifact.text, "utf8");
      await fs.rename(stagingDir, dir);
      return { rawPath, textPath, provenancePath, alreadyStored: false };
    } catch (error) {
      await fs.rm(stagingDir, { recursive: true, force: true });
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOTEMPTY" || code === "EEXIST") {
        return { rawPath, textPath, provenancePath, alreadyStored: true };
      }
      throw error;
    }
  }

  reviewCandidatePath(episodeUuid: string): string {
    return path.join(this.reviewPendingDir(), `${safeName(episodeUuid)}.md`);
  }

  /** Write a review candidate once; never overwrite a pending review. */
  async writeReviewCandidate(
    episodeUuid: string,
    markdown: string,
  ): Promise<{ path: string; alreadyExists: boolean }> {
    await this.init();
    const filePath = this.reviewCandidatePath(episodeUuid);
    try {
      await fs.writeFile(filePath, markdown, { encoding: "utf8", flag: "wx" });
      return { path: filePath, alreadyExists: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return { path: filePath, alreadyExists: true };
      }
      throw error;
    }
  }

  async listPendingReviews(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.reviewPendingDir());
      return entries.filter((name) => name.endsWith(".md")).sort();
    } catch {
      return [];
    }
  }
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}
