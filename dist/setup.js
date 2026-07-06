/**
 * Pure builder behind the `castrecall_setup` tool: turns resolved config plus
 * a few pre-detected facts (local Whisper, a gbrain install) into an ordered,
 * agent-narratable setup plan. No I/O happens here — network calls and
 * filesystem detection are the caller's job (see setup() in tools.ts) so this
 * stays deterministic and unit-testable.
 *
 * gbrain detection limitation: a CastRecall tool plugin has no reliable,
 * in-process way to enumerate sibling OpenClaw plugin installs. detectGbrain
 * checks for a `~/.gbrain/` directory on disk (the one signal that's actually
 * testable), plus CASTRECALL_GBRAIN_INSTALLED as an explicit escape hatch an
 * agent-driven wrapper can set once it has confirmed the plugin install via
 * OpenClaw's own plugin inventory — a signal this process cannot see itself.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { envFlag } from "./config.js";
import { taddyConfigured } from "./transcripts/taddy.js";
import { podchaserConfigured } from "./transcripts/podchaser.js";
import { sttAvailability } from "./transcripts/stt.js";
import { WHISPER_CPP_MODEL_MISSING_MESSAGE, localWhisperReadiness } from "./transcripts/local-whisper.js";
/** Explicit, confirm-style privacy defaults shown by both setup and setup_status. */
export const PRIVACY_DEFAULTS = {
    privacyClass: "private-source",
    durableMemory: "CastRecall never writes to durable OpenClaw memory. It only generates approval-gated review " +
        "candidates in review/pending/ — a human decides what, if anything, graduates.",
    exportDefault: "Corpus export is off unless CASTRECALL_EXPORT_DIR is explicitly set.",
};
export async function detectGbrain(deps = {}) {
    const homedir = deps.homedir ?? os.homedir;
    const access = deps.access ?? ((targetPath) => fs.access(targetPath));
    const env = deps.env ?? process.env;
    const gbrainDir = path.join(homedir(), ".gbrain");
    if (envFlag(env.CASTRECALL_GBRAIN_INSTALLED)) {
        return { detected: true, suggestedExportDir: path.join(gbrainDir, "inbox") };
    }
    try {
        await access(gbrainDir);
        return { detected: true, suggestedExportDir: path.join(gbrainDir, "inbox") };
    }
    catch {
        return {
            detected: false,
            reason: `No ~/.gbrain directory found at ${gbrainDir}. If you use gbrain (or another markdown brain), ` +
                "point CASTRECALL_EXPORT_DIR at its inbox or sources/ tree yourself. CastRecall cannot " +
                "otherwise detect a sibling plugin install — if an agent-driven wrapper has already " +
                "confirmed one via OpenClaw's plugin inventory, set CASTRECALL_GBRAIN_INSTALLED=1.",
        };
    }
}
/** True when exportDir is (or ends in) a gbrain-style `.gbrain/inbox` path. */
function looksLikeGbrainInbox(exportDir) {
    const normalized = exportDir.replace(/[/\\]+$/, "");
    return normalized.endsWith(path.join(".gbrain", "inbox"));
}
export function classifyExportDir(exportDir) {
    if (!exportDir)
        return { exportDir: null, mode: "off" };
    return { exportDir, mode: looksLikeGbrainInbox(exportDir) ? "gbrain-inbox" : "custom" };
}
/** Platform-appropriate keychain store recipe shown once a backend is detected. */
function keychainStoreRecipe(service, secretBackend) {
    return secretBackend.kind === "libsecret"
        ? `secret-tool store --label "CastRecall pocketcasts-email" service ${service} account pocketcasts-email ` +
            `&& secret-tool store --label "CastRecall pocketcasts-password" service ${service} account pocketcasts-password`
        : `security add-generic-password -U -s ${service} -a pocketcasts-email -w <email> ` +
            `&& security add-generic-password -U -s ${service} -a pocketcasts-password -w <password>`;
}
export function buildSetupPlan(config, deps) {
    const credentialsConfigured = deps.credentials.configured;
    const taddyOk = taddyConfigured(config);
    const podchaserOk = podchaserConfigured(config);
    const stt = sttAvailability(config);
    const { exportDir, mode } = classifyExportDir(config.exportDir);
    const { ready: whisperReady, needsModel: whisperNeedsModel } = localWhisperReadiness(deps.whisper, config.localWhisper);
    const steps = [
        {
            id: "pocketcasts",
            title: "Pocket Casts credentials",
            status: credentialsConfigured ? "configured" : "missing",
            envVars: ["POCKETCASTS_EMAIL", "POCKETCASTS_PASSWORD"],
            explanation: "Read-only access to your Pocket Casts listening history. Set POCKETCASTS_EMAIL and " +
                "POCKETCASTS_PASSWORD in the environment OpenClaw runs in, then verify with " +
                "castrecall_setup({ verify: true })." +
                (deps.secretBackend.available
                    ? ` Safer option: store them in the OS keychain instead — ${keychainStoreRecipe(config.secrets.service, deps.secretBackend)} — env vars remain a fallback when no keychain entry is found.`
                    : "") +
                (deps.credentials.source === "keychain" ? " Currently sourced from the OS keychain." : ""),
            caveat: "Unofficial API: Pocket Casts has no official public API, so this may break or be blocked " +
                "without notice, and CastRecall only ever makes read requests with it. Accounts created via " +
                "'Sign in with Google/Apple' have no password and cannot use this integration until Pocket " +
                "Casts ships an official API.",
        },
        {
            id: "storage",
            title: "Storage location",
            status: "configured",
            envVars: ["CASTRECALL_DATA_DIR"],
            explanation: `Transcripts, provenance sidecars, and review candidates are stored privately under ` +
                `${config.dataDir}. Set CASTRECALL_DATA_DIR before first sync to use a different location.`,
        },
        {
            id: "privacy",
            title: "Privacy defaults",
            status: "configured",
            envVars: [],
            explanation: `Full transcripts are stored as private source material (privacyClass: ` +
                `"${PRIVACY_DEFAULTS.privacyClass}"). ${PRIVACY_DEFAULTS.durableMemory} ` +
                PRIVACY_DEFAULTS.exportDefault,
        },
        {
            id: "providers.taddy",
            title: "Taddy transcript provider (optional)",
            status: taddyOk ? "configured" : "optional-off",
            envVars: ["TADDY_API_KEY", "TADDY_USER_ID"],
            explanation: "Optional transcript-ladder rung. Free signup at https://taddy.org/developers — podcast-" +
                "provided transcripts may be available to free accounts; generated/on-demand transcripts use " +
                "paid Taddy plan credits.",
        },
        {
            id: "providers.podchaser",
            title: "Podchaser transcript provider (optional)",
            status: podchaserOk ? "configured" : "optional-off",
            envVars: ["PODCHASER_API_KEY"],
            explanation: "Optional transcript-ladder rung, checked after Taddy. PODCHASER_API_KEY is a bearer " +
                "access token minted via Podchaser's requestAccessToken mutation " +
                "(see https://api-docs.podchaser.com/docs/authorization/), not a raw client secret.",
        },
        {
            id: "providers.localWhisper",
            title: "Local Whisper (optional, free & fully private)",
            status: whisperReady ? "configured" : "optional-off",
            envVars: ["CASTRECALL_WHISPER_MODEL", "CASTRECALL_WHISPER_COMMAND", "CASTRECALL_DISABLE_LOCAL_WHISPER"],
            explanation: whisperReady
                ? `Detected ${deps.whisper.detected.flavor} on PATH — transcribes locally at no cost and ` +
                    "nothing leaves your machine."
                : whisperNeedsModel
                    ? `Detected whisper.cpp on PATH, but it's not ready yet: ${WHISPER_CPP_MODEL_MISSING_MESSAGE}`
                    : deps.whisper.reason,
        },
        {
            id: "providers.stt",
            title: "Cloud speech-to-text (optional, costs money)",
            status: stt.ok ? "configured" : "optional-off",
            envVars: [
                "CASTRECALL_ENABLE_STT",
                "CASTRECALL_STT_PROVIDER",
                "ASSEMBLYAI_API_KEY",
                "OPENAI_API_KEY",
                "DEEPGRAM_API_KEY",
                "CASTRECALL_DEEPGRAM_STT_MODEL",
            ],
            explanation: stt.ok ? `Enabled (${config.stt.provider}).` : (stt.reason ?? "Disabled."),
        },
        {
            id: "export",
            title: "Corpus export (optional)",
            status: exportDir ? "configured" : "optional-off",
            envVars: ["CASTRECALL_EXPORT_DIR"],
            explanation: exportDir
                ? `Exporting section-split markdown pages to ${exportDir} (mode: ${mode}).`
                : deps.gbrain.detected
                    ? `Off by default. Detected a gbrain inbox at ${deps.gbrain.suggestedExportDir} — set ` +
                        `CASTRECALL_EXPORT_DIR=${deps.gbrain.suggestedExportDir} to export there.`
                    : `Off by default. Set CASTRECALL_EXPORT_DIR to a markdown inbox or sources/ tree to enable. ${deps.gbrain.reason}`,
        },
    ];
    return steps;
}
