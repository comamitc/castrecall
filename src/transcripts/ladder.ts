/**
 * The transcript ladder, cheapest and most-open first:
 *   1. RSS `<podcast:transcript>` links (open standard, free)
 *   2. Taddy API (optional, needs TADDY_API_KEY + TADDY_USER_ID)
 *   3. Local Whisper (free and private; auto-detected CLI, skipped when absent)
 *   4. Cloud speech-to-text (optional, costs money, must be explicitly enabled)
 *
 * Each rung reports why it was skipped or failed so the outcome is explainable.
 */

import { CastrecallSetupError, type ResolvedConfig } from "../config.js";
import type { FetchLike } from "../pocketcasts/client.js";
import { resolveFeedItem, resolveFeedUrl, type ResolvedFeedItem } from "../resolver.js";
import type { ListenRecord } from "../storage.js";
import { fetchRssTranscript } from "./rss.js";
import { fetchTaddyTranscript, taddyConfigured } from "./taddy.js";
import { detectLocalWhisper, transcribeWithLocalWhisper } from "./local-whisper.js";
import { RetryableSttError, sttAvailability, transcribeAudio } from "./stt.js";

export type LadderRung = "rss" | "taddy" | "local-whisper" | "stt";

export type RungOutcome = {
  rung: LadderRung;
  outcome: "hit" | "miss" | "skipped" | "failed";
  detail: string;
  /** Set on a "failed" stt rung when the provider failure is transient (rate limit, timeout, 5xx). */
  retryable?: boolean;
};

export type LadderResult = {
  transcript?: {
    source: LadderRung;
    format: string;
    raw: string;
    text: string;
    sourceUrl?: string;
    provider?: string;
  };
  feedItem?: ResolvedFeedItem;
  rungs: RungOutcome[];
};

export async function runTranscriptLadder(
  config: ResolvedConfig,
  record: ListenRecord,
  options: { fetchImpl?: FetchLike; env?: NodeJS.ProcessEnv } = {},
): Promise<LadderResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const env = options.env ?? process.env;
  const rungs: RungOutcome[] = [];
  let feedItem: ResolvedFeedItem | undefined;

  // Rung 1: RSS <podcast:transcript>
  try {
    const feedUrl = await resolveFeedUrl(record.podcastUuid, record.podcastTitle, fetchImpl);
    if (!feedUrl) {
      rungs.push({
        rung: "rss",
        outcome: "failed",
        detail:
          "Could not resolve the podcast's RSS feed URL (Pocket Casts feed export and iTunes search both missed).",
      });
    } else {
      feedItem = await resolveFeedItem(
        feedUrl,
        { title: record.title, url: record.audioUrl, uuid: record.uuid },
        fetchImpl,
      ).catch((error) => {
        rungs.push({ rung: "rss", outcome: "failed", detail: describeError(error) });
        return undefined;
      });
      if (feedItem) {
        if (feedItem.transcripts.length === 0) {
          rungs.push({
            rung: "rss",
            outcome: "miss",
            detail: `Feed item found in ${feedUrl} but it declares no <podcast:transcript> links.`,
          });
        } else {
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
      } else if (!rungs.some((r) => r.rung === "rss")) {
        rungs.push({
          rung: "rss",
          outcome: "miss",
          detail: `Feed fetched from ${feedUrl} but no item matched the episode (by enclosure URL, GUID, or title).`,
        });
      }
    }
  } catch (error) {
    rungs.push({ rung: "rss", outcome: "failed", detail: describeError(error) });
  }

  // Rung 2: Taddy
  if (!taddyConfigured(config)) {
    rungs.push({
      rung: "taddy",
      outcome: "skipped",
      detail:
        "Taddy not configured (set TADDY_API_KEY and TADDY_USER_ID to enable this rung; " +
        "free signup at https://taddy.org/developers, transcripts need a paid plan).",
    });
  } else {
    try {
      const taddy = await fetchTaddyTranscript(
        config,
        { guid: feedItem?.itemGuid, title: record.title },
        fetchImpl,
      );
      if (taddy) {
        rungs.push({ rung: "taddy", outcome: "hit", detail: "Transcript returned by Taddy." });
        return {
          transcript: {
            source: "taddy",
            format: "txt",
            raw: taddy.text,
            text: taddy.text,
            provider: "taddy",
          },
          feedItem,
          rungs,
        };
      }
      rungs.push({
        rung: "taddy",
        outcome: "miss",
        detail: "Taddy has no transcript for this episode (or the plan does not include transcripts).",
      });
    } catch (error) {
      rungs.push({ rung: "taddy", outcome: "failed", detail: describeError(error) });
    }
  }

  // Rung 3: local Whisper (free, private; used whenever a CLI is detected)
  const whisper = await detectLocalWhisper(config, env);
  if (!whisper.detected) {
    rungs.push({ rung: "local-whisper", outcome: "skipped", detail: whisper.reason });
  } else {
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
    } catch (error) {
      rungs.push({ rung: "local-whisper", outcome: "failed", detail: describeError(error) });
    }
  }

  // Rung 4: cloud speech-to-text (explicitly enabled only — costs money)
  const stt = sttAvailability(config);
  if (!stt.ok) {
    rungs.push({ rung: "stt", outcome: "skipped", detail: stt.reason ?? "STT unavailable." });
  } else {
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
    } catch (error) {
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

function describeError(error: unknown): string {
  if (error instanceof CastrecallSetupError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
