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
import { fetchTranscript, generateReview, syncHistory } from "./tools.js";
/** Renew the run lock at half the abandonment TTL, so a run that legitimately
 * takes longer than `LOCK_TTL_MS` (e.g. local-Whisper transcription) is never
 * mistaken for a crashed one and reclaimed mid-run. */
const LOCK_HEARTBEAT_INTERVAL_MS = Math.floor(LOCK_TTL_MS / 2);
export async function runPipeline(config, params = {}, deps = {}) {
    const now = deps.now ?? (() => new Date());
    const storage = new Storage(config.dataDir);
    await storage.init();
    const lock = await storage.acquirePipelineLock(now);
    if (!lock.acquired) {
        return { skipped: "locked", note: "Another pipeline run holds the lock; this run is a no-op." };
    }
    const heartbeat = setInterval(() => {
        void storage.renewPipelineLock(lock.token, now);
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
        const pendingTranscripts = Object.values(stateAfterSync.episodes).filter((episode) => episode.transcriptStatus === "none");
        let stored = 0;
        let failed = 0;
        const reviewTargets = [];
        const errors = [];
        for (const episode of pendingTranscripts) {
            try {
                const result = (await fetchTranscript(config, { episodeUuid: episode.uuid }, deps));
                if (result.status === "stored" || result.status === "already-stored") {
                    stored += 1;
                    reviewTargets.push(episode.uuid);
                }
                else {
                    failed += 1;
                }
            }
            catch (error) {
                failed += 1;
                errors.push({
                    stage: "transcript",
                    episodeUuid: episode.uuid,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        let generated = 0;
        let skipped = 0;
        for (const episodeUuid of reviewTargets) {
            try {
                const result = (await generateReview(config, { episodeUuid }, deps));
                generated += result.generated.length;
                skipped += result.skipped.length;
            }
            catch (error) {
                errors.push({
                    stage: "review",
                    episodeUuid,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        return {
            newListens: syncResult.newListens.length,
            transcripts: { stored, failed },
            reviews: { generated, skipped },
            ...(errors.length > 0 ? { errors } : {}),
        };
    }
    finally {
        clearInterval(heartbeat);
        await storage.releasePipelineLock(lock.token);
    }
}
