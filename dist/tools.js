/**
 * Implementations behind the five CastRecall tools. Pure functions over
 * (config, params) so they are testable without the OpenClaw runtime.
 */
import { createHash } from "node:crypto";
import { CastrecallSetupError, requirePocketCastsCredentials, } from "./config.js";
import { CorpusExporter } from "./corpus-export.js";
import { fetchHistory, login } from "./pocketcasts/client.js";
import { buildReviewCandidate } from "./review.js";
import { runTranscriptLadder } from "./transcripts/ladder.js";
import { detectLocalWhisper } from "./transcripts/local-whisper.js";
import { sttAvailability } from "./transcripts/stt.js";
import { taddyConfigured } from "./transcripts/taddy.js";
import { Storage } from "./storage.js";
function storageFor(config) {
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
export async function exportAndRecord(config, storage, record, now = () => new Date()) {
    if (!config.exportDir)
        return undefined;
    try {
        const result = await exportIfEnabled(config, storage, record);
        await storage.updateEpisode(record.uuid, { exportedAt: now().toISOString(), exportError: undefined }, now);
        return result;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await storage.updateEpisode(record.uuid, { exportError: message }, now);
        return { error: message };
    }
}
async function exportIfEnabled(config, storage, record) {
    if (!config.exportDir)
        return undefined;
    const text = await storage.readTranscript(record.uuid);
    const provenance = await storage.readProvenance(record.uuid);
    if (!text || !provenance)
        return undefined;
    const contentHash = provenance.contentHash ?? createHash("sha256").update(text, "utf8").digest("hex");
    const exporter = new CorpusExporter(config.exportDir);
    return exporter.exportEpisode({ record, provenance, text, contentHash });
}
/**
 * Live (unresolved) scheduled-run stage failures: an error counts only while
 * its stage is still incomplete for that episode, so a later success clears
 * it from this view.
 */
function livePipelineErrors(episodes, config) {
    const errors = [];
    for (const e of episodes) {
        if (e.transcriptError && e.transcriptStatus !== "stored") {
            errors.push({ stage: "transcript", episodeUuid: e.uuid, title: e.title, error: e.transcriptError, at: e.updatedAt });
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
export async function setupStatus(config, deps = {}) {
    const storage = storageFor(config);
    const state = await storage.loadState();
    const episodes = Object.values(state.episodes);
    const pendingReviews = await storage.listPendingReviews();
    const stt = sttAvailability(config);
    const whisper = await detectLocalWhisper(config);
    const now = deps.now ?? (() => new Date());
    const nextEligibleAt = state.sync?.nextEligibleAt;
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
        privacyModel: "Full transcripts are stored privately under the data dir and are never " +
            "promoted into durable memory by CastRecall. Review candidates in " +
            "review/pending/ require explicit human approval.",
    };
}
export async function syncHistory(config, params, deps = {}) {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const { email, password } = requirePocketCastsCredentials(config);
    const token = await login(email, password, fetchImpl);
    const history = await fetchHistory(token, fetchImpl);
    const limit = params.limit && params.limit > 0 ? params.limit : config.historyLimit;
    const storage = storageFor(config);
    await storage.init();
    const { added, totalSeen } = await storage.recordListens(history.slice(0, limit), deps.now ?? (() => new Date()));
    return {
        fetched: Math.min(history.length, limit),
        newListens: added.map(summarizeListen),
        totalSeen,
        note: added.length > 0
            ? "New listens recorded. Use castrecall_fetch_transcript to fetch transcripts for them."
            : "No new listens since the last sync.",
    };
}
export async function listRecent(config, params) {
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
export async function fetchTranscript(config, params, deps = {}) {
    const storage = storageFor(config);
    const state = await storage.loadState();
    const record = state.episodes[params.episodeUuid];
    if (!record) {
        throw new CastrecallSetupError(`Episode ${params.episodeUuid} is not in the synced history. Run castrecall_sync_history ` +
            "first, or check the UUID against castrecall_recent.");
    }
    if (await storage.hasTranscript(record.uuid)) {
        const provenance = await storage.readProvenance(record.uuid);
        const updated = record.transcriptStatus === "stored" && record.transcriptSource === provenance?.transcriptSource
            ? record
            : await storage.updateEpisode(record.uuid, {
                transcriptStatus: "stored",
                transcriptSource: provenance?.transcriptSource,
                transcriptError: undefined,
            }, deps.now ?? (() => new Date()));
        const exportResult = await exportAndRecord(config, storage, updated ?? record, deps.now ?? (() => new Date()));
        return {
            status: "already-stored",
            episode: summarizeListen(updated ?? record),
            transcriptPath: `${storage.sourceDir(record.uuid)}/transcript.txt`,
            source: provenance?.transcriptSource,
            export: exportResult,
            note: "Transcript content is stored as private source material. Use castrecall_generate_review " +
                "to create an approval-gated review candidate.",
        };
    }
    const now = deps.now ?? (() => new Date());
    const result = await runTranscriptLadder(config, record, {
        fetchImpl: deps.fetchImpl,
        env: deps.env,
    });
    if (!result.transcript) {
        await storage.updateEpisode(record.uuid, {
            transcriptStatus: "failed",
            transcriptError: result.rungs.map((r) => `${r.rung}: ${r.detail}`).join(" | "),
        }, now);
        return {
            status: "no-transcript",
            episode: summarizeListen(record),
            ladder: result.rungs,
            hint: "Each rung explains why it missed or was skipped. Configure the next rung or enable STT to go further.",
        };
    }
    const provenance = {
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
    await storage.updateEpisode(record.uuid, { transcriptStatus: "stored", transcriptSource: result.transcript.source, transcriptError: undefined }, now);
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
        note: "Transcript content is stored as private source material. Use castrecall_generate_review " +
            "to create an approval-gated review candidate.",
    };
}
export async function generateReview(config, params, deps = {}) {
    const storage = storageFor(config);
    const state = await storage.loadState();
    const now = deps.now ?? (() => new Date());
    const targets = params.episodeUuid
        ? [state.episodes[params.episodeUuid]].filter((r) => Boolean(r))
        : Object.values(state.episodes).filter((r) => r.transcriptStatus === "stored" && !r.reviewGeneratedAt);
    if (params.episodeUuid && targets.length === 0) {
        throw new CastrecallSetupError(`Episode ${params.episodeUuid} is not in the synced history (see castrecall_recent).`);
    }
    const generated = [];
    const skipped = [];
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
                await storage.updateEpisode(record.uuid, { reviewGeneratedAt: now().toISOString(), reviewError: undefined }, now);
            }
            skipped.push({
                episodeUuid: record.uuid,
                title: record.title,
                reason: `A pending review already exists at ${written.path}.`,
            });
        }
        else {
            await storage.updateEpisode(record.uuid, { reviewGeneratedAt: now().toISOString(), reviewError: undefined }, now);
            generated.push({ episodeUuid: record.uuid, title: record.title, path: written.path });
        }
    }
    return {
        generated,
        skipped,
        reviewDir: storage.reviewPendingDir(),
        note: "Review candidates are approval-gated: read them, keep what matters (in your own words " +
            "where possible), then delete or archive the file. CastRecall never writes to durable memory.",
    };
}
function summarizeListen(record) {
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
