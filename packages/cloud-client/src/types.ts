import type { components } from "./schema.js";

type Schemas = components["schemas"];

export type ErrorEnvelope = Schemas["ErrorEnvelope"];
export type GoogleIdentityExchange = Schemas["GoogleIdentityExchange"];
export type RefreshTokenInput = Schemas["RefreshTokenInput"];
export type AOSession = Schemas["AOSession"];
export type CurrentUser = Schemas["CurrentUser"];
export type OrganizationMembership = Schemas["OrganizationMembership"];
export type CurrentAccount = Schemas["CurrentAccount"];

export type PageInfo = Schemas["PageInfo"];
export type CreateWorkspacePlacementInput =
  Schemas["CreateWorkspacePlacementInput"];
export type WorkspacePlacementState = Schemas["WorkspacePlacementState"];
export type WorkspacePlacement = Schemas["WorkspacePlacement"];
export type WorkspacePlacementPage = Schemas["WorkspacePlacementPage"];

export type GitHubInstallation = Schemas["GitHubInstallation"];
export type GitHubInstallationStart = Schemas["GitHubInstallationStart"];
export type GitHubRepository = Schemas["GitHubRepository"];
export type GitHubRepositoryAllowlistInput =
  Schemas["GitHubRepositoryAllowlistInput"];

export type RedactedProviderConnection =
  Schemas["RedactedProviderConnection"];
export type PutAgentProviderConnectionInput =
  Schemas["PutAgentProviderConnectionInput"];

export type TerminalTicketScope = Schemas["TerminalTicketScope"];
export type TerminalTicketRequest = Schemas["TerminalTicketRequest"];
export type TerminalTicket = Schemas["TerminalTicket"];
export type TerminalTicketRedemption = Schemas["TerminalTicketRedemption"];
export type TerminalTicketGrant = Schemas["TerminalTicketGrant"];

export type WorkerBootstrapInput = Schemas["WorkerBootstrapInput"];
export type WorkerBootstrapGrant = Schemas["WorkerBootstrapGrant"];
export type WorkerHeartbeatInput = Schemas["WorkerHeartbeatInput"];
export type WorkerStatus = Schemas["WorkerStatus"];
export type CreateWorkerSessionInput = Schemas["CreateWorkerSessionInput"];
export type WorkerSession = Schemas["WorkerSession"];
export type WorkerSessionPage = Schemas["WorkerSessionPage"];
export type WorkerMessageInput = Schemas["WorkerMessageInput"];
export type WorkerMessage = Schemas["WorkerMessage"];
export type WorkerMessagePage = Schemas["WorkerMessagePage"];
export type WorkerPullRequestClaimInput =
  Schemas["WorkerPullRequestClaimInput"];
export type WorkerPullRequest = Schemas["WorkerPullRequest"];
export type WorkerPullRequestPage = Schemas["WorkerPullRequestPage"];
export type WorkerReview = Schemas["WorkerReview"];
export type WorkerReviewPage = Schemas["WorkerReviewPage"];
export type WorkerReviewSubmitInput = Schemas["WorkerReviewSubmitInput"];
export type WorkerEventInput = Schemas["WorkerEventInput"];
export type WorkerOKResponse = Schemas["WorkerOKResponse"];
export type WorkerTurn = Schemas["WorkerTurn"];
export type WorkerClaimTurnResponse = Schemas["WorkerClaimTurnResponse"];
export type WorkerCancellationResponse = Schemas["WorkerCancellationResponse"];
export type WorkerCompleteTurnInput = Schemas["WorkerCompleteTurnInput"];
export type WorkerFailTurnInput = Schemas["WorkerFailTurnInput"];
export type WorkerFinishTurnResponse = Schemas["WorkerFinishTurnResponse"];
export type WorkerWorkspaceTransportRequest =
  Schemas["WorkerWorkspaceTransportRequest"];
export type WorkerClaimTransportResponse =
  Schemas["WorkerClaimTransportResponse"];
export type WorkerCompleteTransportInput =
  Schemas["WorkerCompleteTransportInput"];
export type WorkerFailTransportInput = Schemas["WorkerFailTransportInput"];
export type WorkerCheckoutGrantInput = Schemas["WorkerCheckoutGrantInput"];
export type WorkerCheckoutGrant = Schemas["WorkerCheckoutGrant"];

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface IdempotentRequestOptions extends RequestOptions {
  idempotencyKey: string;
}

export interface PaginationOptions extends RequestOptions {
  cursor?: string;
  limit?: number;
}
