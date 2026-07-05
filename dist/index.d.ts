/**
 * CastRecall — turn podcast listening into retrievable memory.
 *
 * OpenClaw tool plugin. v0 is read-only against Pocket Casts: it syncs listen
 * history, fetches or generates transcripts via a cost-aware ladder, stores
 * them as private provenance-bearing source material, and produces
 * approval-gated review candidates. It never mutates playback state and never
 * writes to durable OpenClaw memory.
 */
declare const _default: import("openclaw/plugin-sdk/tool-plugin").DefinedToolPluginEntry;
export default _default;
