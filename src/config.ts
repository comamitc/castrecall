import os from "node:os";
import path from "node:path";

export type SttProvider = "assemblyai" | "openai" | "deepgram";

/** Non-secret settings accepted via the OpenClaw plugin config schema. */
export type PluginSettings = {
  dataDir?: string;
  historyLimit?: number;
  sttEnabled?: boolean;
  sttProvider?: SttProvider;
  exportDir?: string;
  notesDir?: string;
};

/**
 * Loop-safe decoding options for local Whisper (issue #53), abstract over
 * flavor: resolveWhisperDecodeArgs (local-whisper.ts) maps these to concrete
 * per-flavor CLI flags, never silently dropping an option a flavor can't
 * honor. `outputFormat` is stored as a raw lowercased string here — it's
 * validated against the supported set in the resolver, not here, so an
 * unrecognized value is an ignore-with-provenance case rather than breaking
 * every resolveConfig caller on a typo.
 */
export type WhisperDecodeConfig = {
  language?: string;
  /** Disables loop-prone repetition by not feeding prior output back as context. Default false (off) for long-form podcasts. */
  conditionOnPreviousText: boolean;
  wordTimestamps?: boolean;
  outputFormat: string;
  noSpeechThreshold?: number;
  logprobThreshold?: number;
  compressionRatioThreshold?: number;
  hallucinationSilenceThreshold?: number;
};

export type ResolvedConfig = {
  dataDir: string;
  historyLimit: number;
  /** Corpus export: off (undefined) by default — see docs/ARCHITECTURE.md. */
  exportDir?: string;
  /** Promoted-note destination for castrecall_resolve_review: off (undefined) until configured. */
  notesDir?: string;
  pocketcasts: {
    email?: string;
    password?: string;
  };
  taddy: {
    apiKey?: string;
    userId?: string;
  };
  podchaser: {
    /** Pre-minted OAuth2 bearer access token from Podchaser's requestAccessToken mutation. */
    apiKey?: string;
  };
  listenNotes: {
    /** Optional feed-URL discovery fallback, used only when Pocket Casts feed export and iTunes Search both miss. */
    apiKey?: string;
  };
  localWhisper: {
    disabled: boolean;
    /** Custom command template with an {input} placeholder; transcript expected on stdout. */
    command?: string;
    /** Model path (whisper.cpp) or model name (openai-whisper/mlx/ctranslate2). */
    model?: string;
    /**
     * CastRecall-managed quality preset (fast/balanced/best), resolved to a concrete
     * mlx-community model on Apple Silicon (mlx-whisper) only. See resolveWhisperModel.
     */
    preset?: string;
    /** Accept mlx-whisper's low-quality default model instead of requiring CASTRECALL_WHISPER_MODEL. */
    allowLowQuality: boolean;
    decode: WhisperDecodeConfig;
  };
  stt: {
    enabled: boolean;
    provider: SttProvider;
    assemblyaiApiKey?: string;
    openaiApiKey?: string;
    openaiModel: string;
    deepgramApiKey?: string;
    deepgramModel: string;
  };
  secrets: {
    /** CASTRECALL_DISABLE_KEYCHAIN=1 disables the durable keychain sink only. */
    keychainDisabled: boolean;
    /** Service name under which OS keychain entries are stored. */
    service: string;
  };
  transcriptCleanup: {
    /** Deterministic punctuation/caption-artifact/whitespace cleanup pass (issue #45), on by default. */
    enabled: boolean;
  };
  /** Threshold for what counts as "meaningfully listened" before sync ingests an episode — see issue #24. */
  listenFilter: {
    /** Minimum playedUpTo/duration ratio to accept a partial listen. */
    minRatio: number;
    /** Minimum playedUpTo seconds to accept a short/no-duration listen. */
    minSeconds: number;
    /** Accept episodes with no usable duration/playedUpTo/playingStatus at all. */
    recordUnknown: boolean;
  };
};

const DEFAULT_HISTORY_LIMIT = 100;
const DEFAULT_MIN_LISTEN_RATIO = 0.8;
const DEFAULT_MIN_LISTEN_SECONDS = 300;

