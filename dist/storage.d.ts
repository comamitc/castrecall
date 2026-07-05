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
import type { PocketCastsEpisode } from "./pocketcasts/client.js";
/**
 * Version of the on-disk data-dir contract (provenance.json / state.json
 * shape). Bump only for breaking changes; new fields are additive within a
 * major version — see docs/ARCHITECTURE.md.
 */
export declare const SCHEMA_VERSION = 1;
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
export declare class Storage {
    readonly dataDir: string;
    constructor(dataDir: string);
    private get statePath();
    sourceDir(episodeUuid: string): string;
    reviewPendingDir(): string;
    init(): Promise<void>;
    loadState(): Promise<CastrecallState>;
    saveState(state: CastrecallState): Promise<void>;
    /** Record listens idempotently by episode UUID. Returns only newly seen episodes. */
    recordListens(episodes: PocketCastsEpisode[], now?: () => Date): Promise<{
        added: ListenRecord[];
        totalSeen: number;
    }>;
    updateEpisode(episodeUuid: string, patch: Partial<Omit<ListenRecord, "uuid" | "podcastUuid">>, now?: () => Date): Promise<ListenRecord | undefined>;
    hasTranscript(episodeUuid: string): Promise<boolean>;
    readTranscript(episodeUuid: string): Promise<string | undefined>;
    readProvenance(episodeUuid: string): Promise<StoredProvenance | undefined>;
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
    storeTranscript(episodeUuid: string, artifact: {
        raw: string;
        ext: string;
        text: string;
        provenance: Provenance;
    }): Promise<StoredTranscript>;
    reviewCandidatePath(episodeUuid: string): string;
    /** Write a review candidate once; never overwrite a pending review. */
    writeReviewCandidate(episodeUuid: string, markdown: string): Promise<{
        path: string;
        alreadyExists: boolean;
    }>;
    listPendingReviews(): Promise<string[]>;
}
