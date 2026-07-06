/**
 * Corpus-scale transcription preflight (issue #55): summarizes what a
 * batch/scheduled run will do to episodes still missing a transcript before
 * any compute starts — backend/model, whether that model is quality-approved,
 * a rough runtime class, whether timestamps survive, and whether local audio
 * is retained — and blocks a corpus-scale run from silently falling through
 * to a low-quality model without explicit opt-in.
 *
 * Pure builder mirroring buildSetupPlan (../setup.ts): receives pre-detected
 * facts (a WhisperDetection) and does no I/O itself — detection is the
 * caller's job (see transcriptionPreflight() in ../tools.ts). It reuses the
 * exact resolvers a real run uses (resolveWhisperModel,
 * resolveWhisperDecodeArgs, localWhisperReadiness), so this report can never
 * disagree with what runTranscriptLadder would actually do.
 */
import type { ResolvedConfig, SttProvider } from "../config.js";
import { type LocalWhisperModelSource, type WhisperDetection, type WhisperFlavor, type WhisperModelResolution } from "./local-whisper.js";
/**
 * Corpus-scale threshold (issue #55): below this, a run is a single-episode
 * or small test batch and is never gated, regardless of model quality. This
 * is a product judgment call, not a technical constraint — raise or lower it
 * in this one place.
 */
export declare const CORPUS_SCALE_MIN_EPISODES = 5;
export type WhisperModelQuality = "approved" | "low-quality" | "unknown";
/**
 * Classifies the concrete model a run would use, never the preset/flavor
 * name: a preset always resolves to one of WHISPER_PRESETS' concrete model
 * strings first, so classifying by the resolved model string alone (rather
 * than special-casing preset names) keeps this in sync with
 * resolveWhisperModel by construction. An unrecognized explicit model or a
 * custom command's un-pinned default is reported "unknown" — never silently
 * "approved" — so an operator sees "we don't know" rather than false
 * assurance.
 */
export declare function classifyWhisperModelQuality(flavor: WhisperFlavor | undefined, resolved: WhisperModelResolution): WhisperModelQuality;
export declare function estimateRuntimeClass(episodesPendingTranscript: number, backend: WhisperFlavor | null): {
    runtimeClass: string;
    runtimeCaveat: string;
};
export type TranscriptionPreflight = {
    /** Episodes missing a stored transcript that could fall through to local generation after the free RSS/Taddy/Podchaser rungs — not a guarantee they all will. */
    episodesPendingTranscript: number;
    corpusScale: boolean;
    backend: WhisperFlavor | null;
    model: string | null;
    modelSource: LocalWhisperModelSource;
    preset?: string;
    quality: WhisperModelQuality;
    /** Whether the local-whisper rung can actually run at usable quality — see localWhisperReadiness. */
    ready: boolean;
    readinessReason?: string;
    runtimeClass: string;
    runtimeCaveat: string;
    timestamps: {
        segments: boolean;
        words: boolean;
    };
    /** Local audio is always downloaded to a temp dir and removed in a finally block — see transcribeWithLocalWhisper. */
    audioRetention: "temporary";
    lowQualityOptIn: boolean;
    /** Whether rung 5 (paid cloud STT) is enabled/configured and would otherwise run as the
     * fallback once local Whisper is blocked or misses — see `sttFallbackBlocked`. */
    sttFallback: {
        enabled: boolean;
        provider: SttProvider;
        available: boolean;
    };
    /** True when this run's `blocked` local-Whisper gate ALSO skips the paid STT rung, so a
     * corpus-scale run can never silently fall through a free local block into billed
     * transcription without the operator seeing this report first. */
    sttFallbackBlocked: boolean;
    blocked: boolean;
    reason?: string;
    remediation?: string[];
};
export declare function buildTranscriptionPreflight(params: {
    config: ResolvedConfig;
    whisper: WhisperDetection;
    episodesPendingTranscript: number;
}): TranscriptionPreflight;
