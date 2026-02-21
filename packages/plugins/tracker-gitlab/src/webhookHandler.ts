import crypto from "node:crypto";
import type { ProjectConfig } from "@composio/ao-core";

/**
 * Validate incoming GitLab webhook and normalize to a minimal event shape.
 *
 * Usage:
 *   const ev = handleWebhook(headers, rawBody, config.webhookSecret);
 *   // ev.type, ev.action, ev.issue?.iid, ev.merge_request?.iid, ev.project
 */
export type GitLabWebhookEvent =
    | { type: "issue"; action: string; issue: any; project: any }
    | { type: "merge_request"; action: string; merge_request: any; project: any }
    | { type: "unknown"; payload: any };

export function handleWebhook(
    headers: Record<string, string | undefined>,
    payload: any,
    secret?: string,
): GitLabWebhookEvent {
    const tokenHeader = headers["x-gitlab-token"] ?? headers["X-Gitlab-Token"];

    if (secret) {
        // secret provided → validate header
        if (!tokenHeader) {
            throw new Error("Invalid webhook token");
        }

        // timingSafeEqual accepts only Buffer/TypedArray/DataView and both inputs must be same length.
        const a = Buffer.from(String(tokenHeader), "utf8");
        const b = Buffer.from(String(secret), "utf8");

        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            throw new Error("Invalid webhook token");
        }
    }

    const event = headers["x-gitlab-event"] ?? headers["X-Gitlab-Event"] ?? "";
    if (event === "Issue Hook") {
        return {
            type: "issue",
            action: payload.object_attributes?.action ?? "unknown",
            issue: payload.object_attributes,
            project: payload.project,
        };
    }
    if (event === "Merge Request Hook") {
        return {
            type: "merge_request",
            action: payload.object_attributes?.action ?? "unknown",
            merge_request: payload.object_attributes,
            project: payload.project,
        };
    }

    return { type: "unknown", payload };
}