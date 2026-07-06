import { describe, expect, it } from "vitest";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";

describe("castrecall plugin entry", () => {
  const metadata = getToolPluginMetadata(entry);

  it("declares the eleven v0 tools", () => {
    expect(metadata?.tools.map((tool) => tool.name)).toEqual([
      "castrecall_setup_status",
      "castrecall_setup",
      "castrecall_sync_history",
      "castrecall_recent",
      "castrecall_fetch_transcript",
      "castrecall_generate_review",
      "castrecall_resolve_review",
      "castrecall_search",
      "castrecall_digest",
      "castrecall_transcription_preflight",
      "castrecall_run_pipeline",
    ]);
  });

  it("exposes no playback mutation tools", () => {
    const names = metadata?.tools.map((tool) => tool.name) ?? [];
    for (const name of names) {
      expect(name).not.toMatch(/play|pause|seek|star|archive|update/);
    }
  });

  it("uses the lowercase plugin id", () => {
    expect(metadata?.id).toBe("castrecall");
    expect(metadata?.name).toBe("CastRecall");
  });

  it("accepts remote-stt in the sttProvider config enum (issue #61 review)", () => {
    // The manifest is generated from this schema: remote-stt must live in
    // the SOURCE enum, or a manifest regeneration silently drops the value
    // and configured remote-stt installs fail validation.
    const schema = JSON.parse(JSON.stringify(metadata?.configSchema ?? {}));
    const providers = JSON.stringify(schema);
    for (const provider of ["assemblyai", "openai", "deepgram", "remote-stt"]) {
      expect(providers).toContain(provider);
    }
  });
});
