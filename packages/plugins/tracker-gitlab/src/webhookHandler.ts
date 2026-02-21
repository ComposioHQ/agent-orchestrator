import crypto from "node:crypto";
import type { ProjectConfig } from "@composio/ao-core";

export type GitLabWebhookEvent =
    | { type: "issue"; action: string; issue: any; project: any }
    | { type: "merge_request"; action: string; merge_request: any; project: any }
    | { type: "unknown"; payload: any };

/**
 * Validate and normalize a GitLab webhook payload.
 *
 * - If `secret` is provided, perform a timing-safe equality check between
 *   the header and the secret. To avoid leaking the secret length, both
 *   values are hashed with SHA-256 and the fixed-size digests are compared
 *   with crypto.timingSafeEqual.
 */
export function handleWebhook(
    headers: Record<string, string | undefined>,
    payload: any,
    secret?: string,
): GitLabWebhookEvent {
    const tokenHeader = headers["x-gitlab-token"] ?? headers["X-Gitlab-Token"];

    if (secret) {
        // Normalize to strings (use empty string when header missing) so the same
        // operations run regardless of presence of header. This avoids early returns
        // that can leak information via timing.
        const headerStr = String(tokenHeader ?? "");
        const secretStr = String(secret);

        // Hash both values to fixed-length buffers (SHA-256 -> 32 bytes) to prevent
        // length-based timing leaks, then use timingSafeEqual.
        const headerHash = crypto.createHash("sha256").update(headerStr, "utf8").digest();
        const secretHash = crypto.createHash("sha256").update(secretStr, "utf8").digest();

        // timingSafeEqual requires same-length buffers; hashing ensures that.
        let ok = false;
        try {
            ok = crypto.timingSafeEqual(headerHash, secretHash);
        } catch {
            ok = false;
        }

        if (!ok) {
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