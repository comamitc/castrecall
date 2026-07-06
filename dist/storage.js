/**
 * Local, private storage for CastRecall.
 *
 * Layout under the data dir (default ~/.openclaw/castrecall):
 *   state.json                     — sync state: seen listens, transcript status
 *   sources/<episodeUuid>/         — raw transcript artifacts (private source material)
 *     raw.<ext>                    — original transcript as fetched/generated
 *     transcript.txt               — normalized plain text
 *     provenance.json              — where it came from and when
 *   review/pending/<episodeUuid>.md — approval-gated review candidates
 *   review/pending/digest-<slug>.md — approval-gated cross-episode digests
 *   review/resolved/<episodeUuid>.md — candidates moved out after castrecall_resolve_review
 *
 * Promoted note content itself goes to the user-configured notes
 * destination (CASTRECALL_NOTES_DIR / notesDir), never here.
 *
 * Nothing here is ever written into OpenClaw's durable memory by CastRecall.
 */
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { CastrecallSetupError } from "./config.js";
import { CLEANUP_VERSION, cleanTranscript } from "./transcripts/cleanup.js";
import { normalizeTranscript, } from "./transcripts/normalize.js";
/**
 * Version of the on-disk data-dir contract (provenance.json / state.json
 * shape). Bump only for breaking changes; new fields are additive within a
 * major version — see docs/ARCHITECTURE.md.
 */
export const SCHEMA_VERSION = 1;
/** Capped exponential backoff for the periodic-sync cooldown gate. */
export const BACKOFF_BASE_MS = 5 * 60_000;
export const BACKOFF_CAP_MS = 60 * 60_000;
/**
 * Attempt budget for TRANSIENT transcript failures (retryable STT errors:
 * rate limits, timeouts, upstream 5xx, network rejections). Each attempt can
 * cost real money on a paid STT provider, so after this many consecutive
 * transient failures the episode is marked terminally "failed" instead of
 * being retried by every scheduled run forever.
 */
export const TRANSCRIPT_RETRY_MAX_ATTEMPTS = 5;
/**
 * Capped exponential backoff for polling a transcript that may simply not be
 * published/transcribed YET (Taddy `taddyTranscribeStatus` in progress, or an
 * RSS item with no `<podcast:transcript>` links declared). This is a
 * futile-poll bound, not a billing bound — unlike `TRANSCRIPT_RETRY_MAX_ATTEMPTS`,
 * no paid API call is made on these rungs, so the backoff is measured in hours
 * and the horizon in days rather than attempt count.
 */
export const TRANSCRIPT_RECHECK_BASE_MS = 60 * 60_000;
export const TRANSCRIPT_RECHECK_CAP_MS = 24 * 60 * 60_000;
/** After this long with no transcript appearing, stop polling and mark the episode terminally failed. */
export const TRANSCRIPT_RECHECK_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
/** A lock older than this is presumed abandoned by a crashed run and is reclaimable. */
export const LOCK_TTL_MS = 10 * 60_000;
/**
 * Episodes still missing a stored transcript (transcriptStatus "none"),
 * honoring per-episode retry/recheck backoff: an episode whose last attempt
 * carries a future nextEligibleAt is reported as deferred, not pending, so
 * scheduled runs and the transcription preflight (issue #55) agree on the
 * same worklist a real run would use. Shared by runPipeline and
 * transcriptionPreflight so the preflight's episode count can never drift
 * from what a run would actually attempt.
 */
