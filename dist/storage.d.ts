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
/**
 * Attempt budget for TRANSIENT transcript failures (retryable STT errors:
 * rate limits, timeouts, upstream 5xx, network rejections). Each attempt can
 * cost real money on a paid STT provider, so after this many consecutive
 * transient failures the episode is marked terminally "failed" instead of
 * being retried by every scheduled run forever.
 */
export declare const TRANSCRIPT_RETRY_MAX_ATTEMPTS = 5;
/**
 * Capped exponential backoff for polling a transcript that may simply not be
 * published/transcribed YET (Taddy `taddyTranscribeStatus` in progress, or an
 * RSS item with no `<podcast:transcript>` links declared). This is a
 * futile-poll bound, not a billing bound — unlike `TRANSCRIPT_RETRY_MAX_ATTEMPTS`,
 * no paid API call is made on these rungs, so the backoff is measured in hours
 * and the horizon in days rather than attempt count.
 */
export declare const TRANSCRIPT_RECHECK_BASE_MS: number;
export declare const TRANSCRIPT_RECHECK_CAP_MS: number;
/** After this long with no transcript appearing, stop polling and mark the episode terminally failed. */
export declare const TRANSCRIPT_RECHECK_MAX_AGE_MS: number;
/** A lock older than this is presumed abandoned by a crashed run and is reclaimable. */
export declare const LOCK_TTL_MS: number;
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
    /**
     * Retry bookkeeping for transient transcript failures. Scheduled runs skip
     * the episode until `nextEligibleAt` (manual fetch_transcript is never
     * gated), and the episode turns terminally "failed" once
     * TRANSCRIPT_RETRY_MAX_ATTEMPTS is exhausted. Cleared on success and on
     * terminal failure.
     */
    transcriptRetry?: {
        consecutiveFailures: number;
        nextEligibleAt: string;
    };
    /**
     * Availability-poll bookkeeping for a transcript that may simply not exist
     * YET (Taddy still transcribing, or an RSS item with no transcript links
     * declared) — a sibling to `transcriptRetry`, kept separate so its horizon
     * (a futile-poll bound) never blurs with `transcriptRetry`'s paid-STT
     * billing bound. Cleared on success and once `firstDeferredAt` exceeds
     * `TRANSCRIPT_RECHECK_MAX_AGE_MS` (terminal failure).
     */
    transcriptRecheck?: {
        attempts: number;
        nextEligibleAt: string;
        firstDeferredAt: string;
    };
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
    transcriptSource: "rss" | "taddy" | "podchaser" | "local-whisper" | "stt";
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
    /** Private, rebuildable search-index cache — see search.ts. */
    indexDir(): string;
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
     * both hit the unofficial Pocket Casts API concurrently.
     *
     * FAIL-CLOSED DESIGN — there is deliberately NO automatic stale-lock
     * reclaim. Plain POSIX filesystem operations have no compare-and-swap, so
     * every check-then-steal scheme has a stall window in which a delayed
     * reclaimer can evict a fresh holder's live lock (proven repeatedly in
     * review). Instead:
     *   - the scheduled path only ever exclusive-creates (`wx`) and touches
     *     its OWN lock — it can never delete or replace anyone else's;
     *   - a live holder renews the lock's mtime on a heartbeat, so a lock
     *     whose mtime is older than `LOCK_TTL_MS` can only belong to a
     *     hard-killed run (SIGKILL/power loss — normal errors release in
     *     `finally`);
     *   - such a stale lock is REPORTED (`staleLockAgeMs`) and recovery is an
     *     explicit, human-triggered `breakStaleLock` — never scheduled.
     */
    acquirePipelineLock(now?: () => Date): Promise<{
        acquired: true;
        token: string;
    } | {
        acquired: false;
        staleLockAgeMs?: number;
        recoveryBlocked?: boolean;
    }>;
    /**
     * Exclusive acquisition that PARTICIPATES in the recovery mutex: it fails
     * closed while a recovery is in progress, and re-checks after creating —
     * an acquirer that raced past the pre-check while the mutex was being
     * created releases its own lock and backs off. This closes the window
     * where a recovery that already re-verified a stale lock could otherwise
     * remove a fresh lock created by a scheduled tick in that gap: no
     * scheduled acquirer can ever HOLD a lock while the mutex exists.
     */
    private tryAcquireExclusive;
    private recoveryMutexExists;
    private get recoveryMutexPath();
    /**
     * Explicit recovery from a crashed run's leftover lock. Serialized behind
     * an UNSTEALABLE recovery mutex (exclusive-create, no TTL, no takeover):
     * two concurrent recoveries cannot both proceed, so the re-checked stale
     * lock cannot be swapped for a fresh one between the check and the
     * removal. A crashed recovery leaves the mutex behind and every later
     * recovery fails closed with the manual remediation — by design, the
     * failure mode is "a human removes one file", never "two runs proceed".
     * Throws CastrecallSetupError when recovery is blocked; must never be
     * called from a scheduler.
     */
    breakStaleLock(now?: () => Date): Promise<{
        acquired: true;
        token: string;
    } | {
        acquired: false;
        staleLockAgeMs?: number;
    }>;
    /**
     * Read-only lock health for status surfaces: whether a run lock exists,
     * its age, and whether it reads as stale (heartbeat stopped > LOCK_TTL_MS
     * ago — a hard-killed run).
     */
    inspectPipelineLock(now?: () => Date): Promise<({
        held: false;
    } | {
        held: true;
        ageMs: number;
        stale: boolean;
    }) & {
        recoveryMutex?: {
            path: string;
        };
    }>;
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
    renewPipelineLock(token: string, now?: () => Date): Promise<"renewed" | "lost" | "transient-error">;
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
