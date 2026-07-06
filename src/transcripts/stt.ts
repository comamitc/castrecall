/**
 * Rung 3 of the transcript ladder: paid speech-to-text fallback.
 * Never runs unless explicitly enabled (CASTRECALL_ENABLE_STT=true or plugin
 * config sttEnabled) because it costs money per episode.
 *
 * Providers:
 * - AssemblyAI (default): accepts a remote audio URL directly — no download needed.
 * - OpenAI: requires downloading the audio and uploading it (25 MB API limit).
 * - Deepgram: accepts a remote audio URL directly, like AssemblyAI, but its
 *   prerecorded endpoint responds synchronously (no polling) with diarized
 *   utterances.
 */

import { CastrecallSetupError, type ResolvedConfig } from "../config.js";
import type { FetchLike } from "../pocketcasts/client.js";

const OPENAI_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const ASSEMBLYAI_BASE = "https://api.assemblyai.com/v2";
const DEEPGRAM_BASE = "https://api.deepgram.com/v1/listen";
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 15 * 60_000;

export type SttResult = {
  text: string;
  provider: "assemblyai" | "openai" | "deepgram";
  model?: string;
};

export function sttAvailability(config: ResolvedConfig): { ok: boolean; reason?: string } {
  if (!config.stt.enabled) {
    return {
      ok: false,
      reason:
        "Speech-to-text is disabled (it costs money per episode). Enable it explicitly with " +
        "CASTRECALL_ENABLE_STT=true, or via the plugin config's sttEnabled setting.",
    };
  }
  if (config.stt.provider === "assemblyai" && !config.stt.assemblyaiApiKey) {
    return {
      ok: false,
      reason:
        "STT provider is 'assemblyai' but ASSEMBLYAI_API_KEY is not set. " +
        "Get a key at https://www.assemblyai.com or switch with CASTRECALL_STT_PROVIDER=openai.",
    };
  }
  if (config.stt.provider === "openai" && !config.stt.openaiApiKey) {
    return {
      ok: false,
      reason:
        "STT provider is 'openai' but OPENAI_API_KEY is not set. " +
        "Set it, or switch with CASTRECALL_STT_PROVIDER=assemblyai.",
    };
  }
  if (config.stt.provider === "deepgram" && !config.stt.deepgramApiKey) {
    return {
      ok: false,
      reason:
        "STT provider is 'deepgram' but DEEPGRAM_API_KEY is not set. " +
        "Get a key at https://deepgram.com or switch with CASTRECALL_STT_PROVIDER=assemblyai.",
    };
  }
  return { ok: true };
}

export async function transcribeAudio(
  config: ResolvedConfig,
  audioUrl: string,
  fetchImpl: FetchLike = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<SttResult> {
  const availability = sttAvailability(config);
  if (!availability.ok) throw new CastrecallSetupError(availability.reason ?? "STT unavailable.");
  if (!audioUrl) throw new Error("Episode has no audio URL; cannot transcribe.");
  if (config.stt.provider === "assemblyai") {
    return transcribeWithAssemblyAi(config, audioUrl, fetchImpl, sleep);
  }
  if (config.stt.provider === "deepgram") {
    return transcribeWithDeepgram(config, audioUrl, fetchImpl);
  }
  return transcribeWithOpenAi(config, audioUrl, fetchImpl);
}

async function transcribeWithAssemblyAi(
  config: ResolvedConfig,
  audioUrl: string,
  fetchImpl: FetchLike,
  sleep: (ms: number) => Promise<void>,
): Promise<SttResult> {
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
  const created = (await createResponse.json()) as { id?: string };
  if (!created.id) throw new Error("AssemblyAI returned no transcript id.");

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const pollResponse = await fetchImpl(`${ASSEMBLYAI_BASE}/transcript/${created.id}`, {
      headers: { authorization: headers.authorization },
    });
    if (!pollResponse.ok) {
      throw new Error(`AssemblyAI polling failed with HTTP ${pollResponse.status}.`);
    }
    const status = (await pollResponse.json()) as {
      status?: string;
      text?: string;
      error?: string;
      utterances?: Array<{ speaker?: string; text?: string }>;
    };
    if (status.status === "completed") {
      const text = status.utterances?.length
        ? status.utterances
            .map((u) => (u.speaker ? `Speaker ${u.speaker}: ${u.text ?? ""}` : (u.text ?? "")))
            .join("\n")
        : (status.text ?? "");
      if (!text.trim()) throw new Error("AssemblyAI completed but returned empty text.");
      return { text: text.trim(), provider: "assemblyai" };
    }
    if (status.status === "error") {
      throw new Error(`AssemblyAI transcription failed: ${status.error ?? "unknown error"}.`);
    }
  }
  throw new Error(
    `AssemblyAI transcription did not complete within ${POLL_TIMEOUT_MS / 60_000} minutes; ` +
      "try again later — the job may still finish on their side.",
  );
}

async function transcribeWithDeepgram(
  config: ResolvedConfig,
  audioUrl: string,
  fetchImpl: FetchLike,
): Promise<SttResult> {
  const url =
    `${DEEPGRAM_BASE}?model=${encodeURIComponent(config.stt.deepgramModel)}` +
    "&smart_format=true&punctuate=true&diarize=true&utterances=true";
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Token ${config.stt.deepgramApiKey ?? ""}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ url: audioUrl }),
  });
  if (response.status === 401) {
    throw new CastrecallSetupError("Deepgram rejected DEEPGRAM_API_KEY.");
  }
  if (!response.ok) {
    throw new Error(
      `Deepgram transcription failed with HTTP ${response.status}. Long episodes can time out on ` +
        "the prerecorded endpoint; retry later.",
    );
  }
  const body = (await response.json()) as {
    results?: {
      utterances?: Array<{ speaker?: number; transcript?: string }>;
      channels?: Array<{ alternatives?: Array<{ transcript?: string }> }>;
    };
  };
  const text = body.results?.utterances?.length
    ? body.results.utterances
        .map((u) => `Speaker ${u.speaker ?? 0}: ${u.transcript ?? ""}`)
        .join("\n")
    : (body.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "");
  if (!text.trim()) throw new Error("Deepgram completed but returned empty text.");
  return { text: text.trim(), provider: "deepgram", model: config.stt.deepgramModel };
}

async function transcribeWithOpenAi(
  config: ResolvedConfig,
  audioUrl: string,
  fetchImpl: FetchLike,
): Promise<SttResult> {
  const audioResponse = await fetchImpl(audioUrl);
  if (!audioResponse.ok) {
    throw new Error(`Audio download failed with HTTP ${audioResponse.status}.`);
  }
  const audio = await audioResponse.arrayBuffer();
  if (audio.byteLength > OPENAI_MAX_UPLOAD_BYTES) {
    throw new Error(
      `Audio is ${(audio.byteLength / 1024 / 1024).toFixed(1)} MB, above OpenAI's 25 MB upload limit. ` +
        "Use CASTRECALL_STT_PROVIDER=assemblyai for long episodes (it streams from the URL).",
    );
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
  const body = (await response.json()) as { text?: string };
  if (!body.text?.trim()) throw new Error("OpenAI transcription returned empty text.");
  return { text: body.text.trim(), provider: "openai", model: config.stt.openaiModel };
}
