/**
 * Implementations behind the CastRecall tools. Pure functions over
 * (config, params) so they are testable without the OpenClaw runtime.
 */

import { createHash } from "node:crypto";
import { CastrecallSetupError, type ResolvedConfig } from "./config.js";
import { CorpusExporter, type ExportResult } from "./corpus-export.js";
import type { FetchLike } from "./pocketcasts/client.js";
import { isListenedEpisode } from "./pocketcasts/listened.js";
import { detectSecretBackend, type ExecImpl } from "./pocketcasts/secret-store.js";
import {
  fetchHistoryWithSession,
  hasCachedPocketCastsTokenRecord,
  resolvePocketCastsCredentials,
} from "./pocketcasts/session.js";
import { buildReviewCandidate } from "./review.js";
import {
  buildSetupPlan,
  classifyExportDir,
  detectGbrain,
  PRIVACY_DEFAULTS,
} from "./setup.js";
import { runTranscriptLadder } from "./transcripts/ladder.js";
import {
  WHISPER_CPP_MODEL_MISSING_MESSAGE,
  detectLocalWhisper,
  localWhisperReadiness,
} from "./transcripts/local-whisper.js";
import { sttAvailability } from "./transcripts/stt.js";
import { taddyConfigured } from "./transcripts/taddy.js";
import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  Storage,
  TRANSCRIPT_RETRY_MAX_ATTEMPTS,
  type ListenRecord,
  type Provenance,
} from "./storage.js";

