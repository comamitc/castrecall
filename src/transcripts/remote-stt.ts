/**
 * Generic remote STT provider contract (issue #61): lets CastRecall call a
 * private/self-hosted speech-to-text service — WhisperX, faster-whisper, or
 * anything else — as an implementation of `CASTRECALL_STT_PROVIDER=remote-stt`,
 * without the transcript ladder knowing which implementation actually ran.
 *
 * Contract (normative — mirrored verbatim in README):
 * - Every request carries `Authorization: Bearer <token>` when a token is configured.
 * - `GET {base}/health` — 200 (optionally `{ status, implementation, version, model, model_ready,
 *   capabilities: { diarization, timestamps }, accepts }`) means ready (or degraded, see
 *   `remoteSttHealth`'s tri-state — issue #63); any non-2xx or network failure means unavailable;
 *   401/403 means unavailable due to auth. Never throws.
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
import { createWriteStream, openAsBlob } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isRetryableHttpStatus, PollDeadlineError, RetryableSttError, utterancesToSegments, type SttResult } from "./stt.js";

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

/** Tri-state readiness (issue #63) reported by `castrecall_setup`/`castrecall_setup_status`. */
export type RemoteSttHealth = {
  state: "ready" | "degraded" | "unavailable";
  /** Actionable, present for degraded/unavailable; NEVER the bearer token. */
  reason?: string;
  implementation?: string;
  version?: string;
  model?: string;
  modelReady?: boolean;
  capabilities?: { diarization?: boolean; timestamps?: boolean };
  /** Submit mode(s) the provider accepts — see `submittedBy` in transcribeWithRemoteStt. */
  accepts?: "audio_url" | "upload" | "both";
};

type RawHealthBody = {
  status?: string;
  implementation?: string;
  version?: string;
  model?: string;
  model_ready?: boolean;
  capabilities?: { diarization?: unknown; timestamps?: unknown };
  accepts?: string;
};

const ACCEPTS_VALUES = new Set(["audio_url", "upload", "both"]);
const HEALTH_STATUS_VALUES = new Set(["ok", "degraded"]);
/** Bounded so a host that accepts the connection but never answers can't hang a scheduled run (issue #63 review). */
const HEALTH_TIMEOUT_MS = 10_000;

/** `undefined` (not present/valid) unless the raw value is a real boolean — never coerced from truthy/falsy. */
function optionalBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Validates the health body's shape before trusting any field: every present
 * field must be the type the contract promises, or the body is treated as
 * malformed (degraded) rather than silently accepting garbage as "ready".
 */
function malformedHealthShapeReason(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "health endpoint returned a malformed shape (expected a JSON object).";
  }
  const raw = body as RawHealthBody;
  if (raw.status !== undefined && typeof raw.status !== "string") {
    return "health endpoint returned a malformed shape (`status` is not a string).";
  }
  if (raw.status !== undefined && !HEALTH_STATUS_VALUES.has(raw.status)) {
    return `health endpoint returned a malformed shape (\`status\` is not one of ok/degraded: "${raw.status}").`;
  }
  if (raw.implementation !== undefined && typeof raw.implementation !== "string") {
    return "health endpoint returned a malformed shape (`implementation` is not a string).";
  }
  if (raw.version !== undefined && typeof raw.version !== "string") {
    return "health endpoint returned a malformed shape (`version` is not a string).";
  }
  if (raw.model !== undefined && typeof raw.model !== "string") {
    return "health endpoint returned a malformed shape (`model` is not a string).";
  }
  if (raw.model_ready !== undefined && typeof raw.model_ready !== "boolean") {
    return "health endpoint returned a malformed shape (`model_ready` is not a boolean).";
  }
  if (raw.capabilities !== undefined) {
    if (typeof raw.capabilities !== "object" || raw.capabilities === null || Array.isArray(raw.capabilities)) {
      return "health endpoint returned a malformed shape (`capabilities` is not an object).";
    }
    if (raw.capabilities.diarization !== undefined && typeof raw.capabilities.diarization !== "boolean") {
      return "health endpoint returned a malformed shape (`capabilities.diarization` is not a boolean).";
    }
    if (raw.capabilities.timestamps !== undefined && typeof raw.capabilities.timestamps !== "boolean") {
      return "health endpoint returned a malformed shape (`capabilities.timestamps` is not a boolean).";
    }
  }
  if (raw.accepts !== undefined && !ACCEPTS_VALUES.has(raw.accepts)) {
    return `health endpoint returned a malformed shape (\`accepts\` is not one of audio_url/upload/both: "${raw.accepts}").`;
  }
  return undefined;
}

