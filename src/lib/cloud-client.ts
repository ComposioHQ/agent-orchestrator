"use client";

import {
  CloudApiError,
  createCloudClient,
  type PutAgentProviderConnectionInput,
  type RedactedProviderConnection,
  type Session,
  type OrganizationMembership,
} from "@aoagents/cloud-client";
import type {
  CreateInvitationInput,
  OrganizationInvitation,
  OrganizationMember,
  ProjectShareLink,
  SharedProject,
} from "@/app/app/share-types";

type ShareClient = {
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
