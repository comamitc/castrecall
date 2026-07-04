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

import { promises as fs } from "node:fs";
import path from "node:path";
import type { PocketCastsEpisode } from "./pocketcasts/client.js";

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
  lastSyncAt?: string;
  episodes: Record<string, ListenRecord>;
};

export type Provenance = {
  platform: "pocketcasts";
  podcastTitle: string;
  episodeTitle: string;
  episodeUuid: string;
  episodeUrl?: string;
  audioUrl?: string;
  feedUrl?: string;
  listenTimestamp?: string;
  transcriptSource: "rss" | "taddy" | "stt";
  transcriptSourceUrl?: string;
  format: string;
  provider?: string;
  fetchedAt: string;
  privacyClass: "private-source";
};

export type StoredTranscript = {
  rawPath: string;
  textPath: string;
  provenancePath: string;
  alreadyStored: boolean;
};

const EMPTY_STATE: CastrecallState = { version: 1, episodes: {} };

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
      const parsed = JSON.parse(raw) as CastrecallState;
      if (parsed.version !== 1 || typeof parsed.episodes !== "object") return { ...EMPTY_STATE };
      return parsed;
    } catch {
      return { ...EMPTY_STATE, episodes: {} };
    }
  }

  async saveState(state: CastrecallState): Promise<void> {
    await this.init();
    const tmpPath = `${this.statePath}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
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
    patch: Partial<ListenRecord>,
    now: () => Date = () => new Date(),
  ): Promise<ListenRecord | undefined> {
    const state = await this.loadState();
    const existing = state.episodes[episodeUuid];
    if (!existing) return undefined;
    const updated = { ...existing, ...patch, updatedAt: now().toISOString() };
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

  async readProvenance(episodeUuid: string): Promise<Provenance | undefined> {
    try {
      const raw = await fs.readFile(
        path.join(this.sourceDir(episodeUuid), "provenance.json"),
        "utf8",
      );
      return JSON.parse(raw) as Provenance;
    } catch {
      return undefined;
    }
  }

  /**
   * Store a transcript with its provenance sidecar. Idempotent: if a
   * transcript already exists for the episode, nothing is overwritten.
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
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(rawPath, artifact.raw, "utf8");
    await fs.writeFile(provenancePath, `${JSON.stringify(artifact.provenance, null, 2)}\n`, "utf8");
    // transcript.txt last: it is the existence marker for idempotency.
    await fs.writeFile(textPath, artifact.text, "utf8");
    return { rawPath, textPath, provenancePath, alreadyStored: false };
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
