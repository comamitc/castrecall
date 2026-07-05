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
/** Capped exponential backoff for the periodic-sync cooldown gate. */
export declare const BACKOFF_BASE_MS: number;
export declare const BACKOFF_CAP_MS: number;
/** A lock older than this is presumed abandoned by a crashed run and is reclaimable. */
export declare const LOCK_TTL_MS: number;
/** The reclaim mutex guards a fast local critical section; anything older is a crashed reclaimer. */
export declare const RECLAIM_MUTEX_TTL_MS = 30000;
export type SyncHealth = {
    consecutiveFailures: number;
    lastError?: string;
    lastErrorAt?: string;
    /** Set only while backing off; cleared on the next success. */
    nextEligibleAt?: string;
};
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
    /** Last scheduled-run review-stage failure for this episode, if any. */
    reviewError?: string;
    /** When corpus export last succeeded for this episode (only set when export is enabled). */
    exportedAt?: string;
    /** Last corpus-export failure for this episode, if any; cleared on the next successful export. */
    exportError?: string;
    reviewGeneratedAt?: string;
    updatedAt: string;
};
export type CastrecallState = {
    version: 1;
    /** External data-dir contract version — see SCHEMA_VERSION. */
    schemaVersion: number;
    lastSyncAt?: string;
    episodes: Record<string, ListenRecord>;
    sync?: SyncHealth;
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
    /** Clear backoff state after a successful login + history fetch. */
    recordSyncSuccess(now?: () => Date): Promise<void>;
    /**
     * Record a sync failure and compute the next eligible retry time via
     * capped exponential backoff, so a scheduler never hammers the unofficial
     * Pocket Casts API.
     */
    recordSyncFailure(message: string, now?: () => Date): Promise<SyncHealth>;
    private get lockPath();
    /**
     * Exclusive-create a run lock so overlapping scheduler invocations never
     * both hit the unofficial Pocket Casts API concurrently. A lock older than
     * `LOCK_TTL_MS` is presumed abandoned by a crashed run and is reclaimed.
     */
    acquirePipelineLock(now?: () => Date): Promise<{
        acquired: true;
        token: string;
    } | {
        acquired: false;
    }>;
    /** The reclaim mutex file contains its owner's token; ownership = content match. */
    private ownsReclaimMutex;
    private get reclaimMutexPath();
    /**
     * Test-only seam for orchestrating reclaim interleavings; never set in
     * production code.
     */
    lockTestHooks?: {
        insideReclaimMutex?: () => Promise<void>;
        afterEvict?: () => Promise<void>;
    };
    /**
     * Exclusive-create the short-lived reclaim mutex. The mutex guards a
     * fast, purely local critical section, so a mutex older than
     * `RECLAIM_MUTEX_TTL_MS` can only belong to a crashed reclaimer; it is
     * stolen with an exclusive rename (only one thief can win) before
     * re-creating.
     */
    private acquireReclaimMutex;
    /**
     * Exclusive-create the lock file and stamp its mtime from the caller's
     * clock (mtime is the staleness authority; the payload is informational).
     */
    private createLockExclusive;
    /**
     * Renew a held lock so a still-running pipeline invocation (e.g. a slow
     * local-Whisper transcription well past `LOCK_TTL_MS`) is never reclaimed
     * as abandoned. Renewal is a pure token-verified TOUCH (utimes) — it never
     * writes or renames the lock file. That makes it safe under any
     * interleaving with stale reclaim: if this holder already lost the lock,
     * the token check fails and it stops renewing; in the worst case a renewal
     * that races a reclaim touches the NEW holder's live lock, which merely
     * refreshes an already-live lock and can never produce two holders.
     */
    renewPipelineLock(token: string, now?: () => Date): Promise<boolean>;
    /** Release a held lock — only if `token` still matches the current holder. */
    releasePipelineLock(token: string): Promise<void>;
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
