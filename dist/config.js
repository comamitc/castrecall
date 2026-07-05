import os from "node:os";
import path from "node:path";
const DEFAULT_HISTORY_LIMIT = 100;
function envFlag(value) {
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
    const provider = providerRaw === "openai" ? "openai" : "assemblyai";
    return {
        dataDir,
        historyLimit,
        pocketcasts: {
            email: nonEmpty(env.POCKETCASTS_EMAIL),
            password: nonEmpty(env.POCKETCASTS_PASSWORD),
        },
        taddy: {
            apiKey: nonEmpty(env.TADDY_API_KEY),
            userId: nonEmpty(env.TADDY_USER_ID),
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
export function requirePocketCastsCredentials(config) {
    const { email, password } = config.pocketcasts;
    if (!email || !password) {
        throw new CastrecallSetupError("Pocket Casts credentials are not configured. Set POCKETCASTS_EMAIL and POCKETCASTS_PASSWORD " +
            "in the environment OpenClaw runs in (see the CastRecall README, 'First-run setup'). " +
            "CastRecall only performs read-only history requests with them.");
    }
    return { email, password };
}
