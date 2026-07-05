export type SttProvider = "assemblyai" | "openai";
/** Non-secret settings accepted via the OpenClaw plugin config schema. */
export type PluginSettings = {
    dataDir?: string;
    historyLimit?: number;
    sttEnabled?: boolean;
    sttProvider?: SttProvider;
    exportDir?: string;
};
export type ResolvedConfig = {
    dataDir: string;
    historyLimit: number;
    /** Corpus export: off (undefined) by default — see docs/ARCHITECTURE.md. */
    exportDir?: string;
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
    secrets: {
        /** CASTRECALL_DISABLE_KEYCHAIN=1 disables the durable keychain sink only. */
        keychainDisabled: boolean;
        /** Service name under which OS keychain entries are stored. */
        service: string;
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
export declare function requirePocketCastsCredentials(config: ResolvedConfig): {
    email: string;
    password: string;
};
