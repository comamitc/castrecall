/**
 * Chained pipeline for scheduled/background runs: sync history → fetch
 * transcripts for newly seen listens → generate review candidates for
 * episodes newly stored this run (corpus export chains inside
 * `fetchTranscript` already, when `CASTRECALL_EXPORT_DIR` is set).
 *
 * A run lock (renewed on a heartbeat so a long-running invocation, e.g. local
 * Whisper transcription, is never mistaken for a crashed one) keeps two
 * overlapping scheduler invocations from both hitting the unofficial Pocket
 * Casts API; a cooldown gate with capped exponential backoff keeps a
 * persistently failing API from being hammered on every scheduler tick. This
 * module has no knowledge of cron or intervals for *scheduling* runs — see
 * the README's "Scheduled / periodic sync" section for the actual scheduling
 * recipes.
 */
import { CastrecallSetupError } from "./config.js";
import { PocketCastsApiError } from "./pocketcasts/client.js";
import { LOCK_TTL_MS, Storage } from "./storage.js";
import { exportAndRecord, fetchTranscript, generateReview, syncHistory, } from "./tools.js";
/** Renew the run lock at half the abandonment TTL, so a run that legitimately
 * takes longer than `LOCK_TTL_MS` (e.g. local-Whisper transcription) is never
 * mistaken for a crashed one and reclaimed mid-run. */
