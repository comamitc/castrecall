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
import { digest, fetchTranscript, generateReview, listRecent, search, setup, setupStatus, syncHistory, } from "./tools.js";
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
    sttProvider: Type.Optional(Type.Union([Type.Literal("assemblyai"), Type.Literal("openai"), Type.Literal("deepgram")], {
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
            name: "castrecall_setup",
            description: "Guided first-run setup: walks through Pocket Casts credentials (incl. the unofficial-API " +
                "and Google/Apple-SSO caveats, and a keychain-preferred / env-var-fallback storage option), " +
                "storage location, privacy defaults, optional transcript providers (Taddy, local Whisper, " +
                "cloud STT), and export directory (offering a detected gbrain inbox). Never edits " +
                "openclaw.json or writes secrets to disk itself — it only tells you which env vars to set, " +
                "or the OS keychain command to run, and where. Pass { verify: true } to make one read-only " +
                "Pocket Casts call confirming configured credentials actually work.",
            parameters: Type.Object({
                verify: Type.Optional(Type.Boolean({
                    description: "Run a read-only Pocket Casts test call to confirm credentials work.",
                })),
            }),
            execute: async (params, settings) => setup(resolveConfig(settings), params),
        }),
        tool({
            name: "castrecall_sync_history",
            description: "Sync Pocket Casts listening history (read-only) into CastRecall's private state. " +
                "Records newly seen listens idempotently and reports them. Credentials are keychain-" +
                "preferred: uses OS keychain (macOS Keychain / libsecret) entries when present, otherwise " +
                "falls back to POCKETCASTS_EMAIL / POCKETCASTS_PASSWORD in the environment. The session " +
                "token is cached and reused across syncs instead of logging in every time.",
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
            name: "castrecall_search",
            description: "Keyword/phrase search over the privately stored transcript corpus (not durable memory — " +
                "CastRecall never writes there). Supports bare keywords and \"quoted phrases\" (ranked above " +
                "the same words scattered out of order). Every result carries provenance (episode, podcast, " +
                "listen date, transcript source, transcript path) plus a highlighted snippet and its raw " +
                "verbatim source slice, so anything quoted stays attributable.",
            parameters: Type.Object({
                query: Type.String({
                    description: "Keywords and/or \"quoted phrases\" to search for.",
                }),
                limit: Type.Optional(Type.Number({
                    description: "Max results to return (default 10, max 25).",
                })),
            }),
            execute: async (params, settings) => search(resolveConfig(settings), params),
        }),
        tool({
            name: "castrecall_digest",
            description: "Cross-episode digest over a recent time window (default 30 days): listening pattern " +
                "(episode/show counts, transcript-source breakdown), recurring topics by term frequency, " +
                "and notable verbatim excerpts, each attributed to its podcast and episode. Structural " +
                "aggregation only — semantic synthesis ('what have I been absorbing, and how is it shaping " +
                "my thinking?') is left to the reviewing agent. Writes one approval-gated digest per " +
                "window to review/pending/, same as castrecall_generate_review.",
            parameters: Type.Object({
                days: Type.Optional(Type.Number({
                    description: "Size of the listening window in days, ending now (default 30).",
                })),
            }),
            execute: async (params, settings) => digest(resolveConfig(settings), params),
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
