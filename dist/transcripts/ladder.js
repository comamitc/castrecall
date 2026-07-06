/**
 * The transcript ladder, cheapest and most-open first:
 *   1. RSS `<podcast:transcript>` links (open standard, free)
 *   2. Taddy API (optional, needs TADDY_API_KEY + TADDY_USER_ID)
 *   3. Podchaser API (optional, needs PODCHASER_API_KEY)
 *   4. Local Whisper (free and private; auto-detected CLI, skipped when absent)
 *   5. Cloud speech-to-text (optional, costs money, must be explicitly enabled)
 *
 * Each rung reports why it was skipped or failed so the outcome is explainable.
 */
import { CastrecallSetupError } from "../config.js";
import { resolveFeedItem, resolveFeedUrl } from "../resolver.js";
import { fetchRssTranscript } from "./rss.js";
import { fetchTaddyTranscript, taddyConfigured } from "./taddy.js";
import { fetchPodchaserTranscript, podchaserConfigured } from "./podchaser.js";
import { detectLocalWhisper, transcribeWithLocalWhisper } from "./local-whisper.js";
import { RetryableSttError, sttAvailability, transcribeAudio } from "./stt.js";
export async function runTranscriptLadder(config, record, options = {}) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const env = options.env ?? process.env;
    const rungs = [];
    let feedItem;
    let feedUrl;
    // Rung 1: RSS <podcast:transcript>
    try {
        feedUrl = await resolveFeedUrl(record.podcastUuid, record.podcastTitle, fetchImpl);
        if (!feedUrl) {
            rungs.push({
                rung: "rss",
                outcome: "failed",
                detail: "Could not resolve the podcast's RSS feed URL (Pocket Casts feed export and iTunes search both missed).",
            });
        }
        else {
            feedItem = await resolveFeedItem(feedUrl, { title: record.title, url: record.audioUrl, uuid: record.uuid }, fetchImpl).catch((error) => {
                rungs.push({ rung: "rss", outcome: "failed", detail: describeError(error) });
                return undefined;
            });
            if (feedItem) {
                if (feedItem.transcripts.length === 0) {
                    rungs.push({
                        rung: "rss",
                        outcome: "miss",
                        detail: `Feed item found in ${feedUrl} but it declares no <podcast:transcript> links.`,
                        recheckable: true,
                    });
                }
                else {
                    const fetched = await fetchRssTranscript(feedItem.transcripts, fetchImpl);
                    if (fetched) {
                        rungs.push({
                            rung: "rss",
                            outcome: "hit",
                            detail: `Transcript fetched from ${fetched.sourceUrl}.`,
                        });
                        return {
                            transcript: {
                                source: "rss",
                                format: fetched.format,
                                raw: fetched.raw,
                                text: fetched.text,
                                sourceUrl: fetched.sourceUrl,
                            },
                            feedItem,
                            rungs,
                        };
                    }
                    rungs.push({
                        rung: "rss",
                        outcome: "miss",
                        detail: "Declared transcript links produced no usable text.",
                    });
                }
            }
            else if (!rungs.some((r) => r.rung === "rss")) {
                rungs.push({
                    rung: "rss",
                    outcome: "miss",
                    detail: `Feed fetched from ${feedUrl} but no item matched the episode (by enclosure URL, GUID, or title).`,
                });
            }
        }
    }
    catch (error) {
        rungs.push({ rung: "rss", outcome: "failed", detail: describeError(error) });
    }
    // Rung 2: Taddy
    if (!taddyConfigured(config)) {
        rungs.push({
            rung: "taddy",
            outcome: "skipped",
            detail: "Taddy not configured (set TADDY_API_KEY and TADDY_USER_ID to enable this rung; " +
                "free signup at https://taddy.org/developers, transcripts need a paid plan).",
        });
    }
    else {
        try {
            const taddy = await fetchTaddyTranscript(config, { guid: feedItem?.itemGuid, title: record.title }, fetchImpl);
            if (taddy.status === "hit") {
                rungs.push({ rung: "taddy", outcome: "hit", detail: "Transcript returned by Taddy." });
                return {
                    transcript: {
                        source: "taddy",
                        format: "txt",
                        raw: taddy.transcript.text,
                        text: taddy.transcript.text,
                        provider: "taddy",
                    },
                    feedItem,
                    rungs,
                };
            }
            if (taddy.status === "pending") {
                rungs.push({
                    rung: "taddy",
                    outcome: "miss",
                    detail: "Taddy is transcribing this episode but the transcript isn't ready yet.",
                    recheckable: true,
                });
            }
            else {
                rungs.push({
                    rung: "taddy",
                    outcome: "miss",
                    detail: "Taddy has no transcript for this episode (or the plan does not include transcripts).",
                });
            }
        }
        catch (error) {
            rungs.push({ rung: "taddy", outcome: "failed", detail: describeError(error) });
        }
    }
    // Rung 3: Podchaser
    if (!podchaserConfigured(config)) {
        rungs.push({
            rung: "podchaser",
            outcome: "skipped",
            detail: "Podchaser not configured (set PODCHASER_API_KEY to enable this rung; a bearer access " +
                "token minted via Podchaser's requestAccessToken mutation — " +
                "see https://api-docs.podchaser.com/docs/authorization/).",
        });
    }
    else {
        try {
            const podchaser = await fetchPodchaserTranscript(config, {
                guid: feedItem?.itemGuid,
                title: record.title,
                feedUrl,
                podcastTitle: record.podcastTitle,
            }, fetchImpl);
            if (podchaser) {
                rungs.push({ rung: "podchaser", outcome: "hit", detail: "Transcript returned by Podchaser." });
                return {
                    transcript: {
                        source: "podchaser",
                        format: "txt",
                        raw: podchaser.text,
                        text: podchaser.text,
                        sourceUrl: podchaser.sourceUrl,
                        provider: "podchaser",
                    },
                    feedItem,
                    rungs,
                };
            }
            rungs.push({
                rung: "podchaser",
                outcome: "miss",
                detail: "Podchaser has no usable transcript for this episode.",
            });
        }
        catch (error) {
            rungs.push({ rung: "podchaser", outcome: "failed", detail: describeError(error) });
        }
    }
    // Rung 4: local Whisper (free, private; used whenever a CLI is detected)
    const whisper = await detectLocalWhisper(config, env);
    if (!whisper.detected) {
        rungs.push({ rung: "local-whisper", outcome: "skipped", detail: whisper.reason });
    }
    else {
        try {
            const result = await transcribeWithLocalWhisper(config, record.audioUrl, { fetchImpl, env });
            rungs.push({
                rung: "local-whisper",
                outcome: "hit",
                detail: `Audio transcribed locally with ${result.provider}.`,
            });
            return {
                transcript: {
                    source: "local-whisper",
                    format: "txt",
                    raw: result.text,
                    text: result.text,
                    provider: result.provider,
                },
                feedItem,
                rungs,
            };
        }
        catch (error) {
            rungs.push({ rung: "local-whisper", outcome: "failed", detail: describeError(error) });
        }
    }
    // Rung 5: cloud speech-to-text (explicitly enabled only — costs money)
    const stt = sttAvailability(config);
    if (options.skipStt) {
        rungs.push({
            rung: "stt",
            outcome: "skipped",
            detail: "STT retry budget exhausted for this episode; run castrecall_fetch_transcript manually to retry billing.",
        });
    }
    else if (!stt.ok) {
        rungs.push({ rung: "stt", outcome: "skipped", detail: stt.reason ?? "STT unavailable." });
    }
    else {
        try {
            const result = await transcribeAudio(config, record.audioUrl, fetchImpl);
            rungs.push({
                rung: "stt",
                outcome: "hit",
                detail: `Audio transcribed with ${result.provider}.`,
            });
            return {
                transcript: {
                    source: "stt",
                    format: "txt",
                    raw: result.text,
                    text: result.text,
                    provider: result.model ? `${result.provider}:${result.model}` : result.provider,
                },
                feedItem,
                rungs,
            };
        }
        catch (error) {
            rungs.push({
                rung: "stt",
                outcome: "failed",
                detail: describeError(error),
                retryable: error instanceof RetryableSttError,
            });
        }
    }
    return { feedItem, rungs };
}
function describeError(error) {
    if (error instanceof CastrecallSetupError)
        return error.message;
    if (error instanceof Error)
        return error.message;
    return String(error);
}
