import { describe, expect, it } from "vitest";
import type { PluginModule } from "@composio/ao-core";
import {
  detectAgentRuntime,
  detectAvailableAgents,
} from "../../src/lib/detect-agent.js";

function makePlugin(
  displayName: string,
  detectable: boolean,
): PluginModule {
  return {
    manifest: {
      displayName,
    },
    detect: () => detectable,
  } as PluginModule;
}

describe("detectAvailableAgents", () => {
  it("includes cursor when the plugin is installed and detectable", async () => {
    const loadPlugin = async (pkg: string): Promise<PluginModule | null> => {
      if (pkg === "@composio/ao-plugin-agent-cursor") {
        return makePlugin("Cursor", true);
      }
      return null;
    };

    await expect(detectAvailableAgents(loadPlugin)).resolves.toEqual([
      { name: "cursor", displayName: "Cursor" },
    ]);
  });

  it("skips undetectable and missing plugins", async () => {
    const loadPlugin = async (pkg: string): Promise<PluginModule | null> => {
      if (pkg === "@composio/ao-plugin-agent-cursor") {
        return makePlugin("Cursor", false);
      }
      if (pkg === "@composio/ao-plugin-agent-codex") {
        return makePlugin("OpenAI Codex", true);
      }
      return null;
    };

    await expect(detectAvailableAgents(loadPlugin)).resolves.toEqual([
      { name: "codex", displayName: "OpenAI Codex" },
    ]);
  });
});

describe("detectAgentRuntime", () => {
  it("selects cursor when it is the only available agent", async () => {
    await expect(
      detectAgentRuntime([{ name: "cursor", displayName: "Cursor" }]),
    ).resolves.toBe("cursor");
  });

  it("falls back to claude-code when nothing is detected", async () => {
    await expect(detectAgentRuntime([])).resolves.toBe("claude-code");
  });
});