export type ToolDeps = {
  fetchImpl?: FetchLike;
  execImpl?: ExecImpl;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

function storageFor(config: ResolvedConfig): Storage {
  return new Storage(config.dataDir);
}

/**
 * Opt-in corpus export: off unless config.exportDir is set. Reads only the
 * stored transcript + provenance sidecar (never review candidates or
 * state.json) and recomputes the content hash for legacy sidecars that
 * predate it, so export never emits an undefined content_hash.
 */
/**
 * Run the opt-in corpus export for an episode and persist the outcome:
 * `exportedAt` on success (clearing any prior `exportError`), `exportError`
 * on failure. Never throws — a failed export must not mask the successful
 * transcript stage, and the persisted error is what lets scheduled runs
 * retry the export later and setup_status surface it.
 */
export async function exportAndRecord(
  config: ResolvedConfig,
  storage: Storage,
  record: ListenRecord,
  now: () => Date = () => new Date(),
): Promise<ExportResult | { error: string } | undefined> {
  if (!config.exportDir) return undefined;
  try {
    const result = await exportIfEnabled(config, storage, record);
    if (result === undefined) {
      // Export was enabled but its inputs are missing on disk — that is a
      // repairable failure, never a success: recording exportedAt here would
      // stop scheduled runs from ever retrying this episode.
      const message =
        `Corpus export skipped for ${record.uuid}: transcript.txt or provenance.json is missing ` +
        `under sources/${record.uuid}/. Repair or remove the directory, or re-run ` +
        "castrecall_fetch_transcript for this episode.";
      await storage.updateEpisode(record.uuid, { exportError: message }, now);
      return { error: message };
    }
    // A clean content-hash skip on an episode with no outstanding error is a
    // pure no-op: rewriting state here would make every scheduled tick mutate
    // state.json once per stored episode for nothing.
    if (result.skipped && !record.exportError) {
      return result;
    }
    await storage.updateEpisode(
      record.uuid,
      { exportedAt: now().toISOString(), exportError: undefined },
      now,
    );
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await storage.updateEpisode(record.uuid, { exportError: message }, now);
    return { error: message };
  }
}

async function exportIfEnabled(
  config: ResolvedConfig,
  storage: Storage,
  record: ListenRecord,
): Promise<ExportResult | undefined> {
  if (!config.exportDir) return undefined;
  const text = await storage.readTranscript(record.uuid);
  const provenance = await storage.readProvenance(record.uuid);
  if (!text || !provenance) return undefined;
  const contentHash =
    provenance.contentHash ?? createHash("sha256").update(text, "utf8").digest("hex");
  const exporter = new CorpusExporter(config.exportDir);
  return exporter.exportEpisode({ record, provenance, text, contentHash });
}

/**
 * Live (unresolved) scheduled-run stage failures: an error counts only while
 * its stage is still incomplete for that episode, so a later success clears
 * it from this view.
 */
function livePipelineErrors(
  episodes: ListenRecord[],
  config: ResolvedConfig,
): Array<{
  stage: "transcript" | "export" | "review";
  episodeUuid: string;
  title: string;
  error: string;
  at: string;
  nextEligibleAt?: string;
}> {
  const errors: Array<{
    stage: "transcript" | "export" | "review";
    episodeUuid: string;
    title: string;
    error: string;
    at: string;
    nextEligibleAt?: string;
  }> = [];
  for (const e of episodes) {
    if (e.transcriptError && e.transcriptStatus !== "stored") {
      errors.push({
        stage: "transcript",
        episodeUuid: e.uuid,
        title: e.title,
        error: e.transcriptError,
        at: e.updatedAt,
        ...(e.transcriptRetry ? { nextEligibleAt: e.transcriptRetry.nextEligibleAt } : {}),
      });
    }
    if (config.exportDir && e.exportError) {
      errors.push({ stage: "export", episodeUuid: e.uuid, title: e.title, error: e.exportError, at: e.updatedAt });
    }
    if (e.reviewError && !e.reviewGeneratedAt) {
      errors.push({ stage: "review", episodeUuid: e.uuid, title: e.title, error: e.reviewError, at: e.updatedAt });
    }
  }
  return errors;
}

export async function setupStatus(config: ResolvedConfig, deps: ToolDeps = {}): Promise<unknown> {
  const storage = storageFor(config);
  const state = await storage.loadState();
  const episodes = Object.values(state.episodes);
  const pendingReviews = await storage.listPendingReviews();
  const stt = sttAvailability(config);
  const whisper = await detectLocalWhisper(config, deps.env);
  const now = deps.now ?? (() => new Date());
  const exportStatus = classifyExportDir(config.exportDir);
  const nextEligibleAt = state.sync?.nextEligibleAt;
  const lock = await storage.inspectPipelineLock(now);
  const secretBackend = await detectSecretBackend(config, { env: deps.env, platform: deps.platform });
  const resolvedCredentials = await resolvePocketCastsCredentials(config, deps);
  const tokenCached = await hasCachedPocketCastsTokenRecord(config, deps);
  return {
    dataDir: config.dataDir,
    // Lock health is read straight from the lock file, so a hard-killed run
    // is visible here even though it never got to write anything to state.
    pipelineLock: {
      ...(lock.held
        ? {
            held: true,
            ageMinutes: Math.round(lock.ageMs / 60_000),
            stale: lock.stale,
            ...(lock.stale
              ? {
                  note:
                    "Stale lock: a run was hard-killed. Scheduled runs are skipping (fail-closed). " +
                    "After confirming no run is alive, recover with castrecall_run_pipeline " +
                    "{ breakStaleLock: true }.",
                }
              : {}),
          }
        : { held: false }),
      ...(lock.recoveryMutex
        ? {
            recoveryMutex: {
              path: lock.recoveryMutex.path,
              note:
                "A stale-lock recovery is in progress — or was hard-killed and left this mutex " +
                "behind, which blocks all scheduled runs (fail-closed). If no recovery is " +
                "running, remove the file manually; scheduled runs resume on the next tick.",
            },
          }
        : {}),
    },
    pocketcasts: {
      credentialsConfigured: resolvedCredentials.source !== "none",
      credentialSource: resolvedCredentials.source,
      note: "Unofficial API — read-only history access only. May break without notice.",
    },
    secretBackend: {
      available: Boolean(secretBackend.backend),
      kind: secretBackend.backend?.kind ?? null,
      disabled: config.secrets.keychainDisabled,
    },
    tokenCache: {
      cached: tokenCached,
    },
    transcriptLadder: {
      rss: "always on (open <podcast:transcript> standard)",
      taddy: taddyConfigured(config) ? "configured" : "not configured (TADDY_API_KEY, TADDY_USER_ID)",
      localWhisper: whisper.detected
        ? localWhisperReadiness(whisper, config.localWhisper).ready
          ? `detected (${whisper.detected.flavor}) — free, private transcription`
          : `detected (${whisper.detected.flavor}) but NOT ready — ${WHISPER_CPP_MODEL_MISSING_MESSAGE}`
        : `unavailable — ${whisper.reason}`,
      stt: stt.ok ? `enabled (${config.stt.provider})` : `off — ${stt.reason}`,
    },
    counts: {
      syncedListens: episodes.length,
      transcriptsStored: episodes.filter((e) => e.transcriptStatus === "stored").length,
      transcriptsFailed: episodes.filter((e) => e.transcriptStatus === "failed").length,
      pendingReviews: pendingReviews.length,
      pipelineStageErrors: livePipelineErrors(episodes, config).length,
    },
    // Actionable detail for every live stage failure (stage errors are
    // cleared when their stage later succeeds, so this converges to []).
    pipelineErrors: livePipelineErrors(episodes, config).slice(0, 20),
    lastSyncAt: state.lastSyncAt ?? null,
    sync: {
      lastError: state.sync?.lastError ?? null,
      lastErrorAt: state.sync?.lastErrorAt ?? null,
      consecutiveFailures: state.sync?.consecutiveFailures ?? 0,
      nextEligibleAt: nextEligibleAt ?? null,
      inCooldown: Boolean(nextEligibleAt && now() < new Date(nextEligibleAt)),
    },
    export: exportStatus,
    privacyDefaults: {
      dataDir: config.dataDir,
      ...PRIVACY_DEFAULTS,
    },
    privacyModel:
      "Full transcripts are stored privately under the data dir and are never " +
      "promoted into durable memory by CastRecall. Review candidates in " +
      "review/pending/ require explicit human approval.",
  };
}

/**
 * Guided first-run setup: reports what's configured/missing/optional and,
 * with { verify: true } and both credentials present, makes one read-only
 * Pocket Casts call (login + history fetch) to confirm they work. Never
 * constructs Storage, never writes to disk, and never returns secret values
 * or transcript/episode content — only booleans, counts, and plain-language
 * explanations.
 */
export async function setup(
  config: ResolvedConfig,
  params: { verify?: boolean } = {},
  deps: ToolDeps = {},
): Promise<unknown> {
  const whisper = await detectLocalWhisper(config, deps.env);
  const gbrain = await detectGbrain({ env: deps.env });
  const secretBackend = await detectSecretBackend(config, { env: deps.env, platform: deps.platform });
  const resolvedCredentials = await resolvePocketCastsCredentials(config, deps);
  const steps = buildSetupPlan(config, {
    whisper,
    gbrain,
    credentials: {
      source: resolvedCredentials.source,
      configured: resolvedCredentials.source !== "none",
    },
    secretBackend: {
      available: Boolean(secretBackend.backend),
      kind: secretBackend.backend?.kind,
    },
  });

  let verify: { ok: boolean; detail?: string; sampleCount?: number } | undefined;
  if (params.verify) {
    if (resolvedCredentials.source === "none") {
      verify = {
        ok: false,
        detail:
          "Pocket Casts credentials are not configured. Set POCKETCASTS_EMAIL and " +
          "POCKETCASTS_PASSWORD, or store them in the OS keychain (see the 'pocketcasts' step above).",
      };
    } else {
      try {
        const history = await fetchHistoryWithSession(config, { ...deps, skipTokenPersist: true });
        verify = { ok: true, sampleCount: history.length };
      } catch (error) {
        verify = { ok: false, detail: error instanceof Error ? error.message : String(error) };
      }
    }
  }

  return {
    steps,
    privacyDefaults: {
      dataDir: config.dataDir,
      ...PRIVACY_DEFAULTS,
    },
    ...(verify ? { verify } : {}),
  };
}

export async function syncHistory(
  config: ResolvedConfig,
  params: { limit?: number },
  deps: ToolDeps = {},
): Promise<unknown> {
  const history = await fetchHistoryWithSession(config, deps);
  const limit = params.limit && params.limit > 0 ? params.limit : config.historyLimit;
  const fetched = history.slice(0, limit);
  const eligible = fetched.filter((episode) => isListenedEpisode(episode, config.listenFilter));
  const storage = storageFor(config);
  await storage.init();
  const { added, totalSeen } = await storage.recordListens(
    eligible,
    deps.now ?? (() => new Date()),
  );
  return {
    fetched: fetched.length,
    eligible: eligible.length,
    skippedAsNotListened: fetched.length - eligible.length,
    newListens: added.map(summarizeListen),
    totalSeen,
    note:
      added.length > 0
        ? "New listens recorded. Use castrecall_fetch_transcript to fetch transcripts for them."
        : "No new listens since the last sync.",
  };
}

export async function listRecent(
  config: ResolvedConfig,
  params: { limit?: number },
): Promise<unknown> {
  const storage = storageFor(config);
  const state = await storage.loadState();
  const limit = params.limit && params.limit > 0 ? params.limit : 20;
  const episodes = Object.values(state.episodes)
    .sort((a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt))
    .slice(0, limit);
  return {
    lastSyncAt: state.lastSyncAt ?? null,
    episodes: episodes.map(summarizeListen),
  };
}

export async function fetchTranscript(
  config: ResolvedConfig,
  params: { episodeUuid: string },
  deps: ToolDeps = {},
): Promise<unknown> {
  const storage = storageFor(config);
  const state = await storage.loadState();
  const record = state.episodes[params.episodeUuid];
  if (!record) {
    throw new CastrecallSetupError(
      `Episode ${params.episodeUuid} is not in the synced history. Run castrecall_sync_history ` +
        "first, or check the UUID against castrecall_recent.",
    );
  }
  if (await storage.hasTranscript(record.uuid)) {
    const provenance = await storage.readProvenance(record.uuid);
    const updated =
      record.transcriptStatus === "stored" && record.transcriptSource === provenance?.transcriptSource
        ? record
        : await storage.updateEpisode(
            record.uuid,
            {
              transcriptStatus: "stored",
              transcriptSource: provenance?.transcriptSource,
              transcriptError: undefined,
              transcriptRetry: undefined,
            },
            deps.now ?? (() => new Date()),
          );
    const exportResult = await exportAndRecord(
      config,
      storage,
      updated ?? record,
      deps.now ?? (() => new Date()),
    );
    return {
      status: "already-stored",
      episode: summarizeListen(updated ?? record),
      transcriptPath: `${storage.sourceDir(record.uuid)}/transcript.txt`,
      source: provenance?.transcriptSource,
      export: exportResult,
      note:
        "Transcript content is stored as private source material. Use castrecall_generate_review " +
        "to create an approval-gated review candidate.",
    };
  }

  const now = deps.now ?? (() => new Date());
  const result = await runTranscriptLadder(config, record, {
    fetchImpl: deps.fetchImpl,
    env: deps.env,
  });
  if (!result.transcript) {
    const transcriptError = result.rungs.map((r) => `${r.rung}: ${r.detail}`).join(" | ");
    // A retryable STT failure (rate limit, timeout, upstream 5xx, network
    // rejection) leaves transcriptStatus "none" so the episode stays eligible
    // — but under a bounded, backed-off budget: each attempt can bill a paid
    // STT provider, so scheduled runs must never hammer the same episode
    // every tick or retry it forever.
    const retryable = result.rungs.some((r) => r.retryable);
    let retry: ListenRecord["transcriptRetry"];
    if (!retryable) {
      await storage.updateEpisode(
        record.uuid,
        { transcriptStatus: "failed", transcriptError, transcriptRetry: undefined },
        now,
      );
    } else {
      const consecutiveFailures = (record.transcriptRetry?.consecutiveFailures ?? 0) + 1;
      if (consecutiveFailures >= TRANSCRIPT_RETRY_MAX_ATTEMPTS) {
        await storage.updateEpisode(
          record.uuid,
          {
            transcriptStatus: "failed",
            transcriptError:
              `${transcriptError} (gave up after ${consecutiveFailures} consecutive transient ` +
              "failures; run castrecall_fetch_transcript manually to try again)",
            transcriptRetry: undefined,
          },
          now,
        );
      } else {
        const delay = Math.min(BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1), BACKOFF_CAP_MS);
        retry = {
          consecutiveFailures,
          nextEligibleAt: new Date(now().getTime() + delay).toISOString(),
        };
        await storage.updateEpisode(record.uuid, { transcriptError, transcriptRetry: retry }, now);
      }
    }
    return {
      status: "no-transcript",
      episode: summarizeListen(record),
      ladder: result.rungs,
      ...(retry
        ? {
            retry: {
              attempt: retry.consecutiveFailures,
              maxAttempts: TRANSCRIPT_RETRY_MAX_ATTEMPTS,
              nextEligibleAt: retry.nextEligibleAt,
            },
          }
        : {}),
      hint: "Each rung explains why it missed or was skipped. Configure the next rung or enable STT to go further.",
    };
  }

  const provenance: Provenance = {
    platform: "pocketcasts",
    podcastTitle: record.podcastTitle,
    podcastUuid: record.podcastUuid,
    episodeTitle: record.title,
    episodeUuid: record.uuid,
    episodeUrl: result.feedItem?.itemLink,
    audioUrl: record.audioUrl || undefined,
    feedUrl: result.feedItem?.feedUrl,
    listenTimestamp: record.firstSeenAt,
    transcriptSource: result.transcript.source,
    transcriptSourceUrl: result.transcript.sourceUrl,
    format: result.transcript.format,
    provider: result.transcript.provider,
    fetchedAt: now().toISOString(),
    privacyClass: "private-source",
  };
  const stored = await storage.storeTranscript(record.uuid, {
    raw: result.transcript.raw,
    ext: result.transcript.format,
    text: result.transcript.text,
    provenance,
  });
  await storage.updateEpisode(
    record.uuid,
    {
      transcriptStatus: "stored",
      transcriptSource: result.transcript.source,
      transcriptError: undefined,
      transcriptRetry: undefined,
    },
    now,
  );
  const exportResult = await exportAndRecord(config, storage, record, now);
  return {
    status: "stored",
    episode: summarizeListen({ ...record, transcriptStatus: "stored" }),
    source: result.transcript.source,
    format: result.transcript.format,
    transcriptPath: stored.textPath,
    provenancePath: stored.provenancePath,
    ladder: result.rungs,
    export: exportResult,
    note:
      "Transcript content is stored as private source material. Use castrecall_generate_review " +
      "to create an approval-gated review candidate.",
  };
}

