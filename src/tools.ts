/**
 * Implementations behind the five CastRecall tools. Pure functions over
 * (config, params) so they are testable without the OpenClaw runtime.
 */

import {
  CastrecallSetupError,
  requirePocketCastsCredentials,
  type ResolvedConfig,
} from "./config.js";
import { fetchHistory, login, type FetchLike } from "./pocketcasts/client.js";
import { buildReviewCandidate } from "./review.js";
import { runTranscriptLadder } from "./transcripts/ladder.js";
import { detectLocalWhisper } from "./transcripts/local-whisper.js";
import { sttAvailability } from "./transcripts/stt.js";
import { taddyConfigured } from "./transcripts/taddy.js";
import { Storage, type ListenRecord, type Provenance } from "./storage.js";

export type ToolDeps = {
  fetchImpl?: FetchLike;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
};

function storageFor(config: ResolvedConfig): Storage {
  return new Storage(config.dataDir);
}

export async function setupStatus(config: ResolvedConfig): Promise<unknown> {
  const storage = storageFor(config);
  const state = await storage.loadState();
  const episodes = Object.values(state.episodes);
  const pendingReviews = await storage.listPendingReviews();
  const stt = sttAvailability(config);
  const whisper = await detectLocalWhisper(config);
  return {
    dataDir: config.dataDir,
    pocketcasts: {
      credentialsConfigured: Boolean(config.pocketcasts.email && config.pocketcasts.password),
      note: "Unofficial API — read-only history access only. May break without notice.",
    },
    transcriptLadder: {
      rss: "always on (open <podcast:transcript> standard)",
      taddy: taddyConfigured(config) ? "configured" : "not configured (TADDY_API_KEY, TADDY_USER_ID)",
      localWhisper: whisper.detected
        ? `detected (${whisper.detected.flavor}) — free, private transcription`
        : `unavailable — ${whisper.reason}`,
      stt: stt.ok ? `enabled (${config.stt.provider})` : `off — ${stt.reason}`,
    },
    counts: {
      syncedListens: episodes.length,
      transcriptsStored: episodes.filter((e) => e.transcriptStatus === "stored").length,
      transcriptsFailed: episodes.filter((e) => e.transcriptStatus === "failed").length,
      pendingReviews: pendingReviews.length,
    },
    lastSyncAt: state.lastSyncAt ?? null,
    privacyModel:
      "Full transcripts are stored privately under the data dir and are never " +
      "promoted into durable memory by CastRecall. Review candidates in " +
      "review/pending/ require explicit human approval.",
  };
}

export async function syncHistory(
  config: ResolvedConfig,
  params: { limit?: number },
  deps: ToolDeps = {},
): Promise<unknown> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const { email, password } = requirePocketCastsCredentials(config);
  const token = await login(email, password, fetchImpl);
  const history = await fetchHistory(token, fetchImpl);
  const limit = params.limit && params.limit > 0 ? params.limit : config.historyLimit;
  const storage = storageFor(config);
  await storage.init();
  const { added, totalSeen } = await storage.recordListens(
    history.slice(0, limit),
    deps.now ?? (() => new Date()),
  );
  return {
    fetched: Math.min(history.length, limit),
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
            },
            deps.now ?? (() => new Date()),
          );
    return {
      status: "already-stored",
      episode: summarizeListen(updated ?? record),
      transcriptPath: `${storage.sourceDir(record.uuid)}/transcript.txt`,
      source: provenance?.transcriptSource,
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
    await storage.updateEpisode(
      record.uuid,
      {
        transcriptStatus: "failed",
        transcriptError: result.rungs.map((r) => `${r.rung}: ${r.detail}`).join(" | "),
      },
      now,
    );
    return {
      status: "no-transcript",
      episode: summarizeListen(record),
      ladder: result.rungs,
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
    { transcriptStatus: "stored", transcriptSource: result.transcript.source, transcriptError: undefined },
    now,
  );
  return {
    status: "stored",
    episode: summarizeListen({ ...record, transcriptStatus: "stored" }),
    source: result.transcript.source,
    format: result.transcript.format,
    transcriptPath: stored.textPath,
    provenancePath: stored.provenancePath,
    ladder: result.rungs,
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
      skipped.push({
        episodeUuid: record.uuid,
        title: record.title,
        reason: `A pending review already exists at ${written.path}.`,
      });
    } else {
      await storage.updateEpisode(record.uuid, { reviewGeneratedAt: now().toISOString() }, now);
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
