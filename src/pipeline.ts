/**
 * Chained pipeline for scheduled/background runs: sync history → fetch
 * transcripts for newly seen listens → generate review candidates for
 * episodes newly stored this run (corpus export chains inside
 * `fetchTranscript` already, when `CASTRECALL_EXPORT_DIR` is set).
 *
 * A run lock keeps two overlapping scheduler invocations from both hitting
 * the unofficial Pocket Casts API; a cooldown gate with capped exponential
 * backoff keeps a persistently failing API from being hammered on every
 * scheduler tick. Both are host-scheduler-agnostic: this module has no
 * knowledge of cron, heartbeats, or intervals — see the README's "Scheduled
 * / periodic sync" section for the actual scheduling recipes.
 */

import { CastrecallSetupError, type ResolvedConfig } from "./config.js";
import { PocketCastsApiError } from "./pocketcasts/client.js";
import { Storage } from "./storage.js";
import { fetchTranscript, generateReview, syncHistory, type ToolDeps } from "./tools.js";

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

    let stored = 0;
    let failed = 0;
    const reviewTargets: string[] = [];
    for (const listen of syncResult.newListens) {
      const result = (await fetchTranscript(config, { episodeUuid: listen.episodeUuid }, deps)) as {
        status: "stored" | "already-stored" | "no-transcript";
      };
      if (result.status === "stored" || result.status === "already-stored") {
        stored += 1;
        reviewTargets.push(listen.episodeUuid);
      } else {
        failed += 1;
      }
    }

    let generated = 0;
    let skipped = 0;
    for (const episodeUuid of reviewTargets) {
      const result = (await generateReview(config, { episodeUuid }, deps)) as {
        generated: unknown[];
        skipped: unknown[];
      };
      generated += result.generated.length;
      skipped += result.skipped.length;
    }

    return {
      newListens: syncResult.newListens.length,
      transcripts: { stored, failed },
      reviews: { generated, skipped },
    };
  } finally {
    await storage.releasePipelineLock(lock.token);
  }
}
