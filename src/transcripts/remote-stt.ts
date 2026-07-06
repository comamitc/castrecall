/**
 * Generic remote STT provider contract (issue #61): lets CastRecall call a
 * private/self-hosted speech-to-text service — WhisperX, faster-whisper, or
 * anything else — as an implementation of `CASTRECALL_STT_PROVIDER=remote-stt`,
 * without the transcript ladder knowing which implementation actually ran.
 *
 * Contract (normative — mirrored verbatim in README):
 * - Every request carries `Authorization: Bearer <token>` when a token is configured.
 * - `GET {base}/health` — 200 (optionally `{ status, implementation, model }`) means ready;
 *   any non-2xx or network failure means not ready. Never throws.
 * - `POST {base}/transcribe` — JSON `{ audio_url, model? }` by default, or
 *   `multipart/form-data` with a `file` field (+ `model`) when
 *   `CASTRECALL_REMOTE_STT_UPLOAD=true` — upload mode downloads the audio itself
 *   and never also sends `audio_url`.
 * - Response is either a normalized result object directly (sync), or
 *   `{ job_id, status }` (async), polled via `GET {base}/jobs/{job_id}` until
 *   `status` is `"completed"` (reads `result`, falling back to the body itself)
 *   or `"failed"` (terminal).
 * - Normalized result: `{ text?, segments?, model?, implementation?, warnings?, duration? }`.
 *   `segments[].start/end` are seconds. `text` or non-empty `segments` is
 *   required; when `text` is absent it is synthesized from `segments`.
 */

import { CastrecallSetupError, type ResolvedConfig } from "../config.js";
import type { FetchLike } from "../pocketcasts/client.js";
import { segmentsToText, type TranscriptSegment } from "./normalize.js";
import { isRetryableHttpStatus, RetryableSttError, utterancesToSegments, type SttResult } from "./stt.js";

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 15 * 60_000;

/**
 * Exact remote-stt provenance (issue #61): implementation/model as reported
 * by the remote service, host-only base URL (never the token or full
 * path/query — see `baseUrlHost` below), and how the job actually ran.
 */
export type RemoteSttGeneration = {
  kind: "remote-stt";
  implementation?: string;
  model?: string;
  /** `new URL(base).host` — deliberately never the full base URL (may carry a path/query) or the token. */
  baseUrlHost: string;
  mode: "sync" | "async";
  submittedBy: "audio_url" | "upload";
  warnings?: string[];
  durationSeconds?: number;
};

export type RemoteSttDeps = {
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** Injectable clock (ms since epoch) so the poll deadline is deterministic in tests. */
  now?: () => number;
};

type RawRemoteResult = {
  text?: string;
  segments?: Array<{ speaker?: string | number; text?: string; start?: number; end?: number }>;
  model?: string;
  implementation?: string;
  warnings?: string[];
  duration?: number;
};

type NormalizedRemoteResult = {
  text: string;
  segments?: TranscriptSegment[];
  model?: string;
  implementation?: string;
  warnings?: string[];
  durationSeconds?: number;
};

function trimmedBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, "");
}

function authHeaders(config: ResolvedConfig): Record<string, string> {
  return config.stt.remoteToken ? { authorization: `Bearer ${config.stt.remoteToken}` } : {};
}

/**
 * Readiness probe for `castrecall_setup`/`castrecall_setup_status` — outside
 * the billed ladder path, so it deliberately never throws, mirroring
 * `detectLocalWhisper`.
 */
export async function remoteSttHealth(
  config: ResolvedConfig,
  fetchImpl: FetchLike = fetch,
): Promise<{ ok: boolean; reason?: string; implementation?: string; model?: string }> {
  if (!config.stt.remoteBaseUrl) {
    return { ok: false, reason: "CASTRECALL_REMOTE_STT_BASE_URL is not set." };
  }
  const base = trimmedBaseUrl(config.stt.remoteBaseUrl);
  try {
    const response = await fetchImpl(`${base}/health`, { headers: authHeaders(config) });
    if (!response.ok) {
      return { ok: false, reason: `Remote STT health check failed with HTTP ${response.status}.` };
    }
    const body = (await response.json().catch(() => ({}))) as { implementation?: string; model?: string };
    return { ok: true, implementation: body.implementation, model: body.model };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `Remote STT health check failed: ${message}.` };
  }
}

/**
 * Wraps one remote-stt HTTP call (submit or poll) with the same
 * retryable-vs-terminal classification cloud providers use: a rejected fetch
 * or a retryable HTTP status becomes `RetryableSttError`, 401 becomes
 * `CastrecallSetupError`, any other non-OK status is a plain terminal `Error`.
 */
async function fetchClassified(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  step: "submit" | "poll",
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RetryableSttError(
      `Remote STT ${step} request failed before a response arrived (${message}); ` +
        "the episode stays eligible for a later run.",
    );
  }
  if (response.status === 401) {
    throw new CastrecallSetupError("Remote STT provider rejected CASTRECALL_REMOTE_STT_TOKEN.");
  }
  if (!response.ok) {
    const message = `Remote STT ${step} request failed with HTTP ${response.status}.`;
    if (isRetryableHttpStatus(response.status)) throw new RetryableSttError(message);
    throw new Error(message);
  }
  return response;
}

