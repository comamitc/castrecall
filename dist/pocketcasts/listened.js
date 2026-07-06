/**
 * Filter for "meaningfully listened" episodes, applied to Pocket Casts
 * history before it is recorded into CastRecall state — see
 * castrecall_sync_history and issue #24. This never runs against already
 * stored episodes/transcripts; it only gates new ingestion.
 */
function usableNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
/**
 * Duration is the authority when present: a long episode with a low ratio is
 * never rescued by the seconds floor. The seconds floor only applies when
 * duration is missing or unusable (zero, negative, non-finite).
 */
export function isListenedEpisode(episode, filter) {
    if (episode.playingStatus === 3)
        return true;
    const hasDuration = usableNumber(episode.duration) && episode.duration > 0;
    if (hasDuration) {
        const playedUpTo = usableNumber(episode.playedUpTo) ? episode.playedUpTo : 0;
        return playedUpTo / episode.duration >= filter.minRatio;
    }
    if (usableNumber(episode.playedUpTo)) {
        return episode.playedUpTo >= filter.minSeconds;
    }
    // A known, non-completed playingStatus (1 or 2) is a real signal that the
    // episode wasn't finished — recordUnknown is only for truly unknown metadata.
    if (usableNumber(episode.playingStatus))
        return false;
    return filter.recordUnknown;
}
