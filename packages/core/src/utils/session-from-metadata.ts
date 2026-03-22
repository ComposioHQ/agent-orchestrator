import type { RuntimeHandle, Session, SessionId, SessionStatus } from "../types.js";
import { parsePrFromUrl } from "./pr.js";
import { safeJsonParse, validateStatus } from "./validation.js";

interface SessionFromMetadataOptions {
  projectId?: string;
  status?: SessionStatus;
  activity?: Session["activity"];
  runtimeHandle?: RuntimeHandle | null;
  createdAt?: Date;
  lastActivityAt?: Date;
  restoredAt?: Date;
}

export function sessionFromMetadata(
  sessionId: SessionId,
  meta: Record<string, string>,
  options: SessionFromMetadataOptions = {},
): Session {
  return {
    id: sessionId,
    projectId: meta["project"] ?? options.projectId ?? "",
    status: options.status ?? validateStatus(meta["status"]),
    activity: options.activity ?? null,
    branch: meta["branch"] || null,
    issueId: meta["issue"] || null,
    pr: meta["pr"]
      ? (() => {
          const parsed = parsePrFromUrl(meta["pr"]);
          return {
            number: parsed?.number ?? 0,
            url: meta["pr"],
            title: "",
            owner: parsed?.owner ?? "",
            repo: parsed?.repo ?? "",
            branch: meta["branch"] ?? "",
            baseBranch: "",
            isDraft: false,
          };
        })()
      : null,
    workspacePath: meta["worktree"] || null,
    runtimeHandle:
      options.runtimeHandle !== undefined
        ? options.runtimeHandle
        : meta["runtimeHandle"]
          ? safeJsonParse<RuntimeHandle>(meta["runtimeHandle"])
          : null,
    agentInfo: meta["summary"] ? { summary: meta["summary"], agentSessionId: null } : null,
    createdAt: meta["createdAt"] ? new Date(meta["createdAt"]) : (options.createdAt ?? new Date()),
    lastActivityAt: options.lastActivityAt ?? new Date(),
    restoredAt:
      options.restoredAt ?? (meta["restoredAt"] ? new Date(meta["restoredAt"]) : undefined),
    metadata: meta,
  };
}
