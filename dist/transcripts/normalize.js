/**
 * Transcript format detection and normalization to plain text.
 * Supported: plain text, HTML, WebVTT, SRT, and podcast-namespace JSON.
 */
/** Best-effort format detection from MIME type, URL extension, then content sniffing. */
export function detectFormat(options) {
    const type = options.contentType?.toLowerCase().split(";")[0]?.trim() ?? "";
    switch (type) {
        case "text/vtt":
            return "vtt";
        case "application/srt":
        case "application/x-subrip":
        case "text/srt":
            return "srt";
        case "application/json":
            return "json";
        case "text/html":
            return "html";
        case "text/plain":
            break; // plain often mislabels; fall through to sniffing
        default:
            break;
    }
    const ext = options.url?.split("?")[0]?.split(".").pop()?.toLowerCase();
    if (ext === "vtt")
        return "vtt";
    if (ext === "srt")
        return "srt";
    if (ext === "json")
        return "json";
    if (ext === "html" || ext === "htm")
        return "html";
    const body = options.body.trimStart();
    if (body.startsWith("WEBVTT"))
        return "vtt";
    if (/^\d+\s*\r?\n\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->/m.test(body))
        return "srt";
    if (body.startsWith("{") || body.startsWith("["))
        return "json";
    if (body.startsWith("<"))
        return "html";
    return "txt";
}
export function normalizeTranscript(body, format) {
    switch (format) {
        case "vtt":
            return { format, ...parseVtt(body) };
        case "srt":
            return { format, ...parseSrt(body) };
        case "json":
            return { format, ...parseJsonTranscript(body) };
        case "html":
            return { format, text: htmlToText(body) };
        case "txt":
            return { format, text: collapseWhitespace(body) };
    }
}
function parseVtt(body) {
    const segments = [];
    const withoutHeader = body.replace(/\r\n/g, "\n").replace(/^\uFEFF?WEBVTT[^\n]*\n?/i, "");
    const blocks = withoutHeader.split(/\n\n+/);
    for (const block of blocks) {
        const lines = block.split("\n").filter((line) => line.trim().length > 0);
        if (lines.length === 0)
            continue;
        const first = lines[0].trim();
        if (first.startsWith("NOTE") || first.startsWith("STYLE")) {
            continue;
        }
        let index = 0;
        // Optional cue identifier line before the timing line.
        if (!lines[index].includes("-->") && lines[index + 1]?.includes("-->"))
            index += 1;
        const timing = lines[index];
        if (!timing?.includes("-->"))
            continue;
        const [start, end] = timing.split("-->").map((part) => part.trim().split(" ")[0]);
        const textLines = lines.slice(index + 1);
        for (const line of textLines) {
            const { speaker, text } = stripCueTags(line);
            if (text)
                segments.push({ start, end, speaker, text });
        }
    }
    return { text: joinSegments(segments), segments };
}
function parseSrt(body) {
    const segments = [];
    const blocks = body.replace(/\r\n/g, "\n").split(/\n\n+/);
    for (const block of blocks) {
        const lines = block.split("\n").filter((line) => line.trim().length > 0);
        const timingIndex = lines.findIndex((line) => line.includes("-->"));
        if (timingIndex === -1)
            continue;
        const [start, end] = lines[timingIndex].split("-->").map((part) => part.trim());
        const cueLines = lines.slice(timingIndex + 1).map(stripCueTags).filter(({ text }) => text);
        if (cueLines.length === 0)
            continue;
        const speaker = cueLines.find((line) => line.speaker)?.speaker;
        const text = cueLines.map((line) => line.text).join(" ");
        if (text)
            segments.push({ start, end, speaker, text });
    }
    return { text: joinSegments(segments), segments };
}
/**
 * Podcast-namespace JSON transcript:
 * { "segments": [{ "startTime": 0.5, "endTime": 2.0, "speaker": "Host", "body": "..." }] }
 */
