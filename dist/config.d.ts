export type SttProvider = "assemblyai" | "openai" | "deepgram" | "remote-stt";
/** Non-secret settings accepted via the OpenClaw plugin config schema. */
export type PluginSettings = {
    dataDir?: string;
    historyLimit?: number;
    sttEnabled?: boolean;
    sttProvider?: SttProvider;
    exportDir?: string;
    notesDir?: string;
    glossaryFile?: string;
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
        /** Base URL of a self-hosted/private STT service implementing the remote-stt contract (issue #61). */
        remoteBaseUrl?: string;
        /** Bearer token sent as `Authorization: Bearer <token>` on every remote-stt request. */
        remoteToken?: string;
        /** Model name/id forwarded to the remote-stt provider; the provider decides what it means. */
        remoteModel?: string;
        /** Download the audio and multipart-upload it instead of submitting `audio_url`, for providers that can't fetch remote URLs. */
        remoteForceUpload: boolean;
        /** Testing-only bypass of the corpus-scale remote-stt reachability gate (issue #63) — never set this for a real run. */
        remoteAllowUnverified: boolean;
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
    /** Optional proper-noun correction glossary (issue #46) — off until configured. */
    glossary: {
        file?: string;
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
export declare function envFlag(value: string | undefined): boolean | undefined;
/**
 * Merge plugin config (non-secret settings) with environment variables.
 * Secrets are env-only by design; they never pass through OpenClaw config.
 * Environment variables win over plugin config when both are set.
 */
export declare function resolveConfig(settings?: PluginSettings, env?: NodeJS.ProcessEnv): ResolvedConfig;
/** Error whose message is safe to surface to the model/user (no secrets). */
export declare class CastrecallSetupError extends Error {
    constructor(message: string);
}
/**
 * Only the unconfigured case is an error here — a configured-but-missing
 * directory is created on demand by `Storage.writePromotedNote`, mirroring
 * `CorpusExporter`'s create-on-demand precedent.
 */
export declare function requireNotesDir(config: ResolvedConfig): string;
export declare function requirePocketCastsCredentials(config: ResolvedConfig): {
    email: string;
    password: string;
};
