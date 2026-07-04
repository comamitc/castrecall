/** Rung 1 of the transcript ladder: `<podcast:transcript>` links from the episode's RSS item. */

import type { FetchLike } from "../pocketcasts/client.js";
import type { TranscriptLink } from "../resolver.js";
import {
  detectFormat,
  normalizeTranscript,
  type NormalizedTranscript,
} from "./normalize.js";

export type FetchedTranscript = NormalizedTranscript & {
  raw: string;
  sourceUrl: string;
  declaredType?: string;
};

/** Prefer machine-friendly formats with timing/speaker data over markup. */
const TYPE_PREFERENCE = [
  "application/json",
  "text/vtt",
  "application/srt",
  "application/x-subrip",
  "text/plain",
  "text/html",
];

export function rankTranscriptLinks(links: TranscriptLink[]): TranscriptLink[] {
  return [...links].sort((a, b) => preferenceIndex(a.type) - preferenceIndex(b.type));
}

function preferenceIndex(type?: string): number {
  const normalized = type?.toLowerCase().split(";")[0]?.trim() ?? "";
  const index = TYPE_PREFERENCE.indexOf(normalized);
  return index === -1 ? TYPE_PREFERENCE.length : index;
}

/** Try each declared transcript link in preference order; return the first that parses. */
export async function fetchRssTranscript(
  links: TranscriptLink[],
  fetchImpl: FetchLike = fetch,
): Promise<FetchedTranscript | undefined> {
  const failures: string[] = [];
  for (const link of rankTranscriptLinks(links)) {
    try {
      const response = await fetchImpl(link.url, {
        headers: { accept: link.type ?? "*/*" },
      });
      if (!response.ok) {
        failures.push(`${link.url}: HTTP ${response.status}`);
        continue;
      }
      const raw = await response.text();
      const format = detectFormat({
        contentType: response.headers.get("content-type") ?? link.type,
        url: link.url,
        body: raw,
      });
      const normalized = normalizeTranscript(raw, format);
      if (!normalized.text) {
        failures.push(`${link.url}: parsed to empty text`);
        continue;
      }
      return { ...normalized, raw, sourceUrl: link.url, declaredType: link.type };
    } catch (error) {
      failures.push(`${link.url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`All RSS transcript links failed: ${failures.join("; ")}`);
  }
  return undefined;
}
