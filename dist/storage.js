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
 *
 * Nothing here is ever written into OpenClaw's durable memory by CastRecall.
 */
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
/**
 * Version of the on-disk data-dir contract (provenance.json / state.json
 * shape). Bump only for breaking changes; new fields are additive within a
 * major version — see docs/ARCHITECTURE.md.
 */
export const SCHEMA_VERSION = 1;
/** Capped exponential backoff for the periodic-sync cooldown gate. */
export const BACKOFF_BASE_MS = 5 * 60_000;
export const BACKOFF_CAP_MS = 60 * 60_000;
/** A lock older than this is presumed abandoned by a crashed run and is reclaimable. */
export const LOCK_TTL_MS = 10 * 60_000;
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
    async init() {
        await fs.mkdir(path.join(this.dataDir, "sources"), { recursive: true });
        await fs.mkdir(this.reviewPendingDir(), { recursive: true });
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
     * both hit the unofficial Pocket Casts API concurrently. A lock older than
     * `LOCK_TTL_MS` is presumed abandoned by a crashed run and is reclaimed.
     */
    async acquirePipelineLock(now = () => new Date()) {
        await fs.mkdir(path.join(this.dataDir, ".staging"), { recursive: true });
        const token = randomUUID();
        const payload = { token, acquiredAt: now().toISOString() };
        try {
            await fs.writeFile(this.lockPath, JSON.stringify(payload), { encoding: "utf8", flag: "wx" });
            return { acquired: true, token };
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
        }
        // Someone holds the lock — reclaim only if it is stale.
        let existing;
        try {
            existing = JSON.parse(await fs.readFile(this.lockPath, "utf8"));
        }
        catch {
            existing = undefined;
        }
        const age = existing?.acquiredAt ? now().getTime() - new Date(existing.acquiredAt).getTime() : Infinity;
        if (age <= LOCK_TTL_MS)
            return { acquired: false };
        try {
            // Reclaim atomically: rename our fresh lock over the stale one. If a
            // concurrent reclaimer wins this race, `rename` still succeeds (POSIX
            // rename onto an existing file is atomic), so at most one token survives.
            const tmpPath = `${this.lockPath}.${token}.tmp`;
            await fs.writeFile(tmpPath, JSON.stringify(payload), "utf8");
            await fs.rename(tmpPath, this.lockPath);
            return { acquired: true, token };
        }
        catch {
            return { acquired: false };
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
        if (await this.hasTranscript(episodeUuid)) {
            return { rawPath, textPath, provenancePath, alreadyStored: true };
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
        try {
            await fs.writeFile(path.join(stagingDir, path.basename(rawPath)), artifact.raw, "utf8");
            await fs.writeFile(path.join(stagingDir, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
            await fs.writeFile(path.join(stagingDir, "transcript.txt"), artifact.text, "utf8");
            await fs.rename(stagingDir, dir);
            return { rawPath, textPath, provenancePath, alreadyStored: false };
        }
        catch (error) {
            await fs.rm(stagingDir, { recursive: true, force: true });
            const code = error.code;
            if (code === "ENOTEMPTY" || code === "EEXIST") {
                if (await this.hasTranscript(episodeUuid)) {
                    return { rawPath, textPath, provenancePath, alreadyStored: true };
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
