import type {
  GitHubInstallation,
  GitHubRepository,
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

export type ProviderCapability = {
  status: "loading" | "available" | "error";
  connections: RedactedProviderConnection[];
  message?: string;
};

export const initialProviderCapability: ProviderCapability = {
  status: "loading",
  connections: [],
};
