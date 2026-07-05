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
import { type ResolvedConfig } from "./config.js";
import { type WhisperDetection } from "./transcripts/local-whisper.js";
export type SetupStepStatus = "configured" | "missing" | "optional-off";
export type SetupStep = {
    id: string;
    title: string;
    status: SetupStepStatus;
    envVars: string[];
    explanation: string;
    caveat?: string;
};
export type GbrainDetection = {
    detected: true;
    suggestedExportDir: string;
    reason?: undefined;
} | {
    detected: false;
    suggestedExportDir?: undefined;
    reason: string;
};
export type ExportMode = "off" | "gbrain-inbox" | "custom";
/** Explicit, confirm-style privacy defaults shown by both setup and setup_status. */
export declare const PRIVACY_DEFAULTS: {
    readonly privacyClass: "private-source";
    readonly durableMemory: string;
    readonly exportDefault: "Corpus export is off unless CASTRECALL_EXPORT_DIR is explicitly set.";
};
export declare function detectGbrain(deps?: {
    homedir?: () => string;
    access?: (targetPath: string) => Promise<void>;
    env?: NodeJS.ProcessEnv;
}): Promise<GbrainDetection>;
export declare function classifyExportDir(exportDir: string | undefined): {
    exportDir: string | null;
    mode: ExportMode;
};
export type SetupPlanDeps = {
    whisper: WhisperDetection;
    gbrain: GbrainDetection;
};
export declare function buildSetupPlan(config: ResolvedConfig, deps: SetupPlanDeps): SetupStep[];