function parseJsonTranscript(body) {
    let parsed;
    try {
        parsed = JSON.parse(body);
    }
    catch {
        throw new Error("Transcript declared as JSON could not be parsed.");
    }
    const parsedRecord = typeof parsed === "object" && parsed !== null ? parsed : {};
    const rawSegments = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsedRecord.segments)
            ? parsedRecord.segments
            : Array.isArray(parsedRecord.transcript)
                ? parsedRecord.transcript
                : Array.isArray(parsedRecord.items)
                    ? parsedRecord.items
                    // whisper.cpp's -oj/-ojf JSON output nests entries under "transcription".
                    : Array.isArray(parsedRecord.transcription)
                        ? parsedRecord.transcription
                        : undefined;
    if (!rawSegments) {
        const text = firstString(parsedRecord, ["body", "text", "transcript"]);
        if (text)
            return { text: collapseWhitespace(text), segments: [{ text: collapseWhitespace(text) }] };
        throw new Error("JSON transcript had no usable transcript text or segments.");
    }
    const segments = [];
    for (const raw of rawSegments) {
        if (typeof raw === "string") {
            const text = raw.trim();
            if (text)
                segments.push({ text });
            continue;
        }
        if (typeof raw !== "object" || raw === null)
            continue;
        const record = raw;
        const text = firstString(record, ["body", "text", "line", "caption"]);
        if (!text)
            continue;
        segments.push({
            // whisper.cpp nests timing under "offsets"/"timestamps" instead of flat keys.
            start: firstDefined(record, ["startTime", "start", "startTimecode"]) ??
                nestedTimestamp(record, ["offsets", "timestamps"], "from"),
            end: firstDefined(record, ["endTime", "end", "endTimecode"]) ??
                nestedTimestamp(record, ["offsets", "timestamps"], "to"),
            speaker: firstString(record, ["speaker", "speakerName", "speakerLabel"]),
            text: text.trim(),
        });
    }
    if (segments.length === 0)
        throw new Error("JSON transcript had no usable transcript text.");
    return { text: joinSegments(segments), segments };
}
export function htmlToText(html) {
    const withBreaks = html
        .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ")
        .replace(/<\s*br\s*\/?\s*>/gi, "\n")
        .replace(/<\s*\/\s*(p|div|li|h[1-6]|tr|blockquote)\s*>/gi, "\n")
        .replace(/<[^>]+>/g, " ");
    return collapseWhitespace(decodeEntities(withBreaks));
}
function decodeEntities(text) {
    return text
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
        .replace(/&apos;/gi, "'");
}
/** Strip `<v Speaker>` and formatting tags from a cue line. */
function stripCueTags(line) {
    let speaker;
    const voiceMatch = line.match(/<v(?:\.[^\s>]*)?\s+([^>]+)>/i);
    if (voiceMatch)
        speaker = voiceMatch[1].trim();
    const speakerPrefix = line.match(/^\s*([A-Za-z][\w .'-]{0,40}):\s+(.*)$/);
    let text = line.replace(/<[^>]+>/g, "").trim();
    if (!speaker && speakerPrefix && speakerPrefix[2]) {
        speaker = speakerPrefix[1].trim();
        text = speakerPrefix[2].replace(/<[^>]+>/g, "").trim();
    }
    return { speaker, text };
}
/**
 * Join segments into readable text, labeling speaker turns and
 * deduplicating rolling-caption repeats (common in VTT).
 */
function joinSegments(segments) {
    const parts = [];
    let lastSpeaker;
    let lastText;
    for (const segment of segments) {
        if (segment.text === lastText)
            continue;
        lastText = segment.text;
        if (segment.speaker && segment.speaker !== lastSpeaker) {
            parts.push(`\n${segment.speaker}: ${segment.text}`);
            lastSpeaker = segment.speaker;
        }
        else {
            parts.push(segment.text);
        }
    }
    return collapseWhitespace(parts.join(" "));
}
function collapseWhitespace(text) {
    return text
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((line) => line.replace(/[ \t]+/g, " ").trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
function firstString(record, keys) {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === "string" && value.trim())
            return value.trim();
    }
    return undefined;
}
function firstDefined(record, keys) {
    for (const key of keys) {
        const value = record[key];
        if (value !== undefined && value !== null && value !== "")
            return String(value);
    }
    return undefined;
}
function nestedTimestamp(record, containerKeys, subKey) {
    for (const key of containerKeys) {
        const container = record[key];
        if (container && typeof container === "object") {
            const value = container[subKey];
            if (value !== undefined && value !== null && value !== "")
                return String(value);
        }
    }
    return undefined;
}
