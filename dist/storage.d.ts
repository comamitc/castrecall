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
import type { PocketCastsEpisode } from "./pocketcasts/client.js";
export type TranscriptStatus = "none" | "stored" | "failed";
export type ListenRecord = {
    uuid: string;
    title: string;
    podcastUuid: string;
    podcastTitle: string;
    audioUrl: string;
    published?: string;
    duration?: number;
    playedUpTo?: number;
    playingStatus?: number;
    author?: string;
    firstSeenAt: string;
    transcriptStatus: TranscriptStatus;
    transcriptSource?: string;
    transcriptError?: string;
    reviewGeneratedAt?: string;
    updatedAt: string;
};
export type CastrecallState = {
    version: 1;
    lastSyncAt?: string;
    episodes: Record<string, ListenRecord>;
};
export type Provenance = {
    platform: "pocketcasts";
    podcastTitle: string;
    episodeTitle: string;
    episodeUuid: string;
    episodeUrl?: string;
    audioUrl?: string;
    feedUrl?: string;
    listenTimestamp?: string;
    transcriptSource: "rss" | "taddy" | "local-whisper" | "stt";
    transcriptSourceUrl?: string;
    format: string;
    provider?: string;
    fetchedAt: string;
    privacyClass: "private-source";
};
export type StoredTranscript = {
    rawPath: string;
    textPath: string;
    provenancePath: string;
    alreadyStored: boolean;
};
export declare class Storage {
    readonly dataDir: string;
    constructor(dataDir: string);
    private get statePath();
    sourceDir(episodeUuid: string): string;
    reviewPendingDir(): string;
    init(): Promise<void>;
    loadState(): Promise<CastrecallState>;
    saveState(state: CastrecallState): Promise<void>;
    /** Record listens idempotently by episode UUID. Returns only newly seen episodes. */
    recordListens(episodes: PocketCastsEpisode[], now?: () => Date): Promise<{
        added: ListenRecord[];
        totalSeen: number;
    }>;
    updateEpisode(episodeUuid: string, patch: Partial<ListenRecord>, now?: () => Date): Promise<ListenRecord | undefined>;
    hasTranscript(episodeUuid: string): Promise<boolean>;
    readTranscript(episodeUuid: string): Promise<string | undefined>;
    readProvenance(episodeUuid: string): Promise<Provenance | undefined>;
    /**
     * Store a transcript with its provenance sidecar. Idempotent: if a
     * transcript already exists for the episode, nothing is overwritten.
     */
    storeTranscript(episodeUuid: string, artifact: {
        raw: string;
        ext: string;
        text: string;
        provenance: Provenance;
    }): Promise<StoredTranscript>;
    reviewCandidatePath(episodeUuid: string): string;
    /** Write a review candidate once; never overwrite a pending review. */
    writeReviewCandidate(episodeUuid: string, markdown: string): Promise<{
        path: string;
        alreadyExists: boolean;
    }>;
    listPendingReviews(): Promise<string[]>;
}
