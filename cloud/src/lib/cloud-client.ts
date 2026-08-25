"use client";

import {
  CloudApiError,
  createCloudClient,
  type GitHubInstallation,
  type OrganizationMembership,
  type PutAgentProviderConnectionInput,
  type RedactedProviderConnection,
  type Session,
} from "@aoagents/cloud-client";
import type {
  CreateInvitationInput,
  OrganizationInvitation,
  OrganizationMember,
  ProjectShareLink,
  SharedProject,
} from "@/app/app/share-types";

type ShareClient = {
  wakePausedSessions: (orgId: string) => Promise<{ woken: number }>;
  claimGitHubInstallation: (
    orgId: string,
    githubInstallationId: string,
  ) => Promise<{ installation: GitHubInstallation }>;
  listProjectShareLinks: (orgId: string, projectId: string) => Promise<ProjectShareLink[]>;
  createProjectShareLink: (
    orgId: string,
    projectId: string,
    input: Record<string, unknown>,
  ) => Promise<{ link: ProjectShareLink }>;
  listProjectShareGrants: (orgId: string, projectId: string) => Promise<SharedProject[]>;
  revokeProjectShareLink: (orgId: string, projectId: string, linkId: string) => Promise<void>;
  revokeProjectShareGrant: (orgId: string, projectId: string, grantId: string) => Promise<void>;
  updateProjectShareGrant: (
    orgId: string,
    projectId: string,
    grantId: string,
    input: { role: "viewer" | "editor"; modeCap: "read-only" | "standard" | "trusted"; sessionId: string },
  ) => Promise<{ grant: SharedProject }>;
  redeemProjectShareLink: (input: { orgId: string; token: string }) => Promise<{ shared: SharedProject }>;
  listSharedProjects: () => Promise<SharedProject[]>;
  listSharedProjectSessions: (orgId: string, projectId: string) => Promise<Session[]>;
  listUserProviderConnections: () => Promise<RedactedProviderConnection[]>;
  putUserProviderConnection: (
    provider: "claude-code" | "codex" | "cursor",
    input: PutAgentProviderConnectionInput,
  ) => Promise<{ providerConnection: RedactedProviderConnection }>;
  deleteUserProviderConnection: (provider: "claude-code" | "codex" | "cursor") => Promise<void>;
  promoteProviderConnection: (
    orgId: string,
    provider: "claude-code" | "codex" | "cursor",
  ) => Promise<{ providerConnection: RedactedProviderConnection }>;
  listOrgMembers: (orgId: string) => Promise<OrganizationMember[]>;
  listOrgInvitations: (orgId: string) => Promise<OrganizationInvitation[]>;
  listMyInvitations: () => Promise<OrganizationInvitation[]>;
  createOrgInvitation: (
    orgId: string,
    input: CreateInvitationInput,
  ) => Promise<{ invitation: OrganizationInvitation }>;
  revokeOrgInvitation: (orgId: string, invitationId: string) => Promise<void>;
  createOrganization: (input: { displayName: string }) => Promise<{ organization: OrganizationMembership }>;
  updateOrgMemberRole: (
    orgId: string,
    userId: string,
    role: "owner" | "admin" | "member",
  ) => Promise<{ member: OrganizationMember }>;
};

export type CloudSessionEvent = {
  sessionId: string;
  sequence: number;
  type: string;
  payload: unknown;
  createdAt: string;
};

type SessionEventSubscription = {
  orgId: string;
  sessionId: string;
  after?: number;
  onEvent: (event: CloudSessionEvent) => void;
  onError?: (error: Error) => void;
};

