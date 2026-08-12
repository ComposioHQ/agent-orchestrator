"use client";

import {
  CloudApiError,
  createCloudClient,
  type ErrorEnvelope,
  type WorkspaceFile,
} from "@aoagents/cloud-client";

export function browserCloudClient() {
  return createCloudClient({
    baseUrl:
      typeof window === "undefined" ? "http://localhost" : window.location.origin,
    // The same-origin Next.js gateway replaces this sentinel with the
    // HttpOnly local session or the server-side WorkOS access token.
    getAccessToken: () => "same-origin-session",
  });
}

export function newIdempotencyKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

// Workspace writes extend the existing /workspace/file resource with PUT. The
// public client does not expose this compatible method yet, so the web BFF uses
// the same error envelope and cookie-backed transport directly.
export async function writeWorkspaceFile(
  organizationId: string,
  sessionId: string,
  path: string,
  content: string,
  signal?: AbortSignal,
): Promise<WorkspaceFile> {
  const response = await fetch(
    `/api/cloud/v1/orgs/${encodeURIComponent(organizationId)}/sessions/${encodeURIComponent(sessionId)}/workspace/file`,
    {
      method: "PUT",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path, content }),
      signal,
    },
  );
  if (!response.ok) {
    let envelope: ErrorEnvelope;
    try {
      envelope = (await response.json()) as ErrorEnvelope;
    } catch {
      envelope = {
        error: response.statusText || "Request Failed",
        code: "HTTP_ERROR",
        message: `Cloud API request failed with status ${response.status}.`,
        requestId: response.headers.get("x-request-id") ?? "",
      };
    }
    throw new CloudApiError(response.status, envelope);
  }
  return (await response.json()) as WorkspaceFile;
}
