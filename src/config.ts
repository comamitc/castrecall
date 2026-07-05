import os from "node:os";
import path from "node:path";

export type SttProvider = "assemblyai" | "openai";

/** Non-secret settings accepted via the OpenClaw plugin config schema. */
export type PluginSettings = {
  dataDir?: string;
  historyLimit?: number;
  sttEnabled?: boolean;
  sttProvider?: SttProvider;
};

export type ResolvedConfig = {
  dataDir: string;
  historyLimit: number;
  pocketcasts: {
    email?: string;
    password?: string;
  };
  taddy: {
    apiKey?: string;
    userId?: string;
  };
  localWhisper: {
    disabled: boolean;
    /** Custom command template with an {input} placeholder; transcript expected on stdout. */
    command?: string;
    /** Model path (whisper.cpp) or model name (openai-whisper/mlx/ctranslate2). */
    model?: string;
  };
  stt: {
    enabled: boolean;
    provider: SttProvider;
    assemblyaiApiKey?: string;
    openaiApiKey?: string;
    openaiModel: string;
  };
};

const DEFAULT_HISTORY_LIMIT = 100;

function envFlag(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Merge plugin config (non-secret settings) with environment variables.
 * Secrets are env-only by design; they never pass through OpenClaw config.
 * Environment variables win over plugin config when both are set.
 */
export function resolveConfig(
  settings: PluginSettings = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  const dataDir =
    nonEmpty(env.CASTRECALL_DATA_DIR) ??
    nonEmpty(settings.dataDir) ??
    path.join(os.homedir(), ".openclaw", "castrecall");

  const envLimit = Number.parseInt(env.CASTRECALL_HISTORY_LIMIT ?? "", 10);
  const historyLimit =
    Number.isFinite(envLimit) && envLimit > 0
      ? envLimit
      : settings.historyLimit && settings.historyLimit > 0
        ? settings.historyLimit
        : DEFAULT_HISTORY_LIMIT;

  const sttEnabled = envFlag(env.CASTRECALL_ENABLE_STT) ?? settings.sttEnabled ?? false;
  const providerRaw =
    nonEmpty(env.CASTRECALL_STT_PROVIDER)?.toLowerCase() ?? settings.sttProvider ?? "assemblyai";
  const provider: SttProvider = providerRaw === "openai" ? "openai" : "assemblyai";

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
  constructor(message: string) {
    super(message);
    this.name = "CastrecallSetupError";
  }
}

export function requirePocketCastsCredentials(config: ResolvedConfig): {
  email: string;
  password: string;
} {
  const { email, password } = config.pocketcasts;
  if (!email || !password) {
    throw new CastrecallSetupError(
      "Pocket Casts credentials are not configured. Set POCKETCASTS_EMAIL and POCKETCASTS_PASSWORD " +
        "in the environment OpenClaw runs in (see the CastRecall README, 'First-run setup'). " +
        "CastRecall only performs read-only history requests with them.",
    );
  }
  return { email, password };
}