/**
 * Scrubs the configured remote-stt token out of health-derived strings
 * before they reach setup/status output: `reason`/`implementation`/`version`/
 * `model` can echo raw bytes from the remote body (e.g. via the malformed-shape
 * message, or a misconfigured/hostile host reflecting the Authorization header
 * back), which would otherwise leak the bearer token (issue #63 review).
 */
function redactToken(value: string | undefined, token: string | undefined): string | undefined {
  if (!value || !token) return value;
  return value.split(token).join("[redacted]");
}

function redactHealth(health: RemoteSttHealth, token: string | undefined): RemoteSttHealth {
  if (!token) return health;
  return {
    ...health,
    reason: redactToken(health.reason, token),
    implementation: redactToken(health.implementation, token),
    version: redactToken(health.version, token),
    model: redactToken(health.model, token),
  };
}

/**
 * Readiness probe for `castrecall_setup`/`castrecall_setup_status` — outside
 * the billed ladder path, so it deliberately never throws, mirroring
 * `detectLocalWhisper`. Tri-state (issue #63): `unavailable` blocks a
 * corpus-scale run (see buildTranscriptionPreflight), `degraded` never does.
 */
export async function remoteSttHealth(
  config: ResolvedConfig,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = HEALTH_TIMEOUT_MS,
): Promise<RemoteSttHealth> {
  const health = await remoteSttHealthUnredacted(config, fetchImpl, timeoutMs);
  return redactHealth(health, config.stt.remoteToken);
}

