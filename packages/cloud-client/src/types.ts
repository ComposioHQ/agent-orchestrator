import type { components } from "./schema.js";

type Schemas = components["schemas"];

export type ErrorEnvelope = Schemas["ErrorEnvelope"];
export type APIError = Schemas["APIError"];
export type GoogleIdentityExchange = Schemas["GoogleIdentityExchange"];
export type RefreshTokenInput = Schemas["RefreshTokenInput"];
export type AOSession = Schemas["AOSession"];
export type CurrentUser = Schemas["CurrentUser"];
export type OrganizationMembership = Schemas["OrganizationMembership"];
export type CurrentAccount = Schemas["CurrentAccount"];

// These are the canonical shared /api/v1 DTOs. The Cloud OpenAPI document
// references the generated daemon schemas instead of maintaining App* copies.
export type ProjectSummary = Schemas["ProjectSummary"];
export type ListProjectsResponse = Schemas["ListProjectsResponse"];
export type ProjectGetResponse = Schemas["ProjectGetResponse"];
export type ControllersSessionView = Schemas["ControllersSessionView"];
export type ListSessionsResponse = Schemas["ListSessionsResponse"];
export type SessionResponse = Schemas["SessionResponse"];
export type SpawnSessionRequest = Schemas["SpawnSessionRequest"];
export type SpawnSessionResponse = Schemas["SpawnSessionResponse"];
export type SendSessionMessageRequest = Schemas["SendSessionMessageRequest"];
export type SendSessionMessageResponse = Schemas["SendSessionMessageResponse"];
export type ListSessionPRsResponse = Schemas["ListSessionPRsResponse"];
export type ListReviewsResponse = Schemas["ListReviewsResponse"];
export type ListWorkspaceFilesResponse = Schemas["ListWorkspaceFilesResponse"];
export type WorkspaceFileResponse = Schemas["WorkspaceFileResponse"];

export type CreateWorkspacePlacementInput =
  Schemas["CreateWorkspacePlacementInput"];
export type WorkspacePlacementState = Schemas["WorkspacePlacementState"];
export type WorkspacePlacementOperation =
  Schemas["WorkspacePlacementOperation"];

export type GitHubInstallation = Schemas["GitHubInstallation"];
export type GitHubInstallationStart = Schemas["GitHubInstallationStart"];
export type GitHubRepository = Schemas["GitHubRepository"];
export type GitHubRepositoryAllowlistInput =
  Schemas["GitHubRepositoryAllowlistInput"];

export type TerminalConnectionRequest = Schemas["TerminalConnectionRequest"];
export type TerminalConnection = Schemas["TerminalConnection"];

export type WorkerBootstrapInput = Schemas["WorkerBootstrapInput"];
export type WorkerBootstrapGrant = Schemas["WorkerBootstrapGrant"];
export type WorkerHeartbeatInput = Schemas["WorkerHeartbeatInput"];
export type WorkerStatus = Schemas["WorkerStatus"];
export type WorkerCheckoutGrantInput = Schemas["WorkerCheckoutGrantInput"];
export type WorkerCheckoutGrant = Schemas["WorkerCheckoutGrant"];

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface IdempotentRequestOptions extends RequestOptions {
  idempotencyKey: string;
}

export interface HostedSessionListOptions extends RequestOptions {
  project?: string;
  active?: boolean;
  orchestratorOnly?: boolean;
  fresh?: boolean;
}
