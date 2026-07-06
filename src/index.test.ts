import { describe, expect, it } from "vitest";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";

describe("castrecall plugin entry", () => {
  const metadata = getToolPluginMetadata(entry);

  it("declares the ten v0 tools", () => {
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
});
