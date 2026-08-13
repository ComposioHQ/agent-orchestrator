import type {
  GitHubInstallation,
  GitHubRepository,
  GitHubUserConnection,
  OrganizationInvitation,
  OrganizationMember,
  RedactedProviderConnection,
} from "@aoagents/cloud-client";

export type GitHubCapabilityStatus =
  | "loading"
  | "available"
  | "auth-required"
  | "unavailable"
  | "error";

export type GitHubCapability = {
  status: GitHubCapabilityStatus;
  installations: GitHubInstallation[];
  repositories: GitHubRepository[];
  message?: string;
};

export const initialGitHubCapability: GitHubCapability = {
  status: "loading",
  installations: [],
  repositories: [],
};

export type GitHubUserCapability = {
  status: "loading" | "available" | "auth-required" | "error";
  connection: GitHubUserConnection;
  message?: string;
};

export const initialGitHubUserCapability: GitHubUserCapability = {
  status: "loading",
  connection: {
    connected: false,
    installations: [],
  },
};

export type ProviderCapability = {
  status: "loading" | "available" | "error";
  connections: RedactedProviderConnection[];
  message?: string;
};

export const initialProviderCapability: ProviderCapability = {
  status: "loading",
  connections: [],
};

export type MembersCapability = {
  status: "loading" | "available" | "error";
  members: OrganizationMember[];
  invitations: OrganizationInvitation[];
  message?: string;
};

export const initialMembersCapability: MembersCapability = {
  status: "loading",
  members: [],
  invitations: [],
};
