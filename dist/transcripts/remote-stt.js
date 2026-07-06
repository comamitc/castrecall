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
import { CastrecallSetupError } from "../config.js";
import { segmentsToText } from "./normalize.js";
import { createWriteStream, openAsBlob } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isRetryableHttpStatus, RetryableSttError, utterancesToSegments } from "./stt.js";
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 15 * 60_000;
function trimmedBaseUrl(raw) {
    return raw.replace(/\/+$/, "");
}
function authHeaders(config) {
    return config.stt.remoteToken ? { authorization: `Bearer ${config.stt.remoteToken}` } : {};
}
/**
 * Readiness probe for `castrecall_setup`/`castrecall_setup_status` — outside
 * the billed ladder path, so it deliberately never throws, mirroring
 * `detectLocalWhisper`.
 */
export async function remoteSttHealth(config, fetchImpl = fetch) {
    if (!config.stt.remoteBaseUrl) {
        return { ok: false, reason: "CASTRECALL_REMOTE_STT_BASE_URL is not set." };
    }
    const base = trimmedBaseUrl(config.stt.remoteBaseUrl);
    try {
        const response = await fetchImpl(`${base}/health`, { headers: authHeaders(config) });
        if (!response.ok) {
            return { ok: false, reason: `Remote STT health check failed with HTTP ${response.status}.` };
        }
        const body = (await response.json().catch(() => ({})));
        return { ok: true, implementation: body.implementation, model: body.model };
    }
    catch (error) {
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
async function fetchClassified(fetchImpl, url, init, step) {
    let response;
    try {
        response = await fetchImpl(url, init);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new RetryableSttError(`Remote STT ${step} request failed before a response arrived (${message}); ` +
            "the episode stays eligible for a later run.");
    }
    if (response.status === 401 || response.status === 403) {
        // Both are auth/permission problems with OUR credentials, not evidence
        // about the job or the audio: classified as setup errors so callers
        // (including the async-job resume path) keep durable state — after the
        // operator fixes CASTRECALL_REMOTE_STT_TOKEN, a still-running remote
        // job can be resumed instead of resubmitted.
        throw new CastrecallSetupError(`Remote STT provider rejected CASTRECALL_REMOTE_STT_TOKEN (HTTP ${response.status}).`);
    }
    if (!response.ok) {
        const message = `Remote STT ${step} request failed with HTTP ${response.status}.`;
        if (isRetryableHttpStatus(response.status))
            throw new RetryableSttError(message);
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
async function buildUploadRequest(audioUrl, config, fetchImpl, headers) {
    let audioResponse;
    try {
        audioResponse = await fetchImpl(audioUrl);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new RetryableSttError(`Remote STT audio download failed before a response arrived (${message}); ` +
            "the episode stays eligible for a later run.");
    }
    if (!audioResponse.ok) {
        const message = `Remote STT audio download failed with HTTP ${audioResponse.status}.`;
        if (isRetryableHttpStatus(audioResponse.status))
            throw new RetryableSttError(message);
        throw new Error(message);
    }
    // Spool the download to a temp file instead of buffering the whole
    // episode with arrayBuffer(): hour-long audio can run to hundreds of MB,
    // which would sit fully in memory (and can OOM the process) before the
    // provider is even called. The disk-backed Blob from openAsBlob streams
    // during the multipart upload; the caller runs `cleanup` once the submit
    // request has completed.
    const tmpPath = path.join(os.tmpdir(), `castrecall-remote-stt-${randomUUID()}${path.extname(audioUrl.split("?")[0]) || ".mp3"}`);
    try {
        if (!audioResponse.body)
            throw new Error("audio response had no body stream");
        await pipeline(Readable.fromWeb(audioResponse.body), createWriteStream(tmpPath));
    }
    catch (error) {
        await fs.rm(tmpPath, { force: true }).catch(() => { });
        const message = error instanceof Error ? error.message : String(error);
        throw new RetryableSttError(`Remote STT audio download failed mid-stream (${message}); the episode stays eligible ` +
            "for a later run.");
    }
    const fileName = audioUrl.split("?")[0].split("/").pop() || "episode.mp3";
    const form = new FormData();
    if (config.stt.remoteModel)
        form.set("model", config.stt.remoteModel);
    form.set("file", await openAsBlob(tmpPath), fileName);
    return {
        init: { method: "POST", headers, body: form },
        cleanup: async () => {
            await fs.rm(tmpPath, { force: true }).catch(() => { });
        },
    };
}
async function pollJob(base, headers, jobId, fetchImpl, sleep, pollIntervalMs, timeoutMs, now) {
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
        await sleep(pollIntervalMs);
        const response = await fetchClassified(fetchImpl, `${base}/jobs/${jobId}`, { headers }, "poll");
        const body = (await response.json());
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
    throw new RetryableSttError(`Remote STT transcription did not complete within ${Math.round(timeoutMs / 60_000)} minutes; ` +
        "the job may still finish on the remote side — the episode stays eligible for a later run.");
}
function parseRemoteResult(body) {
    const segments = body.segments?.length
        ? utterancesToSegments(body.segments.map((s) => ({
            speaker: s.speaker,
            text: s.text ?? "",
            startSeconds: s.start,
            endSeconds: s.end,
        })))
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
class UnknownRemoteJobError extends Error {
}
/**
 * Durable async-job state (issue #61 review): when a remote job outlives the
 * local poll deadline, its job_id is kept under
 * `<dataDir>/.staging/remote-stt-jobs/` (the reserved private scratch
 * namespace) so the NEXT attempt resumes polling the SAME job instead of
 * enqueuing a duplicate long GPU transcription. Keyed by a hash of
 * base URL + audio URL; the file is removed on completion, on terminal job
 * failure, and whenever the remote no longer recognizes the job.
 */
function jobStatePath(config, base, audioUrl) {
    // The key covers every request-shaping input (base, audio, model, submit
    // mode): changing CASTRECALL_REMOTE_STT_MODEL or _UPLOAD between attempts
    // must NOT resume a job produced under the old settings — provenance has
    // to reflect the configuration the user actually retried with.
    const signature = [base, audioUrl, config.stt.remoteModel ?? "", config.stt.remoteForceUpload ? "upload" : "audio_url"].join("\n");
    const key = createHash("sha256").update(signature, "utf8").digest("hex").slice(0, 32);
    return path.join(config.dataDir, ".staging", "remote-stt-jobs", `${key}.json`);
}
async function readJobState(statePath) {
    try {
        const parsed = JSON.parse(await fs.readFile(statePath, "utf8"));
        return typeof parsed.jobId === "string" && parsed.jobId ? parsed.jobId : undefined;
    }
    catch {
        return undefined;
    }
}
async function writeJobState(statePath, jobId) {
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, JSON.stringify({ jobId, savedAt: new Date().toISOString() }), "utf8");
}
async function clearJobState(statePath) {
    await fs.rm(statePath, { force: true }).catch(() => { });
}
export async function transcribeWithRemoteStt(config, audioUrl, deps = {}) {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const pollIntervalMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
    const timeoutMs = deps.timeoutMs ?? POLL_TIMEOUT_MS;
    const now = deps.now ?? Date.now;
    const base = trimmedBaseUrl(config.stt.remoteBaseUrl ?? "");
    const headers = authHeaders(config);
    const submittedBy = config.stt.remoteForceUpload ? "upload" : "audio_url";
    const statePath = jobStatePath(config, base, audioUrl);
    // Resume before ever resubmitting: a prior attempt's async job may still
    // be running (or already finished) server-side. Retryable/auth errors
    // keep the state file so a later run can resume again; any terminal poll
    // error (job unknown, job failed) forgets the job and falls through to a
    // fresh submit below.
    const priorJobId = await readJobState(statePath);
    if (priorJobId) {
        let resumedBody;
        try {
            resumedBody = await pollJob(base, headers, priorJobId, fetchImpl, sleep, pollIntervalMs, timeoutMs, now);
        }
        catch (error) {
            if (error instanceof UnknownRemoteJobError) {
                // Provider forgot the job — the one case where resubmitting is right.
                await clearJobState(statePath);
            }
            else if (error instanceof CastrecallSetupError) {
                // Auth failure on the resume poll: disambiguate GLOBAL auth failure
                // (token broken everywhere — keep the job handle; a fixed token can
                // still resume) from a JOB-SCOPED denial (provider healthy under
                // this token, but this job id is not ours anymore — rotated
                // account, ACL change; keeping the handle would strand the episode
                // behind endless 403s). The health endpoint uses the same token, so
                // it decides which case this is.
                const health = await remoteSttHealth(config, fetchImpl);
                if (health.ok) {
                    await clearJobState(statePath);
                    throw new Error(`Remote STT denied access to saved job ${priorJobId} while the service is otherwise ` +
                        "reachable with this token; the saved job was forgotten. " +
                        `(${error.message})`);
                }
                throw error;
            }
            else if (error instanceof RetryableSttError) {
                // Still running / transient: keep the state for the next run.
                throw error;
            }
            else {
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
    const upload = submittedBy === "upload" ? await buildUploadRequest(audioUrl, config, fetchImpl, headers) : undefined;
    const requestInit = upload
        ? upload.init
        : {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({
                audio_url: audioUrl,
                ...(config.stt.remoteModel ? { model: config.stt.remoteModel } : {}),
            }),
        };
    let submitResponse;
    try {
        submitResponse = await fetchClassified(fetchImpl, `${base}/transcribe`, requestInit, "submit");
    }
    finally {
        // The spooled temp file only needs to outlive the submit request.
        await upload?.cleanup();
    }
    const submitted = (await submitResponse.json());
    const mode = submitted.job_id ? "async" : "sync";
    let resultBody;
    if (submitted.job_id) {
        // Persist the job id BEFORE polling: a poll-deadline expiry throws
        // RetryableSttError, and the next attempt must resume this exact job
        // rather than enqueue duplicate remote GPU work.
        await writeJobState(statePath, submitted.job_id);
        try {
            resultBody = await pollJob(base, headers, submitted.job_id, fetchImpl, sleep, pollIntervalMs, timeoutMs, now);
            await clearJobState(statePath);
        }
        catch (error) {
            // Keep the state only for outcomes where the job may still complete
            // (deadline expiry, transient poll failures) or where only our auth
            // is broken; a terminally failed job must not be resumed.
            if (!(error instanceof RetryableSttError) && !(error instanceof CastrecallSetupError)) {
                await clearJobState(statePath);
            }
            throw error;
        }
    }
    else {
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
