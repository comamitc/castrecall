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
 *   review/pending/digest-<slug>.md — approval-gated cross-episode digests
 *   review/resolved/<episodeUuid>.md — candidates moved out after castrecall_resolve_review
 *
 * Promoted note content itself goes to the user-configured notes
 * destination (CASTRECALL_NOTES_DIR / notesDir), never here.
 *
 * Nothing here is ever written into OpenClaw's durable memory by CastRecall.
 */
import type { PocketCastsEpisode } from "./pocketcasts/client.js";
import type { LocalWhisperGeneration } from "./transcripts/local-whisper.js";
import type { RemoteSttGeneration } from "./transcripts/remote-stt.js";
import { type TranscriptSegment } from "./transcripts/normalize.js";
import type { TranscriptQuality } from "./transcripts/quality.js";
/**
 * Version of the on-disk data-dir contract (provenance.json / state.json
 * shape). Bump only for breaking changes; new fields are additive within a
 * major version — see docs/ARCHITECTURE.md.
 */
export declare const SCHEMA_VERSION = 1;
/**
 * "quarantined" (issue #42): the transcript ladder produced text but a
 * repetition-loop check (see `transcripts/loop-detection.ts`) flagged it as
 * likely Whisper/STT corruption. No transcript artifact is written for a
 * quarantined episode — `hasTranscript` stays false — so it is excluded from
 * search/export/review (all of which filter on `"stored"`) and from
 * scheduled auto-retry (`selectPendingTranscripts` only re-queues `"none"`,
 * which avoids re-running the same looping model forever), while remaining
 * eligible for an operator-initiated regeneration: change
 * `CASTRECALL_LOCAL_WHISPER_PRESET`/provider and call
 * `castrecall_fetch_transcript` again.
 */
export type TranscriptStatus = "none" | "stored" | "failed" | "quarantined";
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
    /** Disposition history recorded by castrecall_resolve_review — set once a pending review is resolved. */
    reviewDisposition?: "promote" | "discard";
    reviewResolvedAt?: string;
    /** Path of the note written under notesDir; only set when reviewDisposition is "promote". */
    promotedNotePath?: string;
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
/**
 * Episodes still missing a stored transcript (transcriptStatus "none"),
 * honoring per-episode retry/recheck backoff: an episode whose last attempt
 * carries a future nextEligibleAt is reported as deferred, not pending, so
 * scheduled runs and the transcription preflight (issue #55) agree on the
 * same worklist a real run would use. Shared by runPipeline and
 * transcriptionPreflight so the preflight's episode count can never drift
 * from what a run would actually attempt.
 */
export declare function selectPendingTranscripts(episodes: ListenRecord[], nowMs: number): {
    pending: ListenRecord[];
    deferred: number;
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
    /**
     * Exact generation provenance: local-transcription details (issue #54,
     * backend/model/preset/decode settings/output shape) when `transcriptSource`
     * is `"local-whisper"`, or remote-stt details (issue #61, implementation/
     * model/host/mode) when `transcriptSource` is `"stt"` and the configured
     * provider was `remote-stt`. Discriminated by `generation.kind`. Additive,
     * so pre-#54/#61 sidecars simply lack it.
     */
    generation?: LocalWhisperGeneration | RemoteSttGeneration;
    /**
     * Deterministic transcript quality score (issue #41): score, tier
     * (`quote-safe`/`reviewable`/`search-only`), and machine-readable reasons.
     * Additive; pre-#41 sidecars simply lack it.
     */
    quality?: TranscriptQuality;
    /**
     * Deterministic cleanup pass provenance (issue #45): version, the named
     * transform steps that actually changed the text, and a hash (see
     * `hashNormalizedTranscript`) of the pre-cleanup normalized text *and cue
     * timing* the steps were applied to. The hash is the identity proof for
     * `deriveSegmentsFromRaw`'s cleanup-equivalent recovery path — matching
     * `applied` step names alone only proves the same steps *would* fire on
     * some input, and hashing text alone only proves the caption text is
     * unchanged, not that the raw artifact's cue timestamps are.
     * Present whenever cleanup ran, even with `applied: []` (ran, no-op) —
     * omitted entirely when cleanup was disabled
     * (`CASTRECALL_TRANSCRIPT_CLEANUP=0`), distinguishing "ran, no-op" from
     * "never ran". Additive; pre-#45 sidecars simply lack it, and sidecars
     * written before the hash existed carry `version`/`applied` without
     * `rawTextHash` — the type keeps the field optional so those supported
     * legacy shapes are representable without casts; new writes always
     * include it, and recovery falls back to exact-match when it's absent.
     */
    cleanup?: {
        version: number;
        applied: string[];
        rawTextHash?: string;
    };
    /**
     * Optional proper-noun correction glossary provenance (issue #46): version
     * and the canonical/variant/count triples that actually fired. Present
     * whenever the glossary ran, even with `corrections: []` (configured, no
     * match) — omitted entirely when no glossary file was configured,
     * distinguishing "ran, no matches" from "never ran", mirroring `cleanup?`.
     * Additive; pre-#46 sidecars simply lack it. Glossary-corrected
     * `storedText` intentionally diverges from `cleanTranscript(raw).text`, so
     * `deriveSegmentsFromRaw`'s cleanup-equivalent recovery never matches for
     * these writes — harmless, since these are new writes that always land a
     * `segments.json` sidecar; recovery logic itself is unchanged.
     */
    glossary?: {
        version: number;
        corrections: Array<{
            canonical: string;
            variant: string;
            count: number;
        }>;
    };
    fetchedAt: string;
    privacyClass: "private-source";
};
/**
 * True when `generation` is local-whisper provenance. Recognizes both the
 * documented `kind: "local-whisper"` discriminator (issue #61) and sidecars
 * written before that discriminator existed — those carry local-whisper-only
 * fields like `backend`/`decode` with no `kind` at all, and must still be
 * treated as local-whisper rather than silently falling through as neither
 * local nor remote.
 */
