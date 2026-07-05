import { describe, expect, it } from "vitest";
import { isListenedEpisode, type ListenFilterConfig } from "./listened.js";

const filter: ListenFilterConfig = { minRatio: 0.8, minSeconds: 300, recordUnknown: false };

describe("isListenedEpisode", () => {
  it("accepts a completed episode (playingStatus 3) regardless of duration/playedUpTo", () => {
    expect(isListenedEpisode({ playingStatus: 3 }, filter)).toBe(true);
    expect(isListenedEpisode({ playingStatus: 3, duration: 0, playedUpTo: 0 }, filter)).toBe(true);
  });

  it("accepts a high-ratio partial listen and rejects a low-ratio one", () => {
    expect(isListenedEpisode({ duration: 100, playedUpTo: 85 }, filter)).toBe(true);
    expect(isListenedEpisode({ duration: 100, playedUpTo: 50 }, filter)).toBe(false);
  });

  it("accepts exactly at the ratio boundary", () => {
    expect(isListenedEpisode({ duration: 100, playedUpTo: 80 }, filter)).toBe(true);
  });

  it("does not let the seconds floor rescue a long episode's ratio miss", () => {
    expect(isListenedEpisode({ duration: 7200, playedUpTo: 400 }, filter)).toBe(false);
  });

  it("falls back to the seconds floor when duration is missing", () => {
    expect(isListenedEpisode({ playedUpTo: 350 }, filter)).toBe(true);
    expect(isListenedEpisode({ playedUpTo: 100 }, filter)).toBe(false);
  });

  it("treats a zero or non-finite duration as unusable rather than taking the ratio path", () => {
    expect(isListenedEpisode({ duration: 0, playedUpTo: 50 }, filter)).toBe(false);
    expect(isListenedEpisode({ duration: Number.NaN, playedUpTo: 50 }, filter)).toBe(false);
  });

  it("treats a negative duration as unusable, falling back to the seconds floor", () => {
    expect(isListenedEpisode({ duration: -1, playedUpTo: 350 }, filter)).toBe(true);
    expect(isListenedEpisode({ duration: -1, playedUpTo: -1 }, filter)).toBe(false);
  });

  it("treats a negative playedUpTo as unusable against a known duration", () => {
    expect(isListenedEpisode({ duration: 100, playedUpTo: -5 }, filter)).toBe(false);
  });

  it("skips when both duration and playingStatus are missing, unless recordUnknown", () => {
    expect(isListenedEpisode({}, filter)).toBe(false);
    expect(isListenedEpisode({}, { ...filter, recordUnknown: true })).toBe(true);
  });
});