// SSE cannot attach the same-origin session sentinel through EventSource. Keep
// this small fetch-based reader at the client boundary so the Next gateway can
// continue to exchange it for the HttpOnly session server-side.
export function subscribeBrowserSessionEvents({
  orgId,
  sessionId,
  after = 0,
  onEvent,
  onError,
}: SessionEventSubscription): () => void {
  let stopped = false;
  let controller: AbortController | null = null;
  let retryTimer: number | null = null;
  let cursor = after;

  const scheduleRetry = (delay: number) => {
    if (stopped) return;
    retryTimer = window.setTimeout(() => void connect(), delay);
  };

  const handleBlock = (block: string) => {
    const lines = block.split("\n");
    let eventType = "message";
    let id = "";
    const data: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) eventType = line.slice("event:".length).trim();
      if (line.startsWith("id:")) id = line.slice("id:".length).trim();
      if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
    }
    if (data.length === 0) return;
    try {
      const parsed = JSON.parse(data.join("\n")) as Partial<CloudSessionEvent>;
      const sequence = Number(parsed.sequence ?? id);
      if (!Number.isFinite(sequence) || sequence <= cursor) return;
      cursor = sequence;
      onEvent({
        sessionId: parsed.sessionId ?? sessionId,
        sequence,
        type: parsed.type ?? eventType,
        payload: parsed.payload ?? {},
        createdAt: parsed.createdAt ?? new Date().toISOString(),
      });
    } catch {
      // A malformed event must not make the browser discard the established stream.
    }
  };

  async function connect() {
    controller = new AbortController();
    try {
      const response = await fetch(
        `/api/cloud/v1/orgs/${encodeURIComponent(orgId)}/sessions/${encodeURIComponent(sessionId)}/events?after=${cursor}`,
        {
          headers: {
            Accept: "text/event-stream",
            Authorization: "Bearer same-origin-session",
            "Cache-Control": "no-cache",
          },
          signal: controller.signal,
        },
      );
      if (!response.ok || !response.body) {
        throw new Error(`Session event stream failed (${response.status}).`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!stopped) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? "";
        for (const block of blocks) handleBlock(block.replace(/\r/g, ""));
        if (done) break;
      }
      if (!stopped) scheduleRetry(250);
    } catch (cause) {
      if (!stopped && !(cause instanceof DOMException && cause.name === "AbortError")) {
        onError?.(cause instanceof Error ? cause : new Error("Session event stream failed."));
        scheduleRetry(1_000);
      }
    }
  }

  void connect();
  return () => {
    stopped = true;
    controller?.abort();
    if (retryTimer !== null) window.clearTimeout(retryTimer);
  };
}