export declare function isLocalWhisperGeneration(gen: LocalWhisperGeneration | RemoteSttGeneration | undefined): gen is LocalWhisperGeneration;
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
    /** Only set when the stored artifact carried a non-empty `segments` array (issue #43). */
    segmentsPath?: string;
    alreadyStored: boolean;
};
export declare class Storage {
    readonly dataDir: string;
    constructor(dataDir: string);
    private get statePath();
    sourceDir(episodeUuid: string): string;
    reviewPendingDir(): string;
    reviewResolvedDir(): string;
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
     * Read the optional `segments.json` sidecar (issue #43). Additive: episodes
     * stored before this sidecar existed, or stored from a source with no
     * segment timing (e.g. plain text), simply have no file — this returns
     * `undefined` rather than throwing, same tolerance as `readProvenance`.
     */
    readSegments(episodeUuid: string): Promise<TranscriptSegment[] | undefined>;
    /**
     * Recover segment timing for a transcript stored before the `segments.json`
     * sidecar existed (issue #43), by re-normalizing the still-present
     * `raw.<ext>` artifact — never by re-fetching. Only trusted when the
     * freshly normalized text matches `expectedText` exactly, OR the freshly
     * normalized text-and-timing hashes (via `hashNormalizedTranscript`) to the
     * stored `cleanup.rawTextHash` (proving it's the same pre-cleanup text
     * *and cue timing* the stored `applied` steps actually ran against, not
     * merely drifted text/timestamps that happen to clean to the same output)
     * AND cleaning it reproduces `expectedText` with an identical `applied`
     * step list. Sidecars without a `rawTextHash` (pre-fix) fall back to
     * exact-match only. Returns `undefined` when there is no raw artifact, its
     * format is unrecognized, it fails to parse, or neither form matches.
     */
    deriveSegmentsFromRaw(episodeUuid: string, expectedText: string): Promise<TranscriptSegment[] | undefined>;
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
        segments?: TranscriptSegment[];
    }): Promise<StoredTranscript>;
    reviewCandidatePath(episodeUuid: string): string;
    /** Write a review candidate once; never overwrite a pending review. */
    writeReviewCandidate(episodeUuid: string, markdown: string): Promise<{
        path: string;
        alreadyExists: boolean;
    }>;
    resolvedCandidatePath(episodeUuid: string): string;
    hasPendingReview(episodeUuid: string): Promise<boolean>;
    /**
     * Move a pending review candidate into review/resolved/. Returns
     * `moved: false` (instead of throwing) when there is nothing pending for
     * this episode — either it was never generated, or a prior resolve
     * already moved it — so the caller can surface an actionable error rather
     * than silently no-op. Uses link+unlink rather than rename so an existing
     * resolved candidate at the destination is never silently clobbered —
     * `fs.rename` would replace it outright; `alreadyResolved: true` lets the
     * caller surface that conflict instead.
     */
    resolvePendingReview(episodeUuid: string): Promise<{
        moved: boolean;
        resolvedPath: string;
        alreadyResolved: boolean;
    }>;
    /**
     * Undo a successful `resolvePendingReview` move — used only when the
     * follow-up state write (updateEpisode) fails after the move succeeded, so
     * a retry lands on the same pending-review path instead of a candidate
     * that is resolved-on-disk but has no recorded disposition.
     */
    revertResolvedReview(episodeUuid: string): Promise<void>;
    /**
     * Write a promoted note once; never overwrite an existing note at the same
     * path. Creates `notesDir` on demand — same create-on-demand precedent as
     * `CorpusExporter.exportEpisode` — so a configured-but-not-yet-existing
     * destination is a normal write, not a failure.
     */
    writePromotedNote(notesDir: string, filename: string, markdown: string): Promise<{
        path: string;
        alreadyExists: boolean;
    }>;
    /** Remove a written promoted note — used to clean up an orphan when the caller loses a resolve race. */
    deletePromotedNote(filePath: string): Promise<void>;
    digestPath(slug: string): string;
    /** Write a digest once; never overwrite a pending digest — same write-once semantics as writeReviewCandidate. */
    writeDigest(slug: string, markdown: string): Promise<{
        path: string;
        alreadyExists: boolean;
    }>;
    listPendingReviews(): Promise<string[]>;
}
