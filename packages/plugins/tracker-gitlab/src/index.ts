import type { PluginModule, Tracker } from "@composio/ao-core";
import { createGitLabTracker } from "./adapter.js";
export { handleWebhook } from "./webhookHandler.js";
export type { GitLabWebhookEvent } from "./webhookHandler.js";

export const manifest = {
    name: "gitlab",
    slot: "tracker" as const,
    description: "Tracker plugin: GitLab Issues",
    version: "0.1.0",
};

export function create(config?: Record<string, unknown>): Tracker {
    return createGitLabTracker(config as any);
}

export default { manifest, create } satisfies PluginModule<Tracker>;