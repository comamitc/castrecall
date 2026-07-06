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
import { deriveModelSource, localWhisperReadiness, resolveWhisperDecodeArgs, resolveWhisperModel, } from "./local-whisper.js";
import { sttAvailability } from "./stt.js";
/**
 * Corpus-scale threshold (issue #55): below this, a run is a single-episode
 * or small test batch and is never gated, regardless of model quality. This
 * is a product judgment call, not a technical constraint — raise or lower it
 * in this one place.
 */
export const CORPUS_SCALE_MIN_EPISODES = 5;
// The #51-quality-approved family (see WHISPER_PRESETS in local-whisper.ts).
const APPROVED_MODEL_PATTERN = /large-v3/i;
// Whisper's smaller checkpoints — usable for a quick single-episode test,
// too weak to trust for an unattended corpus run.
const LOW_QUALITY_MODEL_PATTERN = /\b(tiny|base|small)\b/i;
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
export function classifyWhisperModelQuality(flavor, resolved) {
    if (resolved.model) {
        if (APPROVED_MODEL_PATTERN.test(resolved.model))
            return "approved";
        if (LOW_QUALITY_MODEL_PATTERN.test(resolved.model))
            return "low-quality";
        return "unknown";
    }
    // mlx-whisper's undocumented internal default is Whisper's tiny model
    // (see MLX_WHISPER_MODEL_MISSING_MESSAGE) — the one backend-default case
    // that's actually known to be low-quality rather than merely unpinned.
    if (flavor === "mlx-whisper")
        return "low-quality";
    return "unknown";
}
const RUNTIME_CAVEAT = "Rough class only — no audio durations are known ahead of time; actual runtime depends on " +
    "episode length, hardware, and model size.";
export function estimateRuntimeClass(episodesPendingTranscript, backend) {
    if (backend === null) {
        return { runtimeClass: "unknown (no local Whisper CLI detected)", runtimeCaveat: RUNTIME_CAVEAT };
    }
    if (episodesPendingTranscript === 0) {
        return { runtimeClass: "none (no episodes pending transcription)", runtimeCaveat: RUNTIME_CAVEAT };
    }
    if (episodesPendingTranscript < CORPUS_SCALE_MIN_EPISODES) {
        return { runtimeClass: "minutes to under an hour", runtimeCaveat: RUNTIME_CAVEAT };
    }
    if (episodesPendingTranscript < 20) {
        return { runtimeClass: "a few hours", runtimeCaveat: RUNTIME_CAVEAT };
    }
    return { runtimeClass: "half a day or more", runtimeCaveat: RUNTIME_CAVEAT };
}
export function buildTranscriptionPreflight(params) {
    const { config, whisper, episodesPendingTranscript } = params;
    const flavor = whisper.detected?.flavor;
    const readiness = localWhisperReadiness(whisper, config.localWhisper);
    const resolved = resolveWhisperModel(flavor, config.localWhisper);
    const decodeResolution = flavor
        ? resolveWhisperDecodeArgs(flavor, config.localWhisper.decode)
        : undefined;
    const quality = classifyWhisperModelQuality(flavor, resolved);
    const corpusScale = episodesPendingTranscript >= CORPUS_SCALE_MIN_EPISODES;
    const lowQualityOptIn = config.localWhisper.allowLowQuality;
    // Deliberately does NOT fire for a config the ladder has already skipped
    // for other reasons (missing ggml model, preset error, mlx-no-model
    // without opt-in) — localWhisperReadiness reports those with their own
    // actionable message, and blocking here too would double-handle them.
    const blocked = corpusScale && readiness.ready && quality === "low-quality" && !lowQualityOptIn;
    const { runtimeClass, runtimeCaveat } = estimateRuntimeClass(episodesPendingTranscript, flavor ?? null);
    const sttAvailable = sttAvailability(config).ok;
    // A blocked run must never silently fall through its free local-Whisper gate into a paid
    // rung the operator can't see coming — see review 2 finding on issue #55. Only fires when
    // STT would actually run (enabled AND configured), so this never double-reports rung 5
    // being unavailable for its own unrelated reasons (sttAvailability already covers those).
    const sttFallbackBlocked = blocked && sttAvailable;
    return {
        episodesPendingTranscript,
        corpusScale,
        backend: flavor ?? null,
        model: resolved.model ?? null,
        modelSource: flavor ? deriveModelSource(flavor, resolved) : "none",
        ...(resolved.preset ? { preset: resolved.preset } : {}),
        quality,
        ready: readiness.ready,
        ...(readiness.ready ? {} : { readinessReason: readiness.reason }),
        runtimeClass,
        runtimeCaveat,
        timestamps: {
            segments: decodeResolution ? decodeResolution.outputFormat !== "txt" : false,
            words: decodeResolution ? decodeResolution.applied.includes("wordTimestamps") : false,
        },
        audioRetention: "temporary",
        lowQualityOptIn,
        sttFallback: { enabled: config.stt.enabled, provider: config.stt.provider, available: sttAvailable },
        sttFallbackBlocked,
        blocked,
        ...(blocked
            ? {
                reason: `${episodesPendingTranscript} episode${episodesPendingTranscript === 1 ? "" : "s"} ` +
                    `could fall through to local transcription with a low-quality model` +
                    (resolved.model ? ` (${resolved.model})` : "") +
                    ". Corpus-scale runs require an explicit opt-in before generating transcripts this way." +
                    (sttFallbackBlocked
                        ? ` Paid cloud STT (${config.stt.provider}) is also skipped this run — it would ` +
                            "otherwise run as the next rung and start billing without this tradeoff ever being shown."
                        : ""),
                remediation: [
                    "Set CASTRECALL_LOCAL_WHISPER_PRESET=best (or balanced) to use the quality-approved model.",
                    "Or set CASTRECALL_WHISPER_ALLOW_LOW_QUALITY=true to explicitly accept low-quality/fast " +
                        "transcription for this run.",
                ],
            }
            : {}),
    };
}