export function envFlag(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Undefined for unset/blank/non-finite input — never NaN leaking into an argv value. */
function nonEmptyNumber(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
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
  const provider: SttProvider =
    providerRaw === "openai" || providerRaw === "deepgram" ? providerRaw : "assemblyai";

  const exportDir = nonEmpty(env.CASTRECALL_EXPORT_DIR) ?? nonEmpty(settings.exportDir);
  const notesDir = nonEmpty(env.CASTRECALL_NOTES_DIR) ?? nonEmpty(settings.notesDir);

  const envMinRatio = Number.parseFloat(env.CASTRECALL_MIN_LISTEN_RATIO ?? "");
  const minRatio =
    Number.isFinite(envMinRatio) && envMinRatio > 0 && envMinRatio <= 1
      ? envMinRatio
      : DEFAULT_MIN_LISTEN_RATIO;

  const envMinSeconds = Number.parseInt(env.CASTRECALL_MIN_LISTEN_SECONDS ?? "", 10);
  const minSeconds =
    Number.isFinite(envMinSeconds) && envMinSeconds > 0 ? envMinSeconds : DEFAULT_MIN_LISTEN_SECONDS;

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
      preset: nonEmpty(env.CASTRECALL_LOCAL_WHISPER_PRESET)?.toLowerCase(),
      allowLowQuality: envFlag(env.CASTRECALL_WHISPER_ALLOW_LOW_QUALITY) ?? false,
      decode: {
        language: nonEmpty(env.CASTRECALL_WHISPER_LANGUAGE),
        conditionOnPreviousText: envFlag(env.CASTRECALL_WHISPER_CONDITION_ON_PREVIOUS_TEXT) ?? false,
        wordTimestamps: envFlag(env.CASTRECALL_WHISPER_WORD_TIMESTAMPS),
        outputFormat: nonEmpty(env.CASTRECALL_WHISPER_OUTPUT_FORMAT)?.toLowerCase() ?? "txt",
        noSpeechThreshold: nonEmptyNumber(env.CASTRECALL_WHISPER_NO_SPEECH_THRESHOLD),
        logprobThreshold: nonEmptyNumber(env.CASTRECALL_WHISPER_LOGPROB_THRESHOLD),
        compressionRatioThreshold: nonEmptyNumber(env.CASTRECALL_WHISPER_COMPRESSION_RATIO_THRESHOLD),
        hallucinationSilenceThreshold: nonEmptyNumber(
          env.CASTRECALL_WHISPER_HALLUCINATION_SILENCE_THRESHOLD,
        ),
      },
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
    transcriptCleanup: {
      enabled: envFlag(env.CASTRECALL_TRANSCRIPT_CLEANUP) ?? true,
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
  constructor(message: string) {
    super(message);
    this.name = "CastrecallSetupError";
  }
}

/**
 * Only the unconfigured case is an error here — a configured-but-missing
 * directory is created on demand by `Storage.writePromotedNote`, mirroring
 * `CorpusExporter`'s create-on-demand precedent.
 */
export function requireNotesDir(config: ResolvedConfig): string {
  if (!config.notesDir) {
    throw new CastrecallSetupError(
      "No notes destination configured. Set CASTRECALL_NOTES_DIR (or the notesDir plugin setting) " +
        "to the directory promoted notes should be written to before calling castrecall_resolve_review " +
        "with disposition: \"promote\".",
    );
  }
  return config.notesDir;
}

export function requirePocketCastsCredentials(config: ResolvedConfig): {
  email: string;
  password: string;
} {
  const { email, password } = config.pocketcasts;
  if (!email || !password) {
    throw new CastrecallSetupError(
      "Pocket Casts credentials are not configured. Set POCKETCASTS_EMAIL and POCKETCASTS_PASSWORD " +
        "in the environment OpenClaw runs in, or store them in the OS keychain (macOS Keychain / " +
        "libsecret) — see the CastRecall README, 'First-run setup'. " +
        "CastRecall only performs read-only history requests with them.",
    );
  }
  return { email, password };
}
