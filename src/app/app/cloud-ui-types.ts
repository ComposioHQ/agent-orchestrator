import type {
  GitHubInstallation,
  GitHubRepository,
} from "@aoagents/cloud-client";

export type GitHubCapabilityStatus =
  | "loading"
  | "available"
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
