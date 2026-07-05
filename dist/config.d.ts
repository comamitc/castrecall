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
    stt: {
        enabled: boolean;
        provider: SttProvider;
        assemblyaiApiKey?: string;
        openaiApiKey?: string;
        openaiModel: string;
    };
};
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
