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

import { CastrecallSetupError, type ResolvedConfig } from "./config.js";
import { PocketCastsApiError } from "./pocketcasts/client.js";
import { LOCK_TTL_MS, Storage } from "./storage.js";
import { fetchTranscript, generateReview, syncHistory, type ToolDeps } from "./tools.js";

/** Renew the run lock at half the abandonment TTL, so a run that legitimately
 * takes longer than `LOCK_TTL_MS` (e.g. local-Whisper transcription) is never
 * mistaken for a crashed one and reclaimed mid-run. */
const LOCK_HEARTBEAT_INTERVAL_MS = Math.floor(LOCK_TTL_MS / 2);

export type PipelineParams = {
  limit?: number;
  /** Bypass the cooldown gate for a manual recovery run. Never use from a scheduler recipe. */
  force?: boolean;
};

export async function runPipeline(
  config: ResolvedConfig,
  params: PipelineParams = {},
  deps: ToolDeps = {},
): Promise<unknown> {
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

    let syncResult: { newListens: Array<{ episodeUuid: string }> };
    try {
      syncResult = (await syncHistory(config, { limit: params.limit }, deps)) as {
        newListens: Array<{ episodeUuid: string }>;
      };
    } catch (error) {
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
    const pendingTranscripts = Object.values(stateAfterSync.episodes).filter(
      (episode) => episode.transcriptStatus === "none",
    );

    let stored = 0;
    let failed = 0;
    const errors: Array<{ stage: "transcript" | "review"; episodeUuid: string; error: string }> = [];
    for (const episode of pendingTranscripts) {
      try {
        const result = (await fetchTranscript(config, { episodeUuid: episode.uuid }, deps)) as {
          status: "stored" | "already-stored" | "no-transcript";
        };
        if (result.status === "stored" || result.status === "already-stored") {
          stored += 1;
        } else {
          failed += 1;
        }
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ stage: "transcript", episodeUuid: episode.uuid, error: message });
        // Persist the failure so setup_status can expose it and the episode
        // stays visible as retryable work for the next scheduled run.
        await storage.updateEpisode(episode.uuid, { transcriptError: message }, now);
      }
    }

    // Review targets come from durable state, not this run's results: an
    // episode stored by a prior run that crashed (or errored) before its
    // review was generated must be picked up here, or it stays stranded
    // until a human runs the per-episode tools.
    const stateAfterTranscripts = await storage.loadState();
    const reviewTargets = Object.values(stateAfterTranscripts.episodes)
      .filter((episode) => episode.transcriptStatus === "stored" && !episode.reviewGeneratedAt)
      .map((episode) => episode.uuid);

    let generated = 0;
    let skipped = 0;
    for (const episodeUuid of reviewTargets) {
      try {
        const result = (await generateReview(config, { episodeUuid }, deps)) as {
          generated: unknown[];
          skipped: unknown[];
        };
        generated += result.generated.length;
        skipped += result.skipped.length;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ stage: "review", episodeUuid, error: message });
        await storage.updateEpisode(episodeUuid, { reviewError: message }, now);
      }
    }

    return {
      newListens: syncResult.newListens.length,
      transcripts: { stored, failed },
      reviews: { generated, skipped },
      ...(errors.length > 0 ? { errors } : {}),
    };
  } finally {
    clearInterval(heartbeat);
    await storage.releasePipelineLock(lock.token);
  }
}
