import type { components } from "./schema.js";

type Schemas = components["schemas"];

export type ErrorEnvelope = Schemas["ErrorEnvelope"];
export type GoogleIdentityExchange = Schemas["GoogleIdentityExchange"];
export type RefreshTokenInput = Schemas["RefreshTokenInput"];
export type CloudTokenSet = Schemas["CloudTokenSet"];
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
export type WorkerStatusResponse = Schemas["WorkerStatusResponse"];
export type WorkerAcceptedResponse = Schemas["WorkerAcceptedResponse"];
export type SpawnWorkerSessionInput = Schemas["SpawnWorkerSessionInput"];
export type WorkerSessionRecord = Schemas["WorkerSessionRecord"];
export type WorkerSessionRecordPage = Schemas["WorkerSessionRecordPage"];
export type SendWorkerMessageInput = Schemas["SendWorkerMessageInput"];
export type WorkerMessage = Schemas["WorkerMessage"];
export type WorkerMessagePage = Schemas["WorkerMessagePage"];
export type ClaimWorkerPRInput = Schemas["ClaimWorkerPRInput"];
export type WorkerPRState = Schemas["WorkerPRState"];
export type WorkerPullRequestPage = Schemas["WorkerPullRequestPage"];
export type WorkerReviewResult = Schemas["WorkerReviewResult"];
export type WorkerReviewPage = Schemas["WorkerReviewPage"];
export type SubmitWorkerReviewInput = Schemas["SubmitWorkerReviewInput"];
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
