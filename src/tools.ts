/**
 * Implementations behind the CastRecall tools. Pure functions over
 * (config, params) so they are testable without the OpenClaw runtime.
 */

import { createHash } from "node:crypto";
import { CastrecallSetupError, requireNotesDir, type ResolvedConfig } from "./config.js";
import { CorpusExporter, slugify, type ExportResult } from "./corpus-export.js";
import type { FetchLike } from "./pocketcasts/client.js";
import { isListenedEpisode } from "./pocketcasts/listened.js";
import { detectSecretBackend, type ExecImpl } from "./pocketcasts/secret-store.js";
import {
  fetchHistoryWithSession,
  hasCachedPocketCastsTokenRecord,
  resolvePocketCastsCredentials,
} from "./pocketcasts/session.js";
import { buildDigest, type DigestEpisodeInput } from "./digest.js";
import { buildPromotedNote, buildReviewCandidate } from "./review.js";
import { SearchIndex, type CorpusEntry } from "./search.js";
import {
  buildSetupPlan,
  classifyExportDir,
  classifyNotesDir,
  detectGbrain,
  PRIVACY_DEFAULTS,
} from "./setup.js";
import { runTranscriptLadder } from "./transcripts/ladder.js";
import {
  detectLocalWhisper,
  localWhisperReadiness,
  resolveWhisperDecodeArgs,
  resolveWhisperModel,
} from "./transcripts/local-whisper.js";
import { sttAvailability } from "./transcripts/stt.js";
import { taddyConfigured } from "./transcripts/taddy.js";
import { podchaserConfigured } from "./transcripts/podchaser.js";
import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  Storage,
  TRANSCRIPT_RECHECK_BASE_MS,
  TRANSCRIPT_RECHECK_CAP_MS,
  TRANSCRIPT_RECHECK_MAX_AGE_MS,
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
      const nextEligibleAt = e.transcriptRetry?.nextEligibleAt ?? e.transcriptRecheck?.nextEligibleAt;
      errors.push({
        stage: "transcript",
        episodeUuid: e.uuid,
        title: e.title,
        error: e.transcriptError,
        at: e.updatedAt,
        ...(nextEligibleAt ? { nextEligibleAt } : {}),
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
  const notesStatus = classifyNotesDir(config.notesDir);
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
      podchaser: podchaserConfigured(config) ? "configured" : "not configured (PODCHASER_API_KEY)",
      localWhisper: whisper.detected
        ? (() => {
            const readiness = localWhisperReadiness(whisper, config.localWhisper);
            if (!readiness.ready) {
              return `detected (${whisper.detected!.flavor}) but NOT ready — ${readiness.reason}`;
            }
            const resolved = resolveWhisperModel(whisper.detected!.flavor, config.localWhisper);
            const decodeResolution = resolveWhisperDecodeArgs(
              whisper.detected!.flavor,
              config.localWhisper.decode,
            );
            const ignoredPart =
              decodeResolution.ignored.length > 0
                ? ` (ignored decode options: ${decodeResolution.ignored.map((o) => o.option).join(", ")})`
                : "";
            return (
              `detected (${whisper.detected!.flavor}) — free, private transcription` +
              (resolved.model ? ` using ${resolved.model}` : "") +
              ignoredPart
            );
          })()
        : `unavailable — ${whisper.reason}`,
      stt: stt.ok ? `enabled (${config.stt.provider})` : `off — ${stt.reason}`,
    },
    counts: {
      syncedListens: episodes.length,
      transcriptsStored: episodes.filter((e) => e.transcriptStatus === "stored").length,
      transcriptsFailed: episodes.filter((e) => e.transcriptStatus === "failed").length,
      transcriptsPendingRecheck: episodes.filter((e) => e.transcriptRecheck).length,
      pendingReviews: pendingReviews.length,
      reviewsResolved: episodes.filter((e) => e.reviewDisposition).length,
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
    notes: notesStatus,
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
  params: { episodeUuid: string; scheduled?: boolean },
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
              transcriptRecheck: undefined,
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
  // Once a prior attempt exhausted the STT retry budget for this episode,
  // scheduled runs never bill it again — the ladder is told to skip straight
  // past that rung so a still-recheckable rung (e.g. Taddy) can keep being
  // polled without re-attempting STT on every tick. A direct
  // castrecall_fetch_transcript call is explicit operator intent to spend
  // money, so it is never gated — that is the manual recovery path the
  // skipped-rung detail advertises.
  const sttRetryBudgetSpent =
    params.scheduled === true &&
    (record.transcriptRetry?.consecutiveFailures ?? 0) >= TRANSCRIPT_RETRY_MAX_ATTEMPTS;
  const result = await runTranscriptLadder(config, record, {
    fetchImpl: deps.fetchImpl,
    env: deps.env,
    skipStt: sttRetryBudgetSpent,
  });
  if (!result.transcript) {
    const transcriptError = result.rungs.map((r) => `${r.rung}: ${r.detail}`).join(" | ");
    // A retryable STT failure (rate limit, timeout, upstream 5xx, network
    // rejection) leaves transcriptStatus "none" so the episode stays eligible
    // — but under a bounded, backed-off budget: each attempt can bill a paid
    // STT provider, so scheduled runs must never hammer the same episode
    // every tick or retry it forever.
    const retryable = result.rungs.some((r) => r.retryable);
    const recheckable = result.rungs.some((r) => r.recheckable);
    const consecutiveFailures = retryable ? (record.transcriptRetry?.consecutiveFailures ?? 0) + 1 : 0;
    const sttExhausted = retryable && consecutiveFailures >= TRANSCRIPT_RETRY_MAX_ATTEMPTS;
    let retry: ListenRecord["transcriptRetry"];
    let recheck: ListenRecord["transcriptRecheck"];
    if (retryable && !sttExhausted) {
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1), BACKOFF_CAP_MS);
      retry = {
        consecutiveFailures,
        nextEligibleAt: new Date(now().getTime() + delay).toISOString(),
      };
      await storage.updateEpisode(record.uuid, { transcriptError, transcriptRetry: retry }, now);
    } else if (recheckable) {
      // The transcript may simply not be published/transcribed YET (Taddy
      // still transcribing, or an RSS item with no transcript links
      // declared). Poll again on a longer, uncapped-by-attempt-count horizon
      // rather than treating the first miss as terminal. If STT's own retry
      // budget just ran out (sttExhausted), freeze that state instead of
      // discarding it — `skipStt` above reads it back so scheduled runs keep
      // skipping STT for this episode while this cheaper rung keeps being
      // polled (a manual fetch_transcript call still re-attempts STT).
      const firstDeferredAt = record.transcriptRecheck?.firstDeferredAt ?? now().toISOString();
      const ageMs = now().getTime() - Date.parse(firstDeferredAt);
      if (ageMs > TRANSCRIPT_RECHECK_MAX_AGE_MS) {
        const days = Math.round(TRANSCRIPT_RECHECK_MAX_AGE_MS / (24 * 60 * 60_000));
        await storage.updateEpisode(
          record.uuid,
          {
            transcriptStatus: "failed",
            transcriptError: `${transcriptError} (no transcript appeared after ${days} days)`,
            transcriptRecheck: undefined,
          },
          now,
        );
      } else {
        const attempts = (record.transcriptRecheck?.attempts ?? 0) + 1;
        const delay = Math.min(
          TRANSCRIPT_RECHECK_BASE_MS * 2 ** (attempts - 1),
          TRANSCRIPT_RECHECK_CAP_MS,
        );
        recheck = {
          attempts,
          nextEligibleAt: new Date(now().getTime() + delay).toISOString(),
          firstDeferredAt,
        };
        if (sttExhausted) {
          retry = {
            consecutiveFailures,
            nextEligibleAt: record.transcriptRetry?.nextEligibleAt ?? now().toISOString(),
          };
        }
        await storage.updateEpisode(
          record.uuid,
          {
            transcriptError,
            transcriptRecheck: recheck,
            ...(sttExhausted ? { transcriptRetry: retry } : {}),
          },
          now,
        );
      }
    } else {
      await storage.updateEpisode(
        record.uuid,
        {
          transcriptStatus: "failed",
          transcriptError: sttExhausted
            ? `${transcriptError} (gave up after ${consecutiveFailures} consecutive transient ` +
              "failures; run castrecall_fetch_transcript manually to try again)"
            : transcriptError,
          transcriptRetry: undefined,
          transcriptRecheck: undefined,
        },
        now,
      );
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
      ...(recheck
        ? {
            recheck: {
              attempt: recheck.attempts,
              nextEligibleAt: recheck.nextEligibleAt,
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
    generation: result.transcript.generation,
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
      transcriptRecheck: undefined,
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

/**
 * Disposition a pending review candidate. This is the only path in
 * CastRecall that can promote content anywhere outside the private data
 * dir — the gate is contractual, not technical: the tool description
 * instructs callers to invoke this only after explicit human confirmation
 * in conversation, the same trust model as every other agent tool. A
 * `promote` requires the exact human-chosen `content`; CastRecall itself
 * never decides what to keep.
 */
export async function resolveReview(
  config: ResolvedConfig,
  params: {
    episodeUuid: string;
    disposition: "promote" | "discard";
    content?: string;
    title?: string;
  },
  deps: ToolDeps = {},
): Promise<unknown> {
  const storage = storageFor(config);
  const state = await storage.loadState();
  const now = deps.now ?? (() => new Date());
  const record = state.episodes[params.episodeUuid];
  if (!record) {
    throw new CastrecallSetupError(
      `Episode ${params.episodeUuid} is not in the synced history (see castrecall_recent).`,
    );
  }
  if (!(await storage.hasPendingReview(params.episodeUuid))) {
    throw new CastrecallSetupError(
      `No pending review to resolve for episode ${params.episodeUuid}: it was never generated ` +
        "(run castrecall_generate_review first) or has already been resolved.",
    );
  }
  if (record.reviewDisposition) {
    throw new CastrecallSetupError(
      `Episode ${params.episodeUuid} was already resolved as "${record.reviewDisposition}" ` +
        `at ${record.reviewResolvedAt}. A pending candidate reappeared for it, but ` +
        "castrecall_resolve_review only resolves an episode once.",
    );
  }

  if (params.disposition === "discard") {
    // The move (pending -> resolved) is the linearization point: it is the
    // only step two concurrent resolves for the same episode can race on,
    // and it can only succeed for one of them. Only the caller for whom it
    // reports moved === true may write state.
    const { moved, resolvedPath, alreadyResolved } = await storage.resolvePendingReview(
      params.episodeUuid,
    );
    if (!moved) {
      if (alreadyResolved) {
        throw new CastrecallSetupError(
          `A resolved candidate already exists at ${resolvedPath} for episode ` +
            `${params.episodeUuid}. Remove or archive it before resolving this candidate again.`,
        );
      }
      throw new CastrecallSetupError(
        `Episode ${params.episodeUuid}'s pending review was resolved by a concurrent ` +
          "castrecall_resolve_review call before this one completed. Check the episode's " +
          "reviewDisposition (e.g. via castrecall_setup_status) for the outcome that won.",
      );
    }
    const resolvedAt = now().toISOString();
    try {
      await storage.updateEpisode(
        params.episodeUuid,
        { reviewDisposition: "discard", reviewResolvedAt: resolvedAt },
        now,
      );
    } catch (error) {
      // The move succeeded but recording the disposition failed: put the
      // candidate back so a retry lands on the normal pending path instead
      // of being stranded resolved-on-disk with no recorded disposition.
      await storage.revertResolvedReview(params.episodeUuid).catch(() => {});
      throw error;
    }
    return {
      disposition: "discard",
      resolvedPath,
      note: "Candidate discarded. Nothing was written to notes or durable memory.",
    };
  }

  // promote — order matters: write-note, then move, then update state. A
  // crash between write-note and move leaves a promoted note plus a still-
  // pending candidate; a retry then hits the write-once collision below and
  // throws (surfaced, not silently double-promoted) rather than orphaning
  // state — the same reconciliation stance generateReview takes on its own
  // write/state-update pair (see above). The move step below is also the
  // linearization point for concurrent resolves of the same episode; see
  // its `!moved` handling.
  if (!params.content?.trim()) {
    throw new CastrecallSetupError(
      "castrecall_resolve_review requires non-empty content when disposition is \"promote\" — " +
        "the exact text the human chose to keep, in their own words where possible.",
    );
  }
  const content = params.content;
  const notesDir = requireNotesDir(config);
  const provenance = await storage.readProvenance(params.episodeUuid);
  if (!provenance) {
    throw new CastrecallSetupError(
      `Episode ${params.episodeUuid} has a pending review but no provenance.json under ` +
        `sources/${params.episodeUuid}/ — the sidecar appears to have been removed. Re-run ` +
        "castrecall_fetch_transcript to restore it before promoting.",
    );
  }
  const resolvedAtDate = now();
  const markdown = buildPromotedNote({
    record,
    provenance,
    content,
    title: params.title,
    resolvedAt: resolvedAtDate,
  });
  const filename =
    `${resolvedAtDate.toISOString().slice(0, 10)}-` +
    `${slugify(params.title || record.title, "note")}-${params.episodeUuid.slice(0, 8)}.md`;
  const written = await storage.writePromotedNote(notesDir, filename, markdown);
  if (written.alreadyExists) {
    throw new CastrecallSetupError(
      `A promoted note already exists at ${written.path}. The candidate was left pending — ` +
        "remove or rename the existing note, or resolve again with a different title.",
    );
  }
  // The move (pending -> resolved) is the linearization point: it is the
  // only step two concurrent resolves for the same episode can race on. If
  // this call loses that race, the note it just wrote is an orphan — remove
  // it rather than leaving two divergent promotions or letting a discard
  // that lost this race silently overwrite the winning promote's state.
  const { moved, resolvedPath, alreadyResolved } = await storage.resolvePendingReview(
    params.episodeUuid,
  );
  if (!moved) {
    await storage.deletePromotedNote(written.path);
    if (alreadyResolved) {
      throw new CastrecallSetupError(
        `A resolved candidate already exists at ${resolvedPath} for episode ` +
          `${params.episodeUuid}. Remove or archive it before resolving this candidate again.`,
      );
    }
    throw new CastrecallSetupError(
      `Episode ${params.episodeUuid}'s pending review was resolved by a concurrent ` +
        "castrecall_resolve_review call before this one completed. Check the episode's " +
        "reviewDisposition (e.g. via castrecall_setup_status) for the outcome that won.",
    );
  }
  const resolvedAt = resolvedAtDate.toISOString();
  try {
    await storage.updateEpisode(
      params.episodeUuid,
      {
        reviewDisposition: "promote",
        reviewResolvedAt: resolvedAt,
        promotedNotePath: written.path,
      },
      now,
    );
  } catch (error) {
    // The move and note write succeeded but recording the disposition
    // failed: put the candidate back and remove the note so a retry lands
    // on the normal pending path instead of a candidate that's resolved and
    // promoted on disk with no recorded disposition.
    await storage.revertResolvedReview(params.episodeUuid).catch(() => {});
    await storage.deletePromotedNote(written.path).catch(() => {});
    throw error;
  }
  return {
    disposition: "promote",
    resolvedPath,
    promotedNotePath: written.path,
    note: "Promoted content was written to the configured notes destination — never to durable memory.",
  };
}

/**
 * Keyword/phrase search over stored transcripts. Read-only: assembles the
 * corpus from state.json + sources/<uuid>/ (mirroring exportIfEnabled's
 * contentHash ?? sha256(text) legacy fallback) and delegates reconciliation,
 * scoring, and snippet-building to SearchIndex — see search.ts.
 */
export async function search(
  config: ResolvedConfig,
  params: { query: string; limit?: number },
): Promise<unknown> {
  const query = params.query?.trim();
  if (!query) {
    throw new CastrecallSetupError(
      "castrecall_search requires a non-empty query string.",
    );
  }
  const storage = storageFor(config);
  const state = await storage.loadState();
  const storedEpisodes = Object.values(state.episodes).filter(
    (e) => e.transcriptStatus === "stored",
  );

  const corpus: CorpusEntry[] = [];
  for (const record of storedEpisodes) {
    const provenance = await storage.readProvenance(record.uuid);
    if (!provenance) continue;
    const contentHash =
      provenance.contentHash ??
      createHash("sha256")
        .update((await storage.readTranscript(record.uuid)) ?? "", "utf8")
        .digest("hex");
    corpus.push({
      uuid: record.uuid,
      contentHash,
      provenance,
      transcriptPath: `${storage.sourceDir(record.uuid)}/transcript.txt`,
      readText: async () => (await storage.readTranscript(record.uuid)) ?? "",
    });
  }

  const index = new SearchIndex(storage.indexDir());
  const { hits } = await index.search(query, { limit: params.limit }, corpus);
  return { results: hits };
}

const DEFAULT_DIGEST_WINDOW_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60_000;

/**
 * Cross-episode digest over a recent time window, filtered on `firstSeenAt`
 * — the only honest "when I absorbed it" signal in v0 (Pocket Casts episodes
 * carry no listened-at timestamp; provenance.listenTimestamp is itself
 * derived from firstSeenAt in fetchTranscript above). Mirrors generateReview:
 * loads state, reads transcripts for stored episodes, builds a pure
 * structural document, and writes it to the same approval-gated review lane.
 */
export async function digest(
  config: ResolvedConfig,
  params: { days?: number },
  deps: ToolDeps = {},
): Promise<unknown> {
  const storage = storageFor(config);
  const state = await storage.loadState();
  const now = deps.now ?? (() => new Date());
  const nowDate = now();
  const days = params.days && params.days > 0 ? params.days : DEFAULT_DIGEST_WINDOW_DAYS;
  const windowStart = new Date(nowDate.getTime() - days * MS_PER_DAY);

  const inWindow = Object.values(state.episodes).filter(
    (record) => Date.parse(record.firstSeenAt) >= windowStart.getTime(),
  );

  if (inWindow.length === 0) {
    return {
      episodes: 0,
      shows: 0,
      transcribed: 0,
      window: { days, start: windowStart.toISOString(), end: nowDate.toISOString() },
      path: null,
      alreadyExists: false,
    };
  }

  const episodes: DigestEpisodeInput[] = [];
  for (const record of inWindow) {
    if (record.transcriptStatus === "stored") {
      const transcriptText = await storage.readTranscript(record.uuid);
      episodes.push({ record, transcriptText });
    } else {
      episodes.push({ record });
    }
  }

  const { markdown, summary } = buildDigest({
    episodes,
    days,
    windowStart,
    windowEnd: nowDate,
    generatedAt: nowDate,
  });

  const slug = `${nowDate.toISOString().slice(0, 10)}-${days}d`;
  const written = await storage.writeDigest(slug, markdown);

  return {
    ...summary,
    path: written.path,
    alreadyExists: written.alreadyExists,
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