export function browserCloudClient() {
  const baseUrl = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  const client = createCloudClient({
    baseUrl,
    // The same-origin Next.js gateway replaces this sentinel with the
    // HttpOnly local session or the server-side WorkOS access token.
    getAccessToken: () => "same-origin-session",
  });
  const request = async <T>(path: string, init: RequestInit = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: "Bearer same-origin-session",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string; code?: string; message?: string; requestId?: string } | null;
      throw new CloudApiError(response.status, {
        error: body?.error ?? response.statusText,
        code: body?.code ?? "CLOUD_REQUEST_FAILED",
        message: body?.message ?? "Cloud request failed.",
        requestId: body?.requestId ?? "",
      });
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  };
  const orgPath = (orgId: string, suffix: string) =>
    `/api/cloud/v1/orgs/${encodeURIComponent(orgId)}${suffix}`;
  return Object.assign(client, {
    wakePausedSessions: (orgId: string) =>
      request<{ woken: number }>(orgPath(orgId, "/sessions/wake"), {
        method: "POST",
      }),
    claimGitHubInstallation: (orgId: string, githubInstallationId: string) =>
      request<{ installation: GitHubInstallation }>(
        orgPath(orgId, "/github/installations/claim"),
        {
          method: "POST",
          body: JSON.stringify({ githubInstallationId }),
        },
      ),
    listProjectShareLinks: async (orgId: string, projectId: string) => {
      const response = await request<{ links: ProjectShareLink[] }>(
        orgPath(orgId, `/projects/${encodeURIComponent(projectId)}/shares`),
      );
      return response.links;
    },
    createProjectShareLink: (orgId: string, projectId: string, input: Record<string, unknown>) =>
      request<{ link: ProjectShareLink }>(
        orgPath(orgId, `/projects/${encodeURIComponent(projectId)}/shares`),
        { method: "POST", body: JSON.stringify(input) },
      ),
    listProjectShareGrants: async (orgId: string, projectId: string) => {
      const response = await request<{ grants: SharedProject[] }>(
        orgPath(orgId, `/projects/${encodeURIComponent(projectId)}/shares/grants`),
      );
      return response.grants;
    },
    revokeProjectShareLink: (orgId: string, projectId: string, linkId: string) =>
      request<void>(orgPath(orgId, `/projects/${encodeURIComponent(projectId)}/shares/${encodeURIComponent(linkId)}/revoke`), { method: "POST" }),
    revokeProjectShareGrant: (orgId: string, projectId: string, grantId: string) =>
      request<void>(orgPath(orgId, `/projects/${encodeURIComponent(projectId)}/shares/grants/${encodeURIComponent(grantId)}/revoke`), { method: "POST" }),
    updateProjectShareGrant: (orgId, projectId, grantId, input) =>
      request<{ grant: SharedProject }>(
        orgPath(orgId, `/projects/${encodeURIComponent(projectId)}/shares/grants/${encodeURIComponent(grantId)}`),
        { method: "PATCH", body: JSON.stringify(input) },
      ),
    redeemProjectShareLink: (input: { orgId: string; token: string }) =>
      request<{ shared: SharedProject }>("/api/cloud/v1/share-links/redeem", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    listSharedProjects: async () => {
      const response = await request<{ shared: SharedProject[] }>("/api/cloud/v1/shared/projects");
      return response.shared;
    },
    listSharedProjectSessions: async (orgId: string, projectId: string) => {
      const response = await request<{ sessions: Session[] }>(
        orgPath(orgId, `/shared/projects/${encodeURIComponent(projectId)}/sessions`),
      );
      return response.sessions;
    },
    listUserProviderConnections: async () => {
      const response = await request<{ providerConnections: RedactedProviderConnection[] }>(
        "/api/cloud/v1/me/providers",
      );
      return response.providerConnections;
    },
    putUserProviderConnection: (
      provider: "claude-code" | "codex" | "cursor",
      input: PutAgentProviderConnectionInput,
    ) => request<{ providerConnection: RedactedProviderConnection }>(
      `/api/cloud/v1/me/providers/${encodeURIComponent(provider)}`,
      { method: "PUT", body: JSON.stringify(input) },
    ),
    deleteUserProviderConnection: (provider: "claude-code" | "codex" | "cursor") =>
      request<void>(`/api/cloud/v1/me/providers/${encodeURIComponent(provider)}`, { method: "DELETE" }),
    promoteProviderConnection: (
      orgId: string,
      provider: "claude-code" | "codex" | "cursor",
    ) => request<{ providerConnection: RedactedProviderConnection }>(
      orgPath(orgId, `/provider-connections/agents/${encodeURIComponent(provider)}/promote`),
      { method: "POST" },
    ),
    listOrgMembers: async (orgId: string) => {
      const response = await request<{ members: OrganizationMember[] }>(orgPath(orgId, "/members"));
      return response.members;
    },
    listOrgInvitations: async (orgId: string) => {
      const response = await request<{ invitations: OrganizationInvitation[] }>(orgPath(orgId, "/invitations"));
      return response.invitations;
    },
    listMyInvitations: async () => {
      const response = await request<{ invitations: OrganizationInvitation[] }>("/api/cloud/v1/invitations");
      return response.invitations;
    },
    createOrgInvitation: (orgId: string, input: CreateInvitationInput) =>
      request<{ invitation: OrganizationInvitation }>(orgPath(orgId, "/invitations"), {
        method: "POST",
        body: JSON.stringify(input),
      }),
    revokeOrgInvitation: (orgId: string, invitationId: string) =>
      request<void>(orgPath(orgId, `/invitations/${encodeURIComponent(invitationId)}/revoke`), { method: "POST" }),
    createOrganization: (input: { displayName: string }) =>
      request<{ organization: OrganizationMembership }>("/api/cloud/v1/orgs", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    updateOrgMemberRole: (
      orgId: string,
      userId: string,
      role: "owner" | "admin" | "member",
    ) => request<{ member: OrganizationMember }>(
      orgPath(orgId, `/members/${encodeURIComponent(userId)}`),
      { method: "PATCH", body: JSON.stringify({ role }) },
    ),
  } satisfies ShareClient);
}

export function browserCloudApiBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_AO_CLOUD_WEB_API_BASE_URL?.trim();
  if (configured) return new URL(configured).origin;
  if (typeof window === "undefined") return "http://127.0.0.1:8081";

  const { hostname, origin } = window.location;
  if (hostname === "cloud.aoagents.dev") return "https://api.aoagents.dev";
  if (
    hostname === "staging-cloud.aoagents.dev" ||
    hostname.startsWith("staging.")
  ) {
    return "https://staging-api.aoagents.dev";
  }
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return "http://127.0.0.1:8081";
  }
  return origin;
}

export function browserTerminalUrl(
  ticket: string,
  after = 0,
  kind: "agent" | "workspace" = "workspace",
): string {
  const url = new URL("/api/cloud/v1/terminal", browserCloudApiBaseUrl());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  url.searchParams.set("after", String(after));
  url.searchParams.set("kind", kind);
  url.searchParams.set("protocol", "2");
  return url.toString();
}

export function newIdempotencyKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

const PENDING_SHARE_STORAGE_KEY = "ao-pending-share-redemption";

export function savePendingShareRedemption(orgId: string, token: string) {
  window.sessionStorage.setItem(
    PENDING_SHARE_STORAGE_KEY,
    JSON.stringify({ orgId, token }),
  );
}

export function consumePendingShareRedemption(): {
  orgId: string;
  token: string;
} | null {
  const raw = window.sessionStorage.getItem(PENDING_SHARE_STORAGE_KEY);
  if (!raw) return null;
  window.sessionStorage.removeItem(PENDING_SHARE_STORAGE_KEY);
  try {
    const parsed = JSON.parse(raw) as { orgId?: unknown; token?: unknown };
    if (typeof parsed.orgId !== "string" || typeof parsed.token !== "string") {
      return null;
    }
    return { orgId: parsed.orgId, token: parsed.token };
  } catch {
    return null;
  }
}