export function selectPendingTranscripts(episodes, nowMs) {
    const pending = [];
    let deferred = 0;
    for (const episode of episodes) {
        if (episode.transcriptStatus !== "none")
            continue;
        const retryEligibleAt = episode.transcriptRetry
            ? Date.parse(episode.transcriptRetry.nextEligibleAt)
            : Number.NEGATIVE_INFINITY;
        const recheckEligibleAt = episode.transcriptRecheck
            ? Date.parse(episode.transcriptRecheck.nextEligibleAt)
            : Number.NEGATIVE_INFINITY;
        const eligibleAt = Math.max(retryEligibleAt, recheckEligibleAt);
        if (Number.isFinite(eligibleAt) && eligibleAt > nowMs) {
            deferred += 1;
            continue;
        }
        pending.push(episode);
    }
    return { pending, deferred };
}
const EMPTY_STATE = { version: 1, schemaVersion: SCHEMA_VERSION, episodes: {} };
export class Storage {
    dataDir;
    constructor(dataDir) {
        this.dataDir = dataDir;
    }
    get statePath() {
        return path.join(this.dataDir, "state.json");
    }
    sourceDir(episodeUuid) {
        return path.join(this.dataDir, "sources", safeName(episodeUuid));
    }
    reviewPendingDir() {
        return path.join(this.dataDir, "review", "pending");
    }
    reviewResolvedDir() {
        return path.join(this.dataDir, "review", "resolved");
    }
    /** Private, rebuildable search-index cache — see search.ts. */
    indexDir() {
        return path.join(this.dataDir, ".index");
    }
    async init() {
        await fs.mkdir(path.join(this.dataDir, "sources"), { recursive: true });
        await fs.mkdir(this.reviewPendingDir(), { recursive: true });
        await fs.mkdir(this.reviewResolvedDir(), { recursive: true });
    }
    async loadState() {
        try {
            const raw = await fs.readFile(this.statePath, "utf8");
            const parsed = JSON.parse(raw);
            if (parsed.version !== 1 || typeof parsed.episodes !== "object")
                return { ...EMPTY_STATE };
            // schemaVersion/sync are additive: legacy state.json predating them still loads.
            return {
                version: 1,
                lastSyncAt: parsed.lastSyncAt,
                episodes: parsed.episodes,
                schemaVersion: parsed.schemaVersion ?? SCHEMA_VERSION,
                sync: parsed.sync,
            };
        }
        catch {
            return { ...EMPTY_STATE, episodes: {} };
        }
    }
    async saveState(state) {
        await this.init();
        const tmpPath = `${this.statePath}.tmp`;
        const stamped = { ...state, version: 1, schemaVersion: SCHEMA_VERSION };
        await fs.writeFile(tmpPath, `${JSON.stringify(stamped, null, 2)}\n`, "utf8");
        await fs.rename(tmpPath, this.statePath);
    }
    /** Record listens idempotently by episode UUID. Returns only newly seen episodes. */
    async recordListens(episodes, now = () => new Date()) {
        const state = await this.loadState();
        const added = [];
        const timestamp = now().toISOString();
        for (const episode of episodes) {
            if (!episode.uuid || state.episodes[episode.uuid])
                continue;
            const record = {
                uuid: episode.uuid,
                title: episode.title,
                podcastUuid: episode.podcastUuid,
                podcastTitle: episode.podcastTitle,
                audioUrl: episode.url,
                published: episode.published,
                duration: episode.duration,
                playedUpTo: episode.playedUpTo,
                playingStatus: episode.playingStatus,
                author: episode.author,
                firstSeenAt: timestamp,
                transcriptStatus: "none",
                updatedAt: timestamp,
            };
            state.episodes[episode.uuid] = record;
            added.push(record);
        }
        state.lastSyncAt = timestamp;
        await this.saveState(state);
        return { added, totalSeen: Object.keys(state.episodes).length };
    }
    /** Clear backoff state after a successful login + history fetch. */
    async recordSyncSuccess(now = () => new Date()) {
        const state = await this.loadState();
        state.sync = { consecutiveFailures: 0 };
        state.lastSyncAt = now().toISOString();
        await this.saveState(state);
    }
    /**
     * Record a sync failure and compute the next eligible retry time via
     * capped exponential backoff, so a scheduler never hammers the unofficial
     * Pocket Casts API.
     */
    async recordSyncFailure(message, now = () => new Date()) {
        const state = await this.loadState();
        const consecutiveFailures = (state.sync?.consecutiveFailures ?? 0) + 1;
        const delay = Math.min(BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1), BACKOFF_CAP_MS);
        const nowDate = now();
        const sync = {
            consecutiveFailures,
            lastError: message,
            lastErrorAt: nowDate.toISOString(),
            nextEligibleAt: new Date(nowDate.getTime() + delay).toISOString(),
        };
        state.sync = sync;
        await this.saveState(state);
        return sync;
    }
    get lockPath() {
        return path.join(this.dataDir, ".staging", "pipeline.lock");
    }
    /**
     * Exclusive-create a run lock so overlapping scheduler invocations never
     * both hit the unofficial Pocket Casts API concurrently.
     *
     * FAIL-CLOSED DESIGN — there is deliberately NO automatic stale-lock
     * reclaim. Plain POSIX filesystem operations have no compare-and-swap, so
     * every check-then-steal scheme has a stall window in which a delayed
     * reclaimer can evict a fresh holder's live lock (proven repeatedly in
     * review). Instead:
     *   - the scheduled path only ever exclusive-creates (`wx`) and touches
     *     its OWN lock — it can never delete or replace anyone else's;
     *   - a live holder renews the lock's mtime on a heartbeat, so a lock
     *     whose mtime is older than `LOCK_TTL_MS` can only belong to a
     *     hard-killed run (SIGKILL/power loss — normal errors release in
     *     `finally`);
     *   - such a stale lock is REPORTED (`staleLockAgeMs`) and recovery is an
     *     explicit, human-triggered `breakStaleLock` — never scheduled.
     */
    async acquirePipelineLock(now = () => new Date()) {
        await fs.mkdir(path.join(this.dataDir, ".staging"), { recursive: true });
        // Distinguish recovery blockage explicitly: an orphaned recovery mutex
        // (hard-killed recovery) must be diagnosable, not a generic "locked".
        if (await this.recoveryMutexExists()) {
            return { acquired: false, recoveryBlocked: true };
        }
        const token = randomUUID();
        if (await this.tryAcquireExclusive(token, now)) {
            return { acquired: true, token };
        }
        if (await this.recoveryMutexExists()) {
            return { acquired: false, recoveryBlocked: true };
        }
        let mtimeMs;
        try {
            mtimeMs = (await fs.stat(this.lockPath)).mtimeMs;
        }
        catch {
            // Lock vanished between the failed exclusive create and the stat (the
            // holder released). One more exclusive attempt, then back off.
            if (await this.tryAcquireExclusive(token, now)) {
                return { acquired: true, token };
            }
            return { acquired: false };
        }
        const age = now().getTime() - mtimeMs;
        if (age > LOCK_TTL_MS) {
            return { acquired: false, staleLockAgeMs: age };
        }
        return { acquired: false };
    }
    /**
     * Exclusive acquisition that PARTICIPATES in the recovery mutex: it fails
     * closed while a recovery is in progress, and re-checks after creating —
     * an acquirer that raced past the pre-check while the mutex was being
     * created releases its own lock and backs off. This closes the window
     * where a recovery that already re-verified a stale lock could otherwise
     * remove a fresh lock created by a scheduled tick in that gap: no
     * scheduled acquirer can ever HOLD a lock while the mutex exists.
     */
    async tryAcquireExclusive(token, now) {
        if (await this.recoveryMutexExists())
            return false;
        if (!(await this.createLockExclusive(token, now)))
            return false;
        if (await this.recoveryMutexExists()) {
            await this.releasePipelineLock(token);
            return false;
        }
        return true;
    }
    async recoveryMutexExists() {
        try {
            await fs.stat(this.recoveryMutexPath);
            return true;
        }
        catch {
            return false;
        }
    }
    get recoveryMutexPath() {
        return `${this.lockPath}.recovery`;
    }
    /**
     * Explicit recovery from a crashed run's leftover lock. Serialized behind
     * an UNSTEALABLE recovery mutex (exclusive-create, no TTL, no takeover):
     * two concurrent recoveries cannot both proceed, so the re-checked stale
     * lock cannot be swapped for a fresh one between the check and the
     * removal. A crashed recovery leaves the mutex behind and every later
     * recovery fails closed with the manual remediation — by design, the
     * failure mode is "a human removes one file", never "two runs proceed".
     * Throws CastrecallSetupError when recovery is blocked; must never be
     * called from a scheduler.
     */
    async breakStaleLock(now = () => new Date()) {
        await fs.mkdir(path.join(this.dataDir, ".staging"), { recursive: true });
        try {
            await fs.writeFile(this.recoveryMutexPath, new Date().toISOString(), {
                encoding: "utf8",
                flag: "wx",
            });
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
            throw new CastrecallSetupError(`Stale-lock recovery is blocked: ${this.recoveryMutexPath} exists, which means another ` +
                "recovery is in progress or a previous recovery was hard-killed. After confirming no " +
                "recovery is running, remove that file manually and retry.");
        }
        try {
            // Scheduled acquirers fail closed while the mutex exists AND self-release
            // if they raced past the pre-check (see tryAcquireExclusive), so from
            // here on no scheduled tick can hold a lock: what we re-verify below is
            // what we remove.
            try {
                const age = now().getTime() - (await fs.stat(this.lockPath)).mtimeMs;
                if (age <= LOCK_TTL_MS)
                    return { acquired: false }; // live again — refuse
                await fs.rm(this.lockPath, { force: true });
            }
            catch {
                // Lock already gone — fall through to the exclusive create.
            }
            // Direct exclusive create (NOT acquirePipelineLock — that would fail
            // closed on our own mutex). A raced create losing here is a clean back-off.
            const token = randomUUID();
            if (await this.createLockExclusive(token, now)) {
                return { acquired: true, token };
            }
            return { acquired: false };
        }
        finally {
            await fs.rm(this.recoveryMutexPath, { force: true });
        }
    }
    /**
     * Read-only lock health for status surfaces: whether a run lock exists,
     * its age, and whether it reads as stale (heartbeat stopped > LOCK_TTL_MS
     * ago — a hard-killed run).
     */
    async inspectPipelineLock(now = () => new Date()) {
        const recovery = (await this.recoveryMutexExists())
            ? { recoveryMutex: { path: this.recoveryMutexPath } }
            : {};
        try {
            const ageMs = now().getTime() - (await fs.stat(this.lockPath)).mtimeMs;
            return { held: true, ageMs, stale: ageMs > LOCK_TTL_MS, ...recovery };
        }
        catch {
            return { held: false, ...recovery };
        }
    }
    /**
     * Exclusive-create the lock file and stamp its mtime from the caller's
     * clock (mtime is the staleness authority; the payload is informational).
     */
    async createLockExclusive(token, now) {
        const payload = { token, acquiredAt: now().toISOString() };
        try {
            await fs.writeFile(this.lockPath, JSON.stringify(payload), { encoding: "utf8", flag: "wx" });
        }
        catch (error) {
            if (error.code === "EEXIST")
                return false;
            throw error;
        }
        await fs.utimes(this.lockPath, now(), now()).catch(() => { });
        return true;
    }
    /**
     * Renew a held lock so a still-running pipeline invocation (e.g. a slow
     * local-Whisper transcription well past `LOCK_TTL_MS`) is never reclaimed
     * as abandoned. Renewal is a pure token-verified TOUCH (utimes) — it never
     * writes or renames the lock file. That makes it safe under any
     * interleaving with stale reclaim: if this holder already lost the lock,
     * the token check fails and it stops renewing; in the worst case a renewal
     * that races a reclaim touches the NEW holder's live lock, which merely
     * refreshes an already-live lock and can never produce two holders.
     */
    async renewPipelineLock(token, now = () => new Date()) {
        let raw;
        try {
            raw = await fs.readFile(this.lockPath, "utf8");
        }
        catch (error) {
            // File gone = the lock was released or explicitly broken: definitive.
            // Any other read failure is a transient filesystem problem — the caller
            // must NOT treat it as loss (that would strand a lock we still own).
            return error.code === "ENOENT" ? "lost" : "transient-error";
        }
        let parsedToken;
        try {
            parsedToken = JSON.parse(raw).token;
        }
        catch {
            return "transient-error";
        }
        if (parsedToken !== token)
            return "lost";
        try {
            await fs.utimes(this.lockPath, now(), now());
            return "renewed";
        }
        catch {
            return "transient-error";
        }
    }
    /** Release a held lock — only if `token` still matches the current holder. */
    async releasePipelineLock(token) {
        try {
            const existing = JSON.parse(await fs.readFile(this.lockPath, "utf8"));
            if (existing.token !== token)
                return;
            await fs.rm(this.lockPath, { force: true });
        }
        catch {
            // Lock already gone — nothing to do.
        }
    }
    async updateEpisode(episodeUuid, patch, now = () => new Date()) {
        const state = await this.loadState();
        const existing = state.episodes[episodeUuid];
        if (!existing)
            return undefined;
        // uuid/podcastUuid are stable identifiers: re-pin them post-merge so even
        // an `as any` smuggle can't mutate them.
        const updated = {
            ...existing,
            ...patch,
            uuid: existing.uuid,
            podcastUuid: existing.podcastUuid,
            updatedAt: now().toISOString(),
        };
        state.episodes[episodeUuid] = updated;
        await this.saveState(state);
        return updated;
    }
    async hasTranscript(episodeUuid) {
        try {
            await fs.access(path.join(this.sourceDir(episodeUuid), "transcript.txt"));
            return true;
        }
        catch {
            return false;
        }
    }
    async readTranscript(episodeUuid) {
        try {
            return await fs.readFile(path.join(this.sourceDir(episodeUuid), "transcript.txt"), "utf8");
        }
        catch {
            return undefined;
        }
    }
    async readProvenance(episodeUuid) {
        try {
            const raw = await fs.readFile(path.join(this.sourceDir(episodeUuid), "provenance.json"), "utf8");
            // Tolerant cast: sidecars written before schemaVersion/contentHash
            // existed may lack them; no downstream reader depends on their presence.
            return JSON.parse(raw);
        }
        catch {
            return undefined;
        }
    }
    /**
     * Read the optional `segments.json` sidecar (issue #43). Additive: episodes
     * stored before this sidecar existed, or stored from a source with no
     * segment timing (e.g. plain text), simply have no file — this returns
     * `undefined` rather than throwing, same tolerance as `readProvenance`.
     */
    async readSegments(episodeUuid) {
        try {
            const raw = await fs.readFile(path.join(this.sourceDir(episodeUuid), "segments.json"), "utf8");
            return JSON.parse(raw);
        }
        catch {
            return undefined;
        }
    }
    /**
     * Recover segment timing for a transcript stored before the `segments.json`
     * sidecar existed (issue #43), by re-normalizing the still-present
     * `raw.<ext>` artifact — never by re-fetching. Only trusted when the
     * freshly normalized text matches `expectedText` exactly, OR the stored
     * provenance proves the cleanup pass (issue #45) ran and applying it to
     * that normalized text matches — so a raw file that has merely drifted
     * into cleanup-equivalence, without cleanup ever having run, can never
     * contaminate export with mismatched timing. Returns `undefined` when
     * there is no raw artifact, its format is unrecognized, it fails to
     * parse, or neither form matches.
     */
    async deriveSegmentsFromRaw(episodeUuid, expectedText) {
        const provenance = await this.readProvenance(episodeUuid);
        const format = provenance?.format;
        if (!format || !isTranscriptFormat(format))
            return undefined;
        let raw;
        try {
            raw = await fs.readFile(path.join(this.sourceDir(episodeUuid), `raw.${format}`), "utf8");
        }
        catch {
            return undefined;
        }
        let normalized;
        try {
            normalized = normalizeTranscript(raw, format);
        }
        catch {
            return undefined;
        }
        const cleanupRan = provenance?.cleanup?.version === CLEANUP_VERSION;
        const matches = normalized.text === expectedText ||
            (cleanupRan && cleanTranscript(normalized.text).text === expectedText);
        if (!matches)
            return undefined;
        return normalized.segments?.length ? normalized.segments : undefined;
    }
    /**
     * Store a transcript with its provenance sidecar. Idempotent: if a
     * transcript already exists for the episode, nothing is overwritten — the
     * content hash is computed once, at first write, and is stable thereafter.
     *
     * Atomic across concurrent same-episode stores: the artifact triad is
     * assembled in a private staging directory and published with a single
     * `rename`, which POSIX guarantees fails (ENOTEMPTY/EEXIST) rather than
     * merges when the destination is already a populated directory. So a
     * racing writer can never land only some of its files — either its whole
     * staged set becomes `dir`, or none of it does and it falls back to
     * `alreadyStored`.
     */
    async storeTranscript(episodeUuid, artifact) {
        const dir = this.sourceDir(episodeUuid);
        const rawPath = path.join(dir, `raw.${artifact.ext.replace(/^\./, "")}`);
        const textPath = path.join(dir, "transcript.txt");
        const provenancePath = path.join(dir, "provenance.json");
        const segmentsPath = path.join(dir, "segments.json");
        if (await this.hasTranscript(episodeUuid)) {
            // alreadyStored means nothing from THIS call was written — reflect what
            // actually landed on disk from the original store, not this call's
            // (possibly different) artifact.segments.
            const segmentsOnDisk = await fs
                .access(segmentsPath)
                .then(() => true)
                .catch(() => false);
            return {
                rawPath,
                textPath,
                provenancePath,
                segmentsPath: segmentsOnDisk ? segmentsPath : undefined,
                alreadyStored: true,
            };
        }
        const contentHash = createHash("sha256").update(artifact.text, "utf8").digest("hex");
        const provenance = {
            ...artifact.provenance,
            schemaVersion: SCHEMA_VERSION,
            contentHash,
        };
        // Stage under the reserved `.staging/` namespace — never inside `sources/`,
        // which is a public contract surface: downstream scans must never see
        // half-written entries there.
        const stagingDir = path.join(this.dataDir, ".staging", `${safeName(episodeUuid)}-${randomUUID()}`);
        await fs.mkdir(stagingDir, { recursive: true });
        await fs.mkdir(path.dirname(dir), { recursive: true });
        const hasSegments = (artifact.segments?.length ?? 0) > 0;
        try {
            await fs.writeFile(path.join(stagingDir, path.basename(rawPath)), artifact.raw, "utf8");
            await fs.writeFile(path.join(stagingDir, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
            await fs.writeFile(path.join(stagingDir, "transcript.txt"), artifact.text, "utf8");
            // Additive sidecar (issue #43): written only when segments are present,
            // so it lands atomically with the triad via the single rename below, or
            // not at all — never as a partial/orphaned write.
            if (hasSegments) {
                await fs.writeFile(path.join(stagingDir, "segments.json"), `${JSON.stringify(artifact.segments, null, 2)}\n`, "utf8");
            }
            await fs.rename(stagingDir, dir);
            return {
                rawPath,
                textPath,
                provenancePath,
                segmentsPath: hasSegments ? segmentsPath : undefined,
                alreadyStored: false,
            };
        }
        catch (error) {
            await fs.rm(stagingDir, { recursive: true, force: true });
            const code = error.code;
            if (code === "ENOTEMPTY" || code === "EEXIST") {
                if (await this.hasTranscript(episodeUuid)) {
                    const segmentsOnDisk = await fs
                        .access(segmentsPath)
                        .then(() => true)
                        .catch(() => false);
                    return {
                        rawPath,
                        textPath,
                        provenancePath,
                        segmentsPath: segmentsOnDisk ? segmentsPath : undefined,
                        alreadyStored: true,
                    };
                }
                throw new Error(`Refusing to report alreadyStored for episode ${episodeUuid}: ` +
                    `${dir} exists but is missing transcript.txt. This is likely a partial ` +
                    `directory left behind by an older writer — inspect and repair or remove ` +
                    `it manually before retrying.`);
            }
            throw error;
        }
    }
    reviewCandidatePath(episodeUuid) {
        return path.join(this.reviewPendingDir(), `${safeName(episodeUuid)}.md`);
    }
    /** Write a review candidate once; never overwrite a pending review. */
    async writeReviewCandidate(episodeUuid, markdown) {
        await this.init();
        const filePath = this.reviewCandidatePath(episodeUuid);
        try {
            await fs.writeFile(filePath, markdown, { encoding: "utf8", flag: "wx" });
            return { path: filePath, alreadyExists: false };
        }
        catch (error) {
            if (error.code === "EEXIST") {
                return { path: filePath, alreadyExists: true };
            }
            throw error;
        }
    }
    resolvedCandidatePath(episodeUuid) {
        return path.join(this.reviewResolvedDir(), `${safeName(episodeUuid)}.md`);
    }
    async hasPendingReview(episodeUuid) {
        try {
            await fs.access(this.reviewCandidatePath(episodeUuid));
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * Move a pending review candidate into review/resolved/. Returns
     * `moved: false` (instead of throwing) when there is nothing pending for
     * this episode — either it was never generated, or a prior resolve
     * already moved it — so the caller can surface an actionable error rather
     * than silently no-op. Uses link+unlink rather than rename so an existing
     * resolved candidate at the destination is never silently clobbered —
     * `fs.rename` would replace it outright; `alreadyResolved: true` lets the
     * caller surface that conflict instead.
     */
    async resolvePendingReview(episodeUuid) {
        await this.init();
        const resolvedPath = this.resolvedCandidatePath(episodeUuid);
        const pendingPath = this.reviewCandidatePath(episodeUuid);
        try {
            await fs.link(pendingPath, resolvedPath);
        }
        catch (error) {
            if (error.code === "EEXIST") {
                return { moved: false, resolvedPath, alreadyResolved: true };
            }
            if (error.code === "ENOENT") {
                return { moved: false, resolvedPath, alreadyResolved: false };
            }
            throw error;
        }
        try {
            await fs.unlink(pendingPath);
        }
        catch (unlinkError) {
            // ENOENT means someone else already removed the pending entry after
            // our link succeeded — the move is effectively complete (the resolved
            // link is the surviving review copy), so compensating here would
            // delete the only remaining copy and leave nothing to retry from.
            if (unlinkError.code === "ENOENT") {
                return { moved: true, resolvedPath, alreadyResolved: false };
            }
            // Any other failure leaves a genuinely half-done move: the resolved
            // link already exists, so every retry would hit EEXIST →
            // alreadyResolved while no disposition was ever recorded — a stranded
            // candidate. Removing the resolved link restores the pre-call state
            // so a retry can run the whole move again.
            try {
                await fs.unlink(resolvedPath);
            }
            catch (cleanupError) {
                throw new Error(`Failed to unlink pending review candidate (${String(unlinkError)}) AND failed to ` +
                    `clean up the half-created resolved copy at ${resolvedPath} (${String(cleanupError)}). ` +
                    "Remove the resolved copy manually, then retry the disposition.");
            }
            throw unlinkError;
        }
        return { moved: true, resolvedPath, alreadyResolved: false };
    }
    /**
     * Undo a successful `resolvePendingReview` move — used only when the
     * follow-up state write (updateEpisode) fails after the move succeeded, so
     * a retry lands on the same pending-review path instead of a candidate
     * that is resolved-on-disk but has no recorded disposition.
     */
    async revertResolvedReview(episodeUuid) {
        const resolvedPath = this.resolvedCandidatePath(episodeUuid);
        const pendingPath = this.reviewCandidatePath(episodeUuid);
        await fs.link(resolvedPath, pendingPath);
        await fs.unlink(resolvedPath);
    }
    /**
     * Write a promoted note once; never overwrite an existing note at the same
     * path. Creates `notesDir` on demand — same create-on-demand precedent as
     * `CorpusExporter.exportEpisode` — so a configured-but-not-yet-existing
     * destination is a normal write, not a failure.
     */
    async writePromotedNote(notesDir, filename, markdown) {
        await fs.mkdir(notesDir, { recursive: true });
        const filePath = path.join(notesDir, filename);
        try {
            await fs.writeFile(filePath, markdown, { encoding: "utf8", flag: "wx" });
            return { path: filePath, alreadyExists: false };
        }
        catch (error) {
            if (error.code === "EEXIST") {
                return { path: filePath, alreadyExists: true };
            }
            throw error;
        }
    }
    /** Remove a written promoted note — used to clean up an orphan when the caller loses a resolve race. */
    async deletePromotedNote(filePath) {
        await fs.rm(filePath, { force: true });
    }
    digestPath(slug) {
        return path.join(this.reviewPendingDir(), `digest-${safeName(slug)}.md`);
    }
    /** Write a digest once; never overwrite a pending digest — same write-once semantics as writeReviewCandidate. */
    async writeDigest(slug, markdown) {
        await this.init();
        const filePath = this.digestPath(slug);
        try {
            await fs.writeFile(filePath, markdown, { encoding: "utf8", flag: "wx" });
            return { path: filePath, alreadyExists: false };
        }
        catch (error) {
            if (error.code === "EEXIST") {
                return { path: filePath, alreadyExists: true };
            }
            throw error;
        }
    }
    async listPendingReviews() {
        try {
            const entries = await fs.readdir(this.reviewPendingDir());
            return entries.filter((name) => name.endsWith(".md")).sort();
        }
        catch {
            return [];
        }
    }
}
function safeName(value) {
    return value.replace(/[^A-Za-z0-9._-]/g, "_");
}
const TRANSCRIPT_FORMATS = new Set(["txt", "html", "vtt", "srt", "json"]);
function isTranscriptFormat(value) {
    return TRANSCRIPT_FORMATS.has(value);
}