export async function generateReview(
  config: ResolvedConfig,
  params: { episodeUuid?: string },
  deps: ToolDeps = {},
): Promise<unknown> {
  const storage = storageFor(config);
  const state = await storage.loadState();
  const now = deps.now ?? (() => new Date());

  const targets = params.episodeUuid
    ? [state.episodes[params.episodeUuid]].filter((r): r is ListenRecord => Boolean(r))
    : Object.values(state.episodes).filter(
        (r) => r.transcriptStatus === "stored" && !r.reviewGeneratedAt,
      );
  if (params.episodeUuid && targets.length === 0) {
    throw new CastrecallSetupError(
      `Episode ${params.episodeUuid} is not in the synced history (see castrecall_recent).`,
    );
  }

  const generated: Array<{ episodeUuid: string; title: string; path: string }> = [];
  const skipped: Array<{ episodeUuid: string; title: string; reason: string }> = [];
  for (const record of targets) {
    const text = await storage.readTranscript(record.uuid);
    const provenance = await storage.readProvenance(record.uuid);
    if (!text || !provenance) {
      skipped.push({
        episodeUuid: record.uuid,
        title: record.title,
        reason: "No stored transcript; run castrecall_fetch_transcript first.",
      });
      continue;
    }
    const markdown = buildReviewCandidate({
      record,
      provenance,
      transcriptText: text,
      transcriptPath: `${storage.sourceDir(record.uuid)}/transcript.txt`,
      generatedAt: now(),
    });
    const written = await storage.writeReviewCandidate(record.uuid, markdown);
    if (written.alreadyExists) {
      // Reconcile state: a pending review file without reviewGeneratedAt means
      // a prior run crashed between the write and the state update. Mark it
      // done so scheduled runs converge instead of re-targeting it forever.
      if (!record.reviewGeneratedAt) {
        await storage.updateEpisode(
          record.uuid,
          { reviewGeneratedAt: now().toISOString(), reviewError: undefined },
          now,
        );
      }
      skipped.push({
        episodeUuid: record.uuid,
        title: record.title,
        reason: `A pending review already exists at ${written.path}.`,
      });
    } else {
      await storage.updateEpisode(
        record.uuid,
        { reviewGeneratedAt: now().toISOString(), reviewError: undefined },
        now,
      );
      generated.push({ episodeUuid: record.uuid, title: record.title, path: written.path });
    }
  }
  return {
    generated,
    skipped,
    reviewDir: storage.reviewPendingDir(),
    note:
      "Review candidates are approval-gated: read them, keep what matters (in your own words " +
      "where possible), then delete or archive the file. CastRecall never writes to durable memory.",
  };
}

function summarizeListen(record: ListenRecord): Record<string, unknown> {
  return {
    episodeUuid: record.uuid,
    podcast: record.podcastTitle,
    title: record.title,
    published: record.published,
    firstSeenAt: record.firstSeenAt,
    transcriptStatus: record.transcriptStatus,
    transcriptSource: record.transcriptSource,
  };
}