/**
 * Downloads `audioUrl` and builds the multipart upload request for
 * `CASTRECALL_REMOTE_STT_UPLOAD=true` — for providers that cannot fetch a
 * remote URL themselves. Upload mode never also sends `audio_url`.
 */
async function buildUploadRequest(
  audioUrl: string,
  config: ResolvedConfig,
  fetchImpl: FetchLike,
  headers: Record<string, string>,
): Promise<RequestInit> {
  let audioResponse: Response;
  try {
    audioResponse = await fetchImpl(audioUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RetryableSttError(
      `Remote STT audio download failed before a response arrived (${message}); ` +
        "the episode stays eligible for a later run.",
    );
  }
  if (!audioResponse.ok) {
    const message = `Remote STT audio download failed with HTTP ${audioResponse.status}.`;
    if (isRetryableHttpStatus(audioResponse.status)) throw new RetryableSttError(message);
    throw new Error(message);
  }
  const audio = await audioResponse.arrayBuffer();
  const fileName = audioUrl.split("?")[0].split("/").pop() || "episode.mp3";
  const form = new FormData();
  if (config.stt.remoteModel) form.set("model", config.stt.remoteModel);
  form.set("file", new Blob([audio]), fileName);
  return { method: "POST", headers, body: form };
}

async function pollJob(
  base: string,
  headers: Record<string, string>,
  jobId: string,
  fetchImpl: FetchLike,
  sleep: (ms: number) => Promise<void>,
  pollIntervalMs: number,
  timeoutMs: number,
  now: () => number,
): Promise<RawRemoteResult> {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await sleep(pollIntervalMs);
    const response = await fetchClassified(fetchImpl, `${base}/jobs/${jobId}`, { headers }, "poll");
    const body = (await response.json()) as { status?: string; result?: RawRemoteResult; error?: string } &
      RawRemoteResult;
    if (body.status === "completed") {
      return body.result ?? body;
    }
    if (body.status === "failed") {
      throw new Error(`Remote STT transcription failed: ${body.error ?? "unknown error"}.`);
    }
  }
  throw new Error(
    `Remote STT transcription did not complete within ${Math.round(timeoutMs / 60_000)} minutes; ` +
      "try again later — the job may still finish on the remote side.",
  );
}

function parseRemoteResult(body: RawRemoteResult): NormalizedRemoteResult {
  const segments = body.segments?.length
    ? utterancesToSegments(
        body.segments.map((s) => ({
          speaker: s.speaker,
          text: s.text ?? "",
          startSeconds: s.start,
          endSeconds: s.end,
        })),
      )
    : undefined;
  const text = body.text?.trim() ? body.text.trim() : segments?.length ? segmentsToText(segments).trim() : "";
  if (!text) {
    throw new Error("Remote STT returned an empty or invalid transcript (no text and no segments).");
  }
  return {
    text,
    segments,
    model: body.model,
    implementation: body.implementation,
    warnings: body.warnings,
    durationSeconds: body.duration,
  };
}

export async function transcribeWithRemoteStt(
  config: ResolvedConfig,
  audioUrl: string,
  deps: RemoteSttDeps = {},
): Promise<SttResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollIntervalMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
  const timeoutMs = deps.timeoutMs ?? POLL_TIMEOUT_MS;
  const now = deps.now ?? Date.now;

  const base = trimmedBaseUrl(config.stt.remoteBaseUrl ?? "");
  const headers = authHeaders(config);
  const submittedBy: "audio_url" | "upload" = config.stt.remoteForceUpload ? "upload" : "audio_url";

  const requestInit: RequestInit =
    submittedBy === "upload"
      ? await buildUploadRequest(audioUrl, config, fetchImpl, headers)
      : {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            audio_url: audioUrl,
            ...(config.stt.remoteModel ? { model: config.stt.remoteModel } : {}),
          }),
        };

  const submitResponse = await fetchClassified(fetchImpl, `${base}/transcribe`, requestInit, "submit");
  const submitted = (await submitResponse.json()) as { job_id?: string } & RawRemoteResult;

  const mode: "sync" | "async" = submitted.job_id ? "async" : "sync";
  const resultBody = submitted.job_id
    ? await pollJob(base, headers, submitted.job_id, fetchImpl, sleep, pollIntervalMs, timeoutMs, now)
    : submitted;

  const normalized = parseRemoteResult(resultBody);
  const model = normalized.model ?? config.stt.remoteModel;
  return {
    text: normalized.text,
    provider: "remote-stt",
    model,
    segments: normalized.segments,
    generation: {
      kind: "remote-stt",
      implementation: normalized.implementation,
      model,
      baseUrlHost: new URL(base).host,
      mode,
      submittedBy,
      warnings: normalized.warnings,
      durationSeconds: normalized.durationSeconds,
    },
  };
}
