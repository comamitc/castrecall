/**
 * Rung 3 of the transcript ladder: paid speech-to-text fallback.
 * Never runs unless explicitly enabled (CASTRECALL_ENABLE_STT=true or plugin
 * config sttEnabled) because it costs money per episode.
 *
 * Providers:
 * - AssemblyAI (default): accepts a remote audio URL directly — no download needed.
 * - OpenAI: requires downloading the audio and uploading it (25 MB API limit).
 */
import { CastrecallSetupError } from "../config.js";
const OPENAI_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const ASSEMBLYAI_BASE = "https://api.assemblyai.com/v2";
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 15 * 60_000;
export function sttAvailability(config) {
    if (!config.stt.enabled) {
        return {
            ok: false,
            reason: "Speech-to-text is disabled (it costs money per episode). Enable it explicitly with " +
                "CASTRECALL_ENABLE_STT=true, or via the plugin config's sttEnabled setting.",
        };
    }
    if (config.stt.provider === "assemblyai" && !config.stt.assemblyaiApiKey) {
        return {
            ok: false,
            reason: "STT provider is 'assemblyai' but ASSEMBLYAI_API_KEY is not set. " +
                "Get a key at https://www.assemblyai.com or switch with CASTRECALL_STT_PROVIDER=openai.",
        };
    }
    if (config.stt.provider === "openai" && !config.stt.openaiApiKey) {
        return {
            ok: false,
            reason: "STT provider is 'openai' but OPENAI_API_KEY is not set. " +
                "Set it, or switch with CASTRECALL_STT_PROVIDER=assemblyai.",
        };
    }
    return { ok: true };
}
export async function transcribeAudio(config, audioUrl, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
    const availability = sttAvailability(config);
    if (!availability.ok)
        throw new CastrecallSetupError(availability.reason ?? "STT unavailable.");
    if (!audioUrl)
        throw new Error("Episode has no audio URL; cannot transcribe.");
    return config.stt.provider === "assemblyai"
        ? transcribeWithAssemblyAi(config, audioUrl, fetchImpl, sleep)
        : transcribeWithOpenAi(config, audioUrl, fetchImpl);
}
async function transcribeWithAssemblyAi(config, audioUrl, fetchImpl, sleep) {
    const headers = {
        authorization: config.stt.assemblyaiApiKey ?? "",
        "content-type": "application/json",
    };
    const createResponse = await fetchImpl(`${ASSEMBLYAI_BASE}/transcript`, {
        method: "POST",
        headers,
        body: JSON.stringify({ audio_url: audioUrl, speaker_labels: true }),
    });
    if (createResponse.status === 401) {
        throw new CastrecallSetupError("AssemblyAI rejected ASSEMBLYAI_API_KEY.");
    }
    if (!createResponse.ok) {
        throw new Error(`AssemblyAI transcript creation failed with HTTP ${createResponse.status}.`);
    }
    const created = (await createResponse.json());
    if (!created.id)
        throw new Error("AssemblyAI returned no transcript id.");
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        const pollResponse = await fetchImpl(`${ASSEMBLYAI_BASE}/transcript/${created.id}`, {
            headers: { authorization: headers.authorization },
        });
        if (!pollResponse.ok) {
            throw new Error(`AssemblyAI polling failed with HTTP ${pollResponse.status}.`);
        }
        const status = (await pollResponse.json());
        if (status.status === "completed") {
            const text = status.utterances?.length
                ? status.utterances
                    .map((u) => (u.speaker ? `Speaker ${u.speaker}: ${u.text ?? ""}` : (u.text ?? "")))
                    .join("\n")
                : (status.text ?? "");
            if (!text.trim())
                throw new Error("AssemblyAI completed but returned empty text.");
            return { text: text.trim(), provider: "assemblyai" };
        }
        if (status.status === "error") {
            throw new Error(`AssemblyAI transcription failed: ${status.error ?? "unknown error"}.`);
        }
    }
    throw new Error(`AssemblyAI transcription did not complete within ${POLL_TIMEOUT_MS / 60_000} minutes; ` +
        "try again later — the job may still finish on their side.");
}
async function transcribeWithOpenAi(config, audioUrl, fetchImpl) {
    const audioResponse = await fetchImpl(audioUrl);
    if (!audioResponse.ok) {
        throw new Error(`Audio download failed with HTTP ${audioResponse.status}.`);
    }
    const audio = await audioResponse.arrayBuffer();
    if (audio.byteLength > OPENAI_MAX_UPLOAD_BYTES) {
        throw new Error(`Audio is ${(audio.byteLength / 1024 / 1024).toFixed(1)} MB, above OpenAI's 25 MB upload limit. ` +
            "Use CASTRECALL_STT_PROVIDER=assemblyai for long episodes (it streams from the URL).");
    }
    const fileName = audioUrl.split("?")[0].split("/").pop() || "episode.mp3";
    const form = new FormData();
    form.set("model", config.stt.openaiModel);
    form.set("file", new Blob([audio]), fileName);
    const response = await fetchImpl("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { authorization: `Bearer ${config.stt.openaiApiKey ?? ""}` },
        body: form,
    });
    if (response.status === 401) {
        throw new CastrecallSetupError("OpenAI rejected OPENAI_API_KEY.");
    }
    if (!response.ok) {
        throw new Error(`OpenAI transcription failed with HTTP ${response.status}.`);
    }
    const body = (await response.json());
    if (!body.text?.trim())
        throw new Error("OpenAI transcription returned empty text.");
    return { text: body.text.trim(), provider: "openai", model: config.stt.openaiModel };
}
