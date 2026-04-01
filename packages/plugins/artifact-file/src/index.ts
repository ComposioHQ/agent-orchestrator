/**
 * File-based artifact plugin — stores artifacts on the local filesystem.
 */

import type { PluginModule, ArtifactService } from "@composio/ao-core";
import { createArtifactService } from "./artifact-service.js";

export const manifest = {
  name: "file",
  slot: "artifact" as const,
  description: "Artifact plugin: file-based artifact storage",
  version: "0.1.0",
};

export function create(config?: Record<string, unknown>): ArtifactService {
  const artifactsDir = (config?.artifactsDir as string) ?? "";
  const sessionsDir = (config?.sessionsDir as string) ?? undefined;

  if (!artifactsDir) {
    // Return a no-op service when no artifacts dir is configured
    // This happens during plugin discovery before a project is loaded
    return createArtifactService({ artifactsDir: "/tmp/ao-artifacts-stub" });
  }

  return createArtifactService({ artifactsDir, sessionsDir });
}

export default { manifest, create } satisfies PluginModule<ArtifactService>;
