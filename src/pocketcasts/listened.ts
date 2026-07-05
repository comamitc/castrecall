/**
 * Filter for "meaningfully listened" episodes, applied to Pocket Casts
 * history before it is recorded into CastRecall state — see
 * castrecall_sync_history and issue #24. This never runs against already
 * stored episodes/transcripts; it only gates new ingestion.
 */

import type { PocketCastsEpisode } from "./client.js";

export type ListenFilterConfig = {
  /** Minimum playedUpTo/duration ratio to accept a partial listen (default 0.8). */
  minRatio: number;
  /** Minimum playedUpTo seconds to accept a short/no-duration listen (default 300). */
  minSeconds: number;
  /** Accept episodes with no usable duration/playedUpTo/playingStatus at all (default false). */
  recordUnknown: boolean;
};

function usableNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Duration is the authority when present: a long episode with a low ratio is
 * never rescued by the seconds floor. The seconds floor only applies when
 * duration is missing or unusable (zero, negative, non-finite).
 */
export function isListenedEpisode(
  episode: Pick<PocketCastsEpisode, "duration" | "playedUpTo" | "playingStatus">,
  filter: ListenFilterConfig,
): boolean {
  if (episode.playingStatus === 3) return true;

  const hasDuration = usableNumber(episode.duration) && episode.duration > 0;
  if (hasDuration) {
    const playedUpTo = usableNumber(episode.playedUpTo) ? episode.playedUpTo : 0;
    return playedUpTo / (episode.duration as number) >= filter.minRatio;
  }

  if (usableNumber(episode.playedUpTo)) {
    return episode.playedUpTo >= filter.minSeconds;
  }

  return filter.recordUnknown;
}
