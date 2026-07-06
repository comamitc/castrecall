/**
 * Transcript format detection and normalization to plain text.
 * Supported: plain text, HTML, WebVTT, SRT, and podcast-namespace JSON.
 */
export type TranscriptFormat = "txt" | "html" | "vtt" | "srt" | "json";
export type TranscriptSegment = {
    start?: string;
    end?: string;
    /** Parsed `start`, in seconds, when the raw timecode/value was parseable — see `timecodeToSeconds`. */
    startSeconds?: number;
    /** Parsed `end`, in seconds, when the raw timecode/value was parseable — see `timecodeToSeconds`. */
    endSeconds?: number;
    speaker?: string;
    text: string;
};
export type NormalizedTranscript = {
    format: TranscriptFormat;
    text: string;
    segments?: TranscriptSegment[];
};
/** Best-effort format detection from MIME type, URL extension, then content sniffing. */
export declare function detectFormat(options: {
    contentType?: string;
    url?: string;
    body: string;
}): TranscriptFormat;
/**
 * Parse a VTT/SRT-style timecode (`HH:MM:SS.mmm`, `MM:SS.mmm`, or bare
 * `SS.mmm`; comma or dot decimal separator) into seconds. Only the leading
 * whitespace-delimited token is parsed, so trailing SRT cue settings/position
 * coordinates (e.g. `00:00:02,000 X1:40 X2:600`) are ignored rather than
 * corrupting the result. Returns `undefined` for unparseable input.
 */
export declare function timecodeToSeconds(value: string): number | undefined;
export declare function normalizeTranscript(body: string, format: TranscriptFormat): NormalizedTranscript;
export declare function htmlToText(html: string): string;
/**
 * Join segments into readable text, labeling speaker turns and
 * deduplicating rolling-caption repeats (common in VTT). The single internal
 * segment-to-text formatter — any source that produces `TranscriptSegment[]`
 * (VTT/SRT/JSON here, diarized STT providers in stt.ts) derives its plain
 * text through this same function, so speaker-turn formatting never diverges
 * across sources.
 */
export declare function segmentsToText(segments: TranscriptSegment[]): string;
/** Exported so `cleanup.ts` can reuse the exact same whitespace rules for its final re-collapse pass. */
export declare function collapseWhitespace(text: string): string;
