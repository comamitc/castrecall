/**
 * Implementations behind the five CastRecall tools. Pure functions over
 * (config, params) so they are testable without the OpenClaw runtime.
 */
import { type ResolvedConfig } from "./config.js";
import { type FetchLike } from "./pocketcasts/client.js";
export type ToolDeps = {
    fetchImpl?: FetchLike;
    now?: () => Date;
};
export declare function setupStatus(config: ResolvedConfig): Promise<unknown>;
export declare function syncHistory(config: ResolvedConfig, params: {
    limit?: number;
}, deps?: ToolDeps): Promise<unknown>;
export declare function listRecent(config: ResolvedConfig, params: {
    limit?: number;
}): Promise<unknown>;
export declare function fetchTranscript(config: ResolvedConfig, params: {
    episodeUuid: string;
}, deps?: ToolDeps): Promise<unknown>;
export declare function generateReview(config: ResolvedConfig, params: {
    episodeUuid?: string;
}, deps?: ToolDeps): Promise<unknown>;
