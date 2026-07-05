/**
 * Transcript format detection and normalization to plain text.
 * Supported: plain text, HTML, WebVTT, SRT, and podcast-namespace JSON.
 */
export type TranscriptFormat = "txt" | "html" | "vtt" | "srt" | "json";
export type TranscriptSegment = {
    start?: string;
    end?: string;
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
export declare function normalizeTranscript(body: string, format: TranscriptFormat): NormalizedTranscript;
export declare function htmlToText(html: string): string;
