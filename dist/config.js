import os from "node:os";
import path from "node:path";
const DEFAULT_HISTORY_LIMIT = 100;
const DEFAULT_MIN_LISTEN_RATIO = 0.8;
const DEFAULT_MIN_LISTEN_SECONDS = 300;
export function envFlag(value) {
    if (value === undefined || value === "")
        return undefined;
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}
function nonEmpty(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}
/**
 * Merge plugin config (non-secret settings) with environment variables.
 * Secrets are env-only by design; they never pass through OpenClaw config.
 * Environment variables win over plugin config when both are set.
 */
export function resolveConfig(settings = {}, env = process.env) {
    const dataDir = nonEmpty(env.CASTRECALL_DATA_DIR) ??
        nonEmpty(settings.dataDir) ??
        path.join(os.homedir(), ".openclaw", "castrecall");
    const envLimit = Number.parseInt(env.CASTRECALL_HISTORY_LIMIT ?? "", 10);
    const historyLimit = Number.isFinite(envLimit) && envLimit > 0
        ? envLimit
        : settings.historyLimit && settings.historyLimit > 0
            ? settings.historyLimit
            : DEFAULT_HISTORY_LIMIT;
    const sttEnabled = envFlag(env.CASTRECALL_ENABLE_STT) ?? settings.sttEnabled ?? false;
    const providerRaw = nonEmpty(env.CASTRECALL_STT_PROVIDER)?.toLowerCase() ?? settings.sttProvider ?? "assemblyai";
    const provider = providerRaw === "openai" || providerRaw === "deepgram" ? providerRaw : "assemblyai";
    const exportDir = nonEmpty(env.CASTRECALL_EXPORT_DIR) ?? nonEmpty(settings.exportDir);
    const notesDir = nonEmpty(env.CASTRECALL_NOTES_DIR) ?? nonEmpty(settings.notesDir);
    const envMinRatio = Number.parseFloat(env.CASTRECALL_MIN_LISTEN_RATIO ?? "");
    const minRatio = Number.isFinite(envMinRatio) && envMinRatio > 0 && envMinRatio <= 1
        ? envMinRatio
        : DEFAULT_MIN_LISTEN_RATIO;
    const envMinSeconds = Number.parseInt(env.CASTRECALL_MIN_LISTEN_SECONDS ?? "", 10);
    const minSeconds = Number.isFinite(envMinSeconds) && envMinSeconds > 0 ? envMinSeconds : DEFAULT_MIN_LISTEN_SECONDS;
    const recordUnknown = envFlag(env.CASTRECALL_RECORD_UNKNOWN_LISTENS) ?? false;
    return {
        dataDir,
        historyLimit,
        exportDir,
        notesDir,
        pocketcasts: {
            email: nonEmpty(env.POCKETCASTS_EMAIL),
            password: nonEmpty(env.POCKETCASTS_PASSWORD),
        },
        taddy: {
            apiKey: nonEmpty(env.TADDY_API_KEY),
            userId: nonEmpty(env.TADDY_USER_ID),
        },
        podchaser: {
            apiKey: nonEmpty(env.PODCHASER_API_KEY),
        },
        listenNotes: {
            apiKey: nonEmpty(env.LISTENNOTES_API_KEY),
        },
        localWhisper: {
            disabled: envFlag(env.CASTRECALL_DISABLE_LOCAL_WHISPER) ?? false,
            command: nonEmpty(env.CASTRECALL_WHISPER_COMMAND),
            model: nonEmpty(env.CASTRECALL_WHISPER_MODEL),
        },
        stt: {
            enabled: sttEnabled,
            provider,
            assemblyaiApiKey: nonEmpty(env.ASSEMBLYAI_API_KEY),
            openaiApiKey: nonEmpty(env.OPENAI_API_KEY),
            openaiModel: nonEmpty(env.CASTRECALL_OPENAI_STT_MODEL) ?? "gpt-4o-transcribe",
            deepgramApiKey: nonEmpty(env.DEEPGRAM_API_KEY),
            deepgramModel: nonEmpty(env.CASTRECALL_DEEPGRAM_STT_MODEL) ?? "nova-3",
        },
        secrets: {
            keychainDisabled: envFlag(env.CASTRECALL_DISABLE_KEYCHAIN) ?? false,
            service: nonEmpty(env.CASTRECALL_SECRET_SERVICE) ?? "castrecall",
        },
        listenFilter: {
            minRatio,
            minSeconds,
            recordUnknown,
        },
    };
}
/** Error whose message is safe to surface to the model/user (no secrets). */
export class CastrecallSetupError extends Error {
    constructor(message) {
        super(message);
        this.name = "CastrecallSetupError";
    }
}
/**
 * Only the unconfigured case is an error here — a configured-but-missing
 * directory is created on demand by `Storage.writePromotedNote`, mirroring
 * `CorpusExporter`'s create-on-demand precedent.
 */
export function requireNotesDir(config) {
    if (!config.notesDir) {
        throw new CastrecallSetupError("No notes destination configured. Set CASTRECALL_NOTES_DIR (or the notesDir plugin setting) " +
            "to the directory promoted notes should be written to before calling castrecall_resolve_review " +
            "with disposition: \"promote\".");
    }
    return config.notesDir;
}
export function requirePocketCastsCredentials(config) {
    const { email, password } = config.pocketcasts;
    if (!email || !password) {
        throw new CastrecallSetupError("Pocket Casts credentials are not configured. Set POCKETCASTS_EMAIL and POCKETCASTS_PASSWORD " +
            "in the environment OpenClaw runs in, or store them in the OS keychain (macOS Keychain / " +
            "libsecret) — see the CastRecall README, 'First-run setup'. " +
            "CastRecall only performs read-only history requests with them.");
    }
    return { email, password };
}
