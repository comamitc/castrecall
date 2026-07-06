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
import { segmentsToText, type TranscriptSegment } from "./normalize.js";

const OPENAI_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const ASSEMBLYAI_BASE = "https://api.assemblyai.com/v2";
const DEEPGRAM_BASE = "https://api.deepgram.com/v1/listen";
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 15 * 60_000;

export type SttResult = {
  text: string;
  provider: "assemblyai" | "openai" | "deepgram";
  model?: string;
  /** Diarized speaker turns (issue #44), when the provider returned per-utterance speaker labels. */
  segments?: TranscriptSegment[];
};

/** `` `Speaker ${raw}` `` — never dropped by a falsy check, so a numeric `0` speaker still renders. */
function speakerLabel(raw: string | number): string {
  return `Speaker ${raw}`;
}

/**
 * Build `TranscriptSegment[]` from provider utterances, given each
 * utterance's raw speaker label and its start/end already converted to
 * seconds. Timing fields (`start`/`end`/`startSeconds`/`endSeconds`) are
 * emitted only when a finite numeric time exists, matching the
 * `parseJsonTranscript` convention of a bare-seconds string.
 */
function utterancesToSegments(
  utterances: Array<{ speaker?: string | number; text: string; startSeconds?: number; endSeconds?: number }>,
): TranscriptSegment[] {
  return utterances.map((u) => {
    const hasTiming = u.startSeconds !== undefined && u.endSeconds !== undefined;
    return {
      speaker: u.speaker !== undefined ? speakerLabel(u.speaker) : undefined,
      text: u.text,
      ...(hasTiming
        ? {
            startSeconds: u.startSeconds,
            endSeconds: u.endSeconds,
            start: String(u.startSeconds),
            end: String(u.endSeconds),
          }
        : {}),
    };
  });
}

/**
 * Thrown for provider failures that are transient (rate limits, timeouts,
 * upstream 5xx) rather than a fundamental rejection of the request. Callers
 * can use this to keep the episode eligible for the next scheduled retry
 * instead of recording a terminal failure.
 */
export class RetryableSttError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableSttError";
  }
}

const RETRYABLE_HTTP_STATUSES = new Set([408, 429]);

function isRetryableHttpStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUSES.has(status) || status >= 500;
}

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
      utterances?: Array<{ speaker?: string; text?: string; start?: number; end?: number }>;
    };
    if (status.status === "completed") {
      // AssemblyAI's utterance start/end are milliseconds.
      const segments = status.utterances?.length
        ? utterancesToSegments(
            status.utterances.map((u) => ({
              speaker: u.speaker,
              text: u.text ?? "",
              startSeconds: u.start !== undefined ? u.start / 1000 : undefined,
              endSeconds: u.end !== undefined ? u.end / 1000 : undefined,
            })),
          )
        : undefined;
      const text = segments ? segmentsToText(segments) : (status.text ?? "");
      if (!text.trim()) throw new Error("AssemblyAI completed but returned empty text.");
      return { text: text.trim(), provider: "assemblyai", segments };
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
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Token ${config.stt.deepgramApiKey ?? ""}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ url: audioUrl }),
    });
  } catch (error) {
    // A rejected fetch (connection reset, DNS/TLS failure, abort) is just as
    // transient as a retryable HTTP status — without this, the episode would
    // be recorded as terminally failed and stranded until a manual fetch.
    const message = error instanceof Error ? error.message : String(error);
    throw new RetryableSttError(
      `Deepgram request failed before a response arrived (${message}); ` +
        "the episode stays eligible for a later run.",
    );
  }
  if (response.status === 401) {
    throw new CastrecallSetupError("Deepgram rejected DEEPGRAM_API_KEY.");
  }
  if (!response.ok) {
    const message =
      `Deepgram transcription failed with HTTP ${response.status}. Long episodes can time out on ` +
      "the prerecorded endpoint; retry later.";
    if (isRetryableHttpStatus(response.status)) {
      throw new RetryableSttError(message);
    }
    throw new Error(message);
  }
  const body = (await response.json()) as {
    results?: {
      utterances?: Array<{ speaker?: number; transcript?: string; start?: number; end?: number }>;
      channels?: Array<{ alternatives?: Array<{ transcript?: string }> }>;
    };
  };
  // Deepgram's utterance start/end are already seconds (unlike AssemblyAI's milliseconds).
  const segments = body.results?.utterances?.length
    ? utterancesToSegments(
        body.results.utterances.map((u) => ({
          speaker: u.speaker,
          text: u.transcript ?? "",
          startSeconds: u.start,
          endSeconds: u.end,
        })),
      )
    : undefined;
  const text = segments ? segmentsToText(segments) : (body.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "");
  if (!text.trim()) throw new Error("Deepgram completed but returned empty text.");
  return { text: text.trim(), provider: "deepgram", model: config.stt.deepgramModel, segments };
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
