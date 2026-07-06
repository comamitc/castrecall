/**
 * Review candidate generation.
 *
 * CastRecall never promotes transcripts into durable memory itself. Instead it
 * writes a pending review document per episode: listen metadata, provenance,
 * and heuristic excerpt candidates. A human (or a human-approved agent flow)
 * decides what — if anything — graduates into curated memory.
 */
import { isLocalWhisperGeneration } from "./storage.js";
const MAX_EXCERPTS = 5;
const MAX_EXCERPT_CHARS = 600;
const MIN_EXCERPT_CHARS = 120;
export function buildReviewCandidate(options) {
    const { record, provenance, transcriptText, transcriptPath, generatedAt } = options;
    const excerpts = pickExcerpts(transcriptText);
    const wordCount = transcriptText.split(/\s+/).filter(Boolean).length;
    const gen = provenance.generation;
    const localGen = isLocalWhisperGeneration(gen) ? gen : undefined;
    const remoteGen = gen?.kind === "remote-stt" ? gen : undefined;
    // Stored provenance predating newer generation fields (or written by a
    // different build) may lack decode.applied, outputFormat, or
    // wordTimestamps. Normalize before rendering so review generation never
    // crashes on — or prints literal "undefined" for — an older shape.
    const decodeApplied = localGen?.decode?.applied ?? {};
    const decodeIgnored = localGen?.decode?.ignored ?? [];
    const lines = [
        "---",
        "status: pending-review",
        "privacy: private-source",
        `episode_uuid: ${record.uuid}`,
        `podcast: ${yamlString(record.podcastTitle)}`,
        `episode: ${yamlString(record.title)}`,
        `listened: ${record.firstSeenAt}`,
        `transcript_source: ${provenance.transcriptSource}`,
        `transcript_format: ${provenance.format}`,
        provenance.provider ? `transcript_provider: ${provenance.provider}` : undefined,
        localGen ? `transcript_backend: ${localGen.backend}` : undefined,
        localGen?.model ? `transcript_model: ${yamlString(localGen.model)}` : undefined,
        localGen ? `transcript_model_source: ${localGen.modelSource}` : undefined,
        localGen?.preset ? `transcript_preset: ${yamlString(localGen.preset)}` : undefined,
        localGen?.outputFormat ? `transcript_output_format: ${localGen.outputFormat}` : undefined,
        localGen && localGen.wordTimestamps !== undefined
            ? `transcript_word_timestamps: ${localGen.wordTimestamps}`
            : undefined,
        Object.keys(decodeApplied).length > 0
            ? `transcript_decode_options: ${yamlString(JSON.stringify(decodeApplied))}`
            : undefined,
        decodeIgnored.length > 0
            ? `transcript_decode_ignored: ${yamlString(JSON.stringify(decodeIgnored.map((entry) => entry.option)))}`
            : undefined,
        localGen?.toolVersion ? `transcript_tool_version: ${yamlString(localGen.toolVersion)}` : undefined,
        remoteGen?.implementation ? `transcript_implementation: ${yamlString(remoteGen.implementation)}` : undefined,
        remoteGen?.model ? `transcript_model: ${yamlString(remoteGen.model)}` : undefined,
        remoteGen ? `transcript_remote_host: ${yamlString(remoteGen.baseUrlHost)}` : undefined,
        `generated_at: ${generatedAt.toISOString()}`,
        "---",
        "",
        `# Review: ${record.title}`,
        "",
        `From **${record.podcastTitle}**${record.author ? ` by ${record.author}` : ""}.`,
        "",
        "> This is a review candidate generated from a privately stored transcript.",
        "> Nothing below is in durable memory. Promote only what is worth keeping,",
        "> in your own words where possible, and discard the rest.",
        "",
        "## Provenance",
        "",
        `- Platform: Pocket Casts (listen history)`,
        provenance.feedUrl ? `- Feed: ${reviewUrl(provenance.feedUrl)}` : undefined,
        provenance.episodeUrl ? `- Episode page: ${reviewUrl(provenance.episodeUrl)}` : undefined,
        provenance.audioUrl ? `- Audio: ${reviewUrl(provenance.audioUrl)}` : undefined,
        `- Transcript: ${provenance.transcriptSource}${provenance.transcriptSourceUrl ? ` (${reviewUrl(provenance.transcriptSourceUrl)})` : ""}`,
        localGen
            ? `- Generation: ${localGen.backend}${localGen.model ? `:${localGen.model}` : ""} (${localGen.modelSource}${localGen.usesBackendDefault ? ", backend default — check corpus quality" : ""})${decodeIgnored.length > 0 ? `; dropped decode options: ${decodeIgnored.map((entry) => entry.option).join(", ")}` : ""}`
            : undefined,
        remoteGen
            ? `- Generation: remote-stt${remoteGen.implementation ? ` (${remoteGen.implementation})` : ""}${remoteGen.model ? `:${remoteGen.model}` : ""} via ${remoteGen.baseUrlHost}`
            : undefined,
        `- Fetched: ${provenance.fetchedAt}`,
        `- Full transcript (${wordCount.toLocaleString()} words): ${transcriptPath}`,
        "",
        "## Excerpt candidates",
        "",
        excerpts.length > 0
            ? excerpts.map((excerpt, i) => `${i + 1}. ${excerpt}`).join("\n\n")
            : "_Transcript too short or unstructured for automatic excerpts; read the full transcript above._",
        "",
        "## Reviewer notes",
        "",
        "- [ ] Worth keeping? What is the one durable idea?",
        "- [ ] Anything here change what I'm working on or thinking about?",
        "",
    ];
    return `${lines.filter((line) => line !== undefined).join("\n")}\n`;
}
/**
 * Render a human-chosen promotion into a frontmattered note for the
 * configured notes destination. The body is exactly the human's `content` —
 * no heuristic excerpts, no full transcript — but attribution (podcast,
 * episode, listen date, transcript source, episode UUID) travels with it so
 * a promoted note is still traceable back to its source.
 */