const LOCK_HEARTBEAT_INTERVAL_MS = Math.floor(LOCK_TTL_MS / 2);
export async function runPipeline(config, params = {}, deps = {}) {
    const now = deps.now ?? (() => new Date());
    const storage = new Storage(config.dataDir);
    await storage.init();
    let lock = await storage.acquirePipelineLock(now);
    if (!lock.acquired && lock.staleLockAgeMs !== undefined && params.breakStaleLock) {
        // Explicit human-approved recovery only — never from a scheduler.
        try {
            lock = await storage.breakStaleLock(now);
        }
        catch (error) {
            if (error instanceof CastrecallSetupError) {
                return { skipped: "recovery-blocked", note: error.message };
            }
            throw error;
        }
    }
    if (!lock.acquired) {
        if (lock.recoveryBlocked) {
            return {
                skipped: "recovery-blocked",
                note: "A stale-lock recovery is in progress — or a recovery was hard-killed and left its " +
                    "mutex behind (<dataDir>/.staging/pipeline.lock.recovery). If castrecall_setup_status " +
                    "shows the recovery mutex with no live recovery running, remove that file manually; " +
                    "scheduled runs resume on the next tick.",
            };
        }
        if (lock.staleLockAgeMs !== undefined) {
            return {
                skipped: "stale-lock",
                staleLockAgeMs: lock.staleLockAgeMs,
                note: `The run lock has not been renewed for ${Math.round(lock.staleLockAgeMs / 60_000)} minutes — ` +
                    "almost certainly a hard-killed run (normal failures release the lock). CastRecall never " +
                    "breaks a lock automatically. After confirming no run is alive, re-run with " +
                    "breakStaleLock: true to recover.",
            };
        }
        return { skipped: "locked", note: "Another pipeline run holds the lock; this run is a no-op." };
    }
    // If a renewal ever fails, this run no longer owns the lock (released or
    // explicitly broken by a human recovery while this process was suspended).
    // The loops below check the flag at each episode boundary and bail so two
    // runs never work concurrently for longer than one in-flight episode.
    let lockLost = false;
    const heldToken = lock.token;
    const heartbeat = setInterval(() => {
        void storage.renewPipelineLock(heldToken, now).then((outcome) => {
            // Only a DEFINITIVE loss (lock gone or re-tokened) aborts the run; a
            // transient filesystem error must not — we still own the lock, and the
            // token-checked release in `finally` stays responsible for cleanup.
            if (outcome === "lost")
                lockLost = true;
        });
    }, LOCK_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();
    try {
        if (!params.force) {
            const state = await storage.loadState();
            const nextEligibleAt = state.sync?.nextEligibleAt;
            if (nextEligibleAt && now() < new Date(nextEligibleAt)) {
                return {
                    skipped: "cooldown",
                    nextEligibleAt,
                    lastError: state.sync?.lastError,
                    note: "Backing off after repeated sync failures; not hammering Pocket Casts. Pass force: true for a manual retry.",
                };
            }
        }
        let syncResult;
        try {
            syncResult = (await syncHistory(config, { limit: params.limit }, deps));
        }
        catch (error) {
            if (error instanceof CastrecallSetupError || error instanceof PocketCastsApiError) {
                const health = await storage.recordSyncFailure(error.message, now);
                return {
                    ok: false,
                    stage: "sync",
                    reason: error.message,
                    nextEligibleAt: health.nextEligibleAt,
                };
            }
            throw error;
        }
        await storage.recordSyncSuccess(now);
        // Resume from durable state, not just this run's sync result: an episode
        // recorded by a prior run whose transcript/review stage then crashed is
        // still transcriptStatus "none" and would otherwise never be retried,
        // since recordListens only reports it as "new" once.
        const stateAfterSync = await storage.loadState();
        // Honor per-episode retry backoff: an episode whose last transcript
        // attempt failed transiently (retryable STT error) carries a
        // nextEligibleAt, and re-attempting before then would re-bill a paid STT
        // provider on every scheduled tick. Deferred episodes are reported, not
        // silently dropped; fetch_transcript run manually is never gated.
        const nowMs = now().getTime();
        const pendingTranscripts = [];
        let deferred = 0;
        for (const episode of Object.values(stateAfterSync.episodes)) {
            if (episode.transcriptStatus !== "none")
                continue;
            const eligibleAt = episode.transcriptRetry
                ? Date.parse(episode.transcriptRetry.nextEligibleAt)
                : Number.NEGATIVE_INFINITY;
            if (Number.isFinite(eligibleAt) && eligibleAt > nowMs) {
                deferred += 1;
                continue;
            }
            pendingTranscripts.push(episode);
        }
        let stored = 0;
        let failed = 0;
        const errors = [];
        for (const episode of pendingTranscripts) {
            if (lockLost)
                break;
            try {
                const result = (await fetchTranscript(config, { episodeUuid: episode.uuid }, deps));
                if (result.status === "stored" || result.status === "already-stored") {
                    stored += 1;
                }
                else {
                    failed += 1;
                }
            }
            catch (error) {
                failed += 1;
                const message = error instanceof Error ? error.message : String(error);
                errors.push({ stage: "transcript", episodeUuid: episode.uuid, error: message });
                // Persist the failure so setup_status can expose it and the episode
                // stays visible as retryable work for the next scheduled run.
                await storage.updateEpisode(episode.uuid, { transcriptError: message }, now);
            }
        }
        // Downstream worklists come from durable state, not this run's results:
        // an episode stored by a prior run that crashed (or errored) before its
        // export/review completed must be picked up here, or it stays stranded
        // until a human runs the per-episode tools.
        const stateAfterTranscripts = await storage.loadState();
        // Export pass: run the exporter for EVERY stored episode. The exporter's
        // own content-hash check is the cheap no-op (`skipped: true` when the
        // target already matches), which makes export self-healing: a changed
        // CASTRECALL_EXPORT_DIR, a deleted export tree, or a failure recorded by
        // a prior run all converge on the next scheduled tick. State markers
        // (exportedAt/exportError) are observability, never the skip condition.
        let exported = 0;
        if (config.exportDir) {
            const exportTargets = Object.values(stateAfterTranscripts.episodes).filter((episode) => episode.transcriptStatus === "stored");
            for (const episode of exportTargets) {
                if (lockLost)
                    break;
                const result = await exportAndRecord(config, storage, episode, now);
                if (result && "error" in result) {
                    errors.push({ stage: "export", episodeUuid: episode.uuid, error: result.error });
                }
                else if (result && !result.skipped) {
                    exported += 1;
                }
            }
        }
        const reviewTargets = Object.values(stateAfterTranscripts.episodes)
            .filter((episode) => episode.transcriptStatus === "stored" && !episode.reviewGeneratedAt)
            .map((episode) => episode.uuid);
        let generated = 0;
        let skipped = 0;
        for (const episodeUuid of reviewTargets) {
            if (lockLost)
                break;
            try {
                const result = (await generateReview(config, { episodeUuid }, deps));
                generated += result.generated.length;
                skipped += result.skipped.length;
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                errors.push({ stage: "review", episodeUuid, error: message });
                await storage.updateEpisode(episodeUuid, { reviewError: message }, now);
            }
        }
        return {
            newListens: syncResult.newListens.length,
            transcripts: { stored, failed, ...(deferred > 0 ? { deferred } : {}) },
            ...(config.exportDir ? { exports: { exported } } : {}),
            reviews: { generated, skipped },
            ...(errors.length > 0 ? { errors } : {}),
            ...(lockLost
                ? {
                    aborted: "lock-lost",
                    note: "The run lock was lost mid-run (released or broken by an explicit recovery while " +
                        "this process was suspended); remaining work was left for the next scheduled run.",
                }
                : {}),
        };
    }
    finally {
        clearInterval(heartbeat);
        // Always attempt release: it is token-checked, so if the lock was truly
        // lost/replaced this is a no-op, and if a heartbeat only failed
        // transiently this prevents stranding a lock we still own.
        await storage.releasePipelineLock(lock.token);
    }
}