async function remoteSttHealthUnredacted(
  config: ResolvedConfig,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<RemoteSttHealth> {
  if (!config.stt.remoteBaseUrl) {
    return { state: "unavailable", reason: "CASTRECALL_REMOTE_STT_BASE_URL is not set." };
  }
  const base = trimmedBaseUrl(config.stt.remoteBaseUrl);
  try {
    const response = await fetchImpl(`${base}/health`, {
      headers: authHeaders(config),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401 || response.status === 403) {
      return {
        state: "unavailable",
        reason: config.stt.remoteToken
          ? `Remote STT provider rejected CASTRECALL_REMOTE_STT_TOKEN (HTTP ${response.status}).`
          : "Remote STT endpoint requires auth but CASTRECALL_REMOTE_STT_TOKEN is not set.",
      };
    }
    if (!response.ok) {
      return { state: "unavailable", reason: `Remote STT health check failed with HTTP ${response.status}.` };
    }
    const text = await response.text();
    if (!text.trim()) return { state: "ready" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        state: "degraded",
        reason:
          "Remote STT health endpoint returned a non-JSON body — verify CASTRECALL_REMOTE_STT_BASE_URL " +
          "points at the STT service.",
      };
    }
    const shapeReason = malformedHealthShapeReason(parsed);
    if (shapeReason) return { state: "degraded", reason: shapeReason };
    const body = parsed as RawHealthBody;
    const capabilities: { diarization?: boolean; timestamps?: boolean } | undefined = body.capabilities
      ? {
          diarization: optionalBool(body.capabilities.diarization),
          timestamps: optionalBool(body.capabilities.timestamps),
        }
      : undefined;
    const accepts = body.accepts as RemoteSttHealth["accepts"] | undefined;
    const ready: RemoteSttHealth = {
      state: "ready",
      implementation: body.implementation,
      version: body.version,
      model: body.model,
      modelReady: optionalBool(body.model_ready),
      capabilities,
      accepts,
    };
    if (body.status === "degraded") {
      return { ...ready, state: "degraded", reason: "Remote STT provider reported status: degraded." };
    }
    if (body.model_ready === false) {
      return { ...ready, state: "degraded", reason: "Remote STT provider reports its model is not ready." };
    }
    const configuredMode = config.stt.remoteForceUpload ? "upload" : "audio_url";
    const otherMode = configuredMode === "upload" ? "audio_url" : "upload";
    if (accepts === otherMode) {
      return {
        ...ready,
        state: "degraded",
        reason:
          `Remote STT is configured to submit "${configuredMode}", but the provider only accepts ` +
          `"${accepts}" — set CASTRECALL_REMOTE_STT_UPLOAD=${configuredMode === "upload" ? "false" : "true"}.`,
      };
    }
    return ready;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { state: "unavailable", reason: `Remote STT health check failed: ${message}.` };
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
  if (response.status === 401 || response.status === 403) {
    // Both are auth/permission problems with OUR credentials, not evidence
    // about the job or the audio: classified as setup errors so callers
    // (including the async-job resume path) keep durable state — after the
    // operator fixes CASTRECALL_REMOTE_STT_TOKEN, a still-running remote
    // job can be resumed instead of resubmitted.
    throw new CastrecallSetupError(
      `Remote STT provider rejected CASTRECALL_REMOTE_STT_TOKEN (HTTP ${response.status}).`,
    );
  }
  if (!response.ok) {
    const message = `Remote STT ${step} request failed with HTTP ${response.status}.`;
    if (isRetryableHttpStatus(response.status)) throw new RetryableSttError(message);
    // A 404/410 while polling means the provider does not know this job id
    // — the ONLY condition under which a resumed attempt may forget the
    // saved job and submit fresh. Every other terminal error must surface.
    if (step === "poll" && (response.status === 404 || response.status === 410)) {
      throw new UnknownRemoteJobError(message);
    }
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
): Promise<{ init: RequestInit; cleanup: () => Promise<void> }> {
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
  // Spool the download to a temp file instead of buffering the whole
  // episode with arrayBuffer(): hour-long audio can run to hundreds of MB,
  // which would sit fully in memory (and can OOM the process) before the
  // provider is even called. The disk-backed Blob from openAsBlob streams
  // during the multipart upload; the caller runs `cleanup` once the submit
  // request has completed.
  const tmpPath = path.join(
    os.tmpdir(),
    `castrecall-remote-stt-${randomUUID()}${path.extname(audioUrl.split("?")[0]) || ".mp3"}`,
  );
  try {
    if (!audioResponse.body) throw new Error("audio response had no body stream");
    await pipeline(Readable.fromWeb(audioResponse.body as import("node:stream/web").ReadableStream), createWriteStream(tmpPath));
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    throw new RetryableSttError(
      `Remote STT audio download failed mid-stream (${message}); the episode stays eligible ` +
        "for a later run.",
    );
  }
  const fileName = audioUrl.split("?")[0].split("/").pop() || "episode.mp3";
  const form = new FormData();
  if (config.stt.remoteModel) form.set("model", config.stt.remoteModel);
  form.set("file", await openAsBlob(tmpPath), fileName);
  return {
    init: { method: "POST", headers, body: form },
    cleanup: async () => {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
    },
  };
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
  // A local poll deadline is not evidence the JOB failed — the remote side
  // may still finish. Retryable keeps the episode eligible under the
  // bounded transcriptRetry backoff instead of marking it terminally failed.
  throw new PollDeadlineError(
    `Remote STT transcription did not complete within ${Math.round(timeoutMs / 60_000)} minutes; ` +
      "the job may still finish on the remote side — the episode stays eligible for a later run.",
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

/** Thrown only when the provider explicitly does not recognize a polled job id (HTTP 404/410). */
class UnknownRemoteJobError extends Error {}



/**
 * Durable async-job state (issue #61 review): when a remote job outlives the
 * local poll deadline, its job_id is kept under
 * `<dataDir>/.staging/remote-stt-jobs/` (the reserved private scratch
 * namespace) so the NEXT attempt resumes polling the SAME job instead of
 * enqueuing a duplicate long GPU transcription. Keyed by a hash of
 * base URL + audio URL; the file is removed on completion, on terminal job
 * failure, and whenever the remote no longer recognizes the job.
 */
function jobStatePath(config: ResolvedConfig, base: string, audioUrl: string): string {
  // The key covers every request-shaping input (base, audio, model, submit
  // mode): changing CASTRECALL_REMOTE_STT_MODEL or _UPLOAD between attempts
  // must NOT resume a job produced under the old settings — provenance has
  // to reflect the configuration the user actually retried with.
  const signature = [base, audioUrl, config.stt.remoteModel ?? "", config.stt.remoteForceUpload ? "upload" : "audio_url"].join("\n");
  const key = createHash("sha256").update(signature, "utf8").digest("hex").slice(0, 32);
  return path.join(config.dataDir, ".staging", "remote-stt-jobs", `${key}.json`);
}

type JobState = { jobId: string; authFailures: number };

async function readJobState(statePath: string): Promise<JobState | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      jobId?: string;
      authFailures?: number;
    };
    if (typeof parsed.jobId !== "string" || !parsed.jobId) return undefined;
    return { jobId: parsed.jobId, authFailures: typeof parsed.authFailures === "number" ? parsed.authFailures : 0 };
  } catch {
    return undefined;
  }
}

async function writeJobState(statePath: string, jobId: string, authFailures = 0): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(
    statePath,
    JSON.stringify({ jobId, authFailures, savedAt: new Date().toISOString() }),
    "utf8",
  );
}

/**
 * A 401/403 on a resume poll is AMBIGUOUS under the remote-stt contract:
 * /health is not required to validate the token, so nothing can prove
 * whether the token is globally broken (keep the handle — a fixed token
 * resumes the job) or this specific job is no longer ours (handle is dead).
 * Fail safe by KEEPING the state, but bound the ambiguity: after this many
 * consecutive auth-failed resume attempts the handle is forgotten, so a
 * genuinely dead job cannot strand the episode indefinitely.
 */
const MAX_RESUME_AUTH_FAILURES = 3;

async function clearJobState(statePath: string): Promise<void> {
  await fs.rm(statePath, { force: true }).catch(() => {});
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
  const statePath = jobStatePath(config, base, audioUrl);

  // Resume before ever resubmitting: a prior attempt's async job may still
  // be running (or already finished) server-side. Retryable/auth errors
  // keep the state file so a later run can resume again; any terminal poll
  // error (job unknown, job failed) forgets the job and falls through to a
  // fresh submit below.
  const prior = await readJobState(statePath);
  if (prior) {
    let resumedBody: RawRemoteResult | undefined;
    try {
      resumedBody = await pollJob(
        base,
        headers,
        prior.jobId,
        fetchImpl,
        sleep,
        pollIntervalMs,
        timeoutMs,
        now,
      );
    } catch (error) {
      if (error instanceof UnknownRemoteJobError) {
        // Provider forgot the job — the one case where resubmitting is right.
        await clearJobState(statePath);
      } else if (error instanceof CastrecallSetupError) {
        // Ambiguous auth failure (see MAX_RESUME_AUTH_FAILURES): keep the
        // handle so a fixed token can resume the running job, but count the
        // attempt — a job-scoped denial (rotated account/ACL) would 401/403
        // forever, and after the bound the handle is forgotten so the
        // episode is never stranded indefinitely.
        const failures = prior.authFailures + 1;
        if (failures >= MAX_RESUME_AUTH_FAILURES) {
          await clearJobState(statePath);
          throw new Error(
            `Remote STT rejected auth for saved job ${prior.jobId} on ${failures} consecutive ` +
              "attempts; the saved job was forgotten — fix CASTRECALL_REMOTE_STT_TOKEN and the " +
              `next attempt will submit fresh. (${error.message})`,
          );
        }
        await writeJobState(statePath, prior.jobId, failures);
        throw error;
      } else if (error instanceof RetryableSttError) {
        // Still running / transient: keep the state for the next run. A
        // deadline expiry means every poll in the window was authenticated
        // (200/processing), so any accumulated ambiguous-auth failures are
        // proven stale — reset the counter rather than letting separated
        // blips add up to a false forget.
        if (error instanceof PollDeadlineError && prior.authFailures > 0) {
          await writeJobState(statePath, prior.jobId, 0);
        }
        throw error;
      } else {
        // Terminal job failure: surface it. Clear the state so the NEXT
        // scheduled attempt (under the transcript retry budget) submits
        // fresh — but never silently swallow the failure in this run.
        await clearJobState(statePath);
        throw error;
      }
    }
    if (resumedBody) {
      await clearJobState(statePath);
      // Parsing stays OUTSIDE the recovery path: a malformed completed
      // result is a terminal provider defect and must surface, not trigger
      // a duplicate submission.
      const resumedNormalized = parseRemoteResult(resumedBody);
      const resumedModel = resumedNormalized.model ?? config.stt.remoteModel;
      return {
        text: resumedNormalized.text,
        provider: "remote-stt",
        model: resumedModel,
        segments: resumedNormalized.segments,
        generation: {
          kind: "remote-stt",
          implementation: resumedNormalized.implementation,
          model: resumedModel,
          baseUrlHost: new URL(base).host,
          mode: "async",
          submittedBy,
          warnings: resumedNormalized.warnings,
          durationSeconds: resumedNormalized.durationSeconds,
        },
      };
    }
  }

  const upload =
    submittedBy === "upload" ? await buildUploadRequest(audioUrl, config, fetchImpl, headers) : undefined;
  const requestInit: RequestInit = upload
    ? upload.init
    : {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          audio_url: audioUrl,
          ...(config.stt.remoteModel ? { model: config.stt.remoteModel } : {}),
        }),
      };

  let submitResponse: Response;
  try {
    submitResponse = await fetchClassified(fetchImpl, `${base}/transcribe`, requestInit, "submit");
  } finally {
    // The spooled temp file only needs to outlive the submit request.
    await upload?.cleanup();
  }
  const submitted = (await submitResponse.json()) as { job_id?: string } & RawRemoteResult;

  const mode: "sync" | "async" = submitted.job_id ? "async" : "sync";
  let resultBody: RawRemoteResult;
  if (submitted.job_id) {
    // Persist the job id BEFORE polling: a poll-deadline expiry throws
    // RetryableSttError, and the next attempt must resume this exact job
    // rather than enqueue duplicate remote GPU work.
    await writeJobState(statePath, submitted.job_id);
    try {
      resultBody = await pollJob(base, headers, submitted.job_id, fetchImpl, sleep, pollIntervalMs, timeoutMs, now);
      await clearJobState(statePath);
    } catch (error) {
      // Keep the state only for outcomes where the job may still complete
      // (deadline expiry, transient poll failures) or where only our auth
      // is broken; a terminally failed job must not be resumed.
      if (!(error instanceof RetryableSttError) && !(error instanceof CastrecallSetupError)) {
        await clearJobState(statePath);
      }
      throw error;
    }
  } else {
    resultBody = submitted;
  }

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