export function buildPromotedNote(options) {
    const { record, provenance, content, title, resolvedAt } = options;
    const heading = title?.trim() || record.title;
    const lines = [
        "---",
        `podcast: ${yamlString(record.podcastTitle)}`,
        `episode: ${yamlString(record.title)}`,
        `listened: ${record.firstSeenAt}`,
        `transcript_source: ${provenance.transcriptSource}`,
        provenance.provider ? `transcript_provider: ${provenance.provider}` : undefined,
        `episode_uuid: ${record.uuid}`,
        "promoted_from: castrecall",
        `resolved_at: ${resolvedAt.toISOString()}`,
        "---",
        "",
        `# ${heading}`,
        "",
        content,
        "",
    ];
    return `${lines.filter((line) => line !== undefined).join("\n")}\n`;
}
/**
 * Heuristic excerpt selection: split into paragraph-ish chunks, keep the
 * most substantial ones in original order. Deliberately simple and honest —
 * semantic summarization belongs to the reviewing agent/human, not this plugin.
 */
export function pickExcerpts(text) {
    const paragraphs = text
        .split(/\n{2,}|\n(?=[A-Z][\w .'-]{0,40}: )/)
        .map((p) => p.replace(/\s+/g, " ").trim())
        .filter((p) => p.length >= MIN_EXCERPT_CHARS);
    const chunks = paragraphs.length > 0 ? paragraphs : sentenceChunks(text);
    const ranked = chunks
        .map((chunk, index) => ({ chunk, index, score: chunk.length }))
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_EXCERPTS)
        .sort((a, b) => a.index - b.index);
    return ranked.map(({ chunk }) => chunk.length > MAX_EXCERPT_CHARS ? `${chunk.slice(0, MAX_EXCERPT_CHARS).trimEnd()}…` : chunk);
}
function sentenceChunks(text) {
    const sentences = text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/);
    const chunks = [];
    let current = "";
    for (const sentence of sentences) {
        current = current ? `${current} ${sentence}` : sentence;
        if (current.length >= MIN_EXCERPT_CHARS * 2) {
            chunks.push(current);
            current = "";
        }
    }
    if (current.length >= MIN_EXCERPT_CHARS)
        chunks.push(current);
    return chunks;
}
export function yamlString(value) {
    return JSON.stringify(value);
}
function reviewUrl(value) {
    try {
        const url = new URL(value);
        const hadPrivateParts = url.search.length > 0 || url.hash.length > 0;
        url.search = "";
        url.hash = "";
        return hadPrivateParts
            ? `${url.toString()} (query removed; full URL is in provenance.json)`
            : url.toString();
    }
    catch {
        return value;
    }
}
