/**
 * CastRecall — turn podcast listening into retrievable memory.
 *
 * OpenClaw tool plugin. v0 is read-only against Pocket Casts: it syncs listen
 * history, fetches or generates transcripts via a cost-aware ladder, stores
 * them as private provenance-bearing source material, and produces
 * approval-gated review candidates. It never mutates playback state and never
 * writes to durable OpenClaw memory.
 */
import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { resolveConfig } from "./config.js";
import { runPipeline } from "./pipeline.js";
import { fetchTranscript, generateReview, listRecent, setupStatus, syncHistory, } from "./tools.js";
const configSchema = Type.Object({
    dataDir: Type.Optional(Type.String({
        description: "Where CastRecall stores transcripts and review candidates. Defaults to ~/.openclaw/castrecall. The CASTRECALL_DATA_DIR env var overrides this.",
    })),
    historyLimit: Type.Optional(Type.Number({
        description: "Max history entries ingested per sync (default 100).",
    })),
    sttEnabled: Type.Optional(Type.Boolean({
        description: "Explicitly enable the paid speech-to-text fallback (default false; it costs money per episode).",
    })),
    sttProvider: Type.Optional(Type.Union([Type.Literal("assemblyai"), Type.Literal("openai")], {
        description: "Speech-to-text provider when sttEnabled is true (default assemblyai).",
    })),
    exportDir: Type.Optional(Type.String({
        description: "Opt-in: also write section-split, frontmattered markdown pages here on transcript " +
            "store (e.g. a gbrain inbox or a brain's sources/ root — the exporter always appends " +
            "podcasts/<show-slug>, so don't point this at sources/podcasts). Off by default. The " +
            "CASTRECALL_EXPORT_DIR env var overrides this.",
    })),
}, { additionalProperties: false });
export default defineToolPlugin({
    id: "castrecall",
    name: "CastRecall",
    description: "Turn podcast listening into retrievable memory: sync Pocket Casts listen history (read-only), " +
        "fetch or generate episode transcripts, store them privately with provenance, and create " +
        "approval-gated review candidates. Never writes to durable memory itself.",
    configSchema,
    tools: (tool) => [
        tool({
            name: "castrecall_setup_status",
            description: "Report CastRecall setup and health: data directory, which credentials/providers are " +
                "configured (never the values), transcript ladder availability, and counts of synced " +
                "listens, stored transcripts, and pending reviews. Run this first.",
            parameters: Type.Object({}),
            execute: async (_params, settings) => setupStatus(resolveConfig(settings)),
        }),
        tool({
            name: "castrecall_sync_history",
            description: "Sync Pocket Casts listening history (read-only) into CastRecall's private state. " +
                "Records newly seen listens idempotently and reports them. Requires POCKETCASTS_EMAIL " +
                "and POCKETCASTS_PASSWORD in the environment.",
            parameters: Type.Object({
                limit: Type.Optional(Type.Number({ description: "Max history entries to ingest this run (default 100)." })),
            }),
            execute: async (params, settings) => syncHistory(resolveConfig(settings), params),
        }),
        tool({
            name: "castrecall_recent",
            description: "List recently synced podcast listens with their transcript status. Use the returned " +
                "episodeUuid values with castrecall_fetch_transcript and castrecall_generate_review.",
            parameters: Type.Object({
                limit: Type.Optional(Type.Number({ description: "Max listens to return (default 20)." })),
            }),
            execute: async (params, settings) => listRecent(resolveConfig(settings), params),
        }),
        tool({
            name: "castrecall_fetch_transcript",
            description: "Fetch or generate the transcript for a synced episode via the transcript ladder " +
                "(RSS <podcast:transcript> → Taddy → optional paid speech-to-text) and store it privately " +
                "with a provenance sidecar. Reports exactly which rung hit, missed, or was skipped and why.",
            parameters: Type.Object({
                episodeUuid: Type.String({
                    description: "Episode UUID from castrecall_recent or castrecall_sync_history.",
                }),
            }),
            execute: async (params, settings) => fetchTranscript(resolveConfig(settings), params),
        }),
        tool({
            name: "castrecall_generate_review",
            description: "Generate approval-gated review candidate documents (markdown, in review/pending/) for " +
                "stored transcripts — listen metadata, provenance, and excerpt candidates. Without " +
                "episodeUuid, processes every stored transcript that has no review yet. CastRecall never " +
                "promotes anything into durable memory; the human decides what to keep.",
            parameters: Type.Object({
                episodeUuid: Type.Optional(Type.String({ description: "Generate for one specific episode only." })),
            }),
            execute: async (params, settings) => generateReview(resolveConfig(settings), params),
        }),
        tool({
            name: "castrecall_run_pipeline",
            description: "Chained pipeline for scheduled/background runs: sync history → fetch transcripts for " +
                "newly seen listens → generate review candidates for episodes newly stored this run → " +
                "corpus export (when CASTRECALL_EXPORT_DIR is set). Safe under overlapping/concurrent " +
                "invocations (lock) and stays quiet on failure with a bounded, backed-off retry (no " +
                "hammering the unofficial Pocket Casts API). This is the tool a scheduler recipe should " +
                "call — see README 'Scheduled / periodic sync'.",
            parameters: Type.Object({
                limit: Type.Optional(Type.Number({ description: "Max history entries to ingest this run (default 100)." })),
                force: Type.Optional(Type.Boolean({
                    description: "Bypass the failure-cooldown gate for a manual recovery run. Never set this in a " +
                        "scheduler recipe — it defeats the no-hammer protection.",
                })),
                breakStaleLock: Type.Optional(Type.Boolean({
                    description: "Recover from a hard-killed run's leftover lock (reported by skipped: 'stale-lock'). " +
                        "Only breaks a lock whose heartbeat stopped; refuses live locks. Requires human " +
                        "confirmation that no run is alive — never set this in a scheduler recipe.",
                })),
            }),
            execute: async (params, settings) => runPipeline(resolveConfig(settings), params),
        }),
    ],
});
