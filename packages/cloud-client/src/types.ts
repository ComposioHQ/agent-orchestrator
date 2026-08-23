import type { components } from "./schema.js";

type Schemas = components["schemas"];

export type ErrorEnvelope = Schemas["ErrorEnvelope"];
export type PageInfo = Schemas["PageInfo"];
export type AuthProvider = Schemas["AuthProvider"];
export type OrganizationRole = Schemas["OrganizationRole"];
export type CurrentUser = Schemas["CurrentUser"];
export type OrganizationMembership = Schemas["OrganizationMembership"];
export type CurrentAccount = Schemas["CurrentAccount"];
export type GoogleIdentityExchange = Schemas["GoogleIdentityExchange"];
export type RefreshTokenInput = Schemas["RefreshTokenInput"];
export type AOSession = Schemas["AOSession"];

export type AgentCapability = Schemas["AgentCapability"];
export type AgentInstallationState = Schemas["AgentInstallationState"];
export type AgentAuthenticationState = Schemas["AgentAuthenticationState"];
export type AgentOrganizationPolicy = Schemas["AgentOrganizationPolicy"];
export type AgentAvailability = Schemas["AgentAvailability"];
export type AgentProfile = Schemas["AgentProfile"];

export type Project = Schemas["Project"];
export type ProjectLifecycleState = Schemas["ProjectLifecycleState"];
export type CreateProjectInput = Schemas["CreateProjectInput"];
export type ResumeProjectInput = Schemas["ResumeProjectInput"];
export type DeleteProjectResponse = Schemas["DeleteProjectResponse"];
export type ProjectPage = Schemas["ProjectPage"];

// Hosted product DTOs are copied verbatim from the generated /api/v1 app
// contract. The App prefix keeps them distinct from the control-plane
// placement DTOs above, which deliberately carry provisioning lifecycle.
export type AppAPIError = Schemas["AppAPIError"];
export type AppProject = Schemas["AppProject"];
export type AppProjectSummary = Schemas["AppProjectSummary"];
export type AppListProjectsResponse = Schemas["AppListProjectsResponse"];
export type AppProjectGetResponse = Schemas["AppProjectGetResponse"];

export type SCMInstallStart = Schemas["SCMInstallStart"];
export type SCMInstallation = Schemas["SCMInstallation"];
export type SCMRepository = Schemas["SCMRepository"];
export type SCMInstallationList = Schemas["SCMInstallationList"];
export type SCMRepositoryList = Schemas["SCMRepositoryList"];
export type SCMAllowlistInput = Schemas["SCMAllowlistInput"];

export type SessionKind = Schemas["SessionKind"];
export type WorkerChildSession = Schemas["WorkerChildSession"];
export type WorkerChildSessionPage = Schemas["WorkerChildSessionPage"];
export type DeleteSessionResponse = Schemas["DeleteSessionResponse"];
export type SessionMode = Schemas["SessionMode"];
export type SessionActivityState = Schemas["SessionActivityState"];
export type SessionStatus = Schemas["SessionStatus"];
export type AppSessionView = Schemas["AppControllersSessionView"];
export type AppListSessionsResponse = Schemas["AppListSessionsResponse"];
export type AppSpawnSessionRequest = Schemas["AppSpawnSessionRequest"];
export type AppSpawnSessionResponse = Schemas["AppSpawnSessionResponse"];
export type AppSessionResponse = Schemas["AppSessionResponse"];
export type AppKillSessionResponse = Schemas["AppKillSessionResponse"];
export type AppRestoreSessionResponse = Schemas["AppRestoreSessionResponse"];
export type AppSendSessionMessageRequest =
  Schemas["AppSendSessionMessageRequest"];
export type AppSendSessionMessageResponse =
  Schemas["AppSendSessionMessageResponse"];

export type UserMessageEvent = Schemas["UserMessageEvent"];

export type TerminalKind = Schemas["TerminalKind"];
export type TerminalScope = Schemas["TerminalScope"];
export type TerminalTransport = Schemas["TerminalTransport"];
export type MuxChannel = Schemas["MuxChannel"];
export type MuxClientFrame = Schemas["MuxClientFrame"];
export type MuxClientFrameType = Schemas["MuxClientFrameType"];
export type MuxClientRole = Schemas["MuxClientRole"];
export type MuxServerFrame = Schemas["MuxServerFrame"];
export type MuxServerFrameType = Schemas["MuxServerFrameType"];
export type MuxSessionUpdate = Schemas["MuxSessionUpdate"];
export type TerminalProtocol = Schemas["TerminalProtocol"];
export type TerminalFeature = Schemas["TerminalFeature"];
export type TerminalConnection = Schemas["TerminalConnection"];
export type TerminalTicket = Schemas["TerminalTicket"];
export type SandboxScope = Schemas["SandboxScope"];
export type SandboxTicketRedemptionInput =
  Schemas["SandboxTicketRedemptionInput"];
export type SandboxTicketGrant = Schemas["SandboxTicketGrant"];

export type WorkspaceEntry = Schemas["WorkspaceEntry"];
export type WorkspaceFileWriteInput = Schemas["WorkspaceFileWriteInput"];

export type ProviderName = Schemas["ProviderName"];
export type ProviderPublicConfig = Schemas["ProviderPublicConfig"];
export type RedactedProviderConnection =
  Schemas["RedactedProviderConnection"];
export type PutAgentProviderConnectionInput =
  Schemas["PutAgentProviderConnectionInput"];

export type WorkerBootstrapInput = Schemas["WorkerBootstrapInput"];
export type WorkerLaunchContext = Schemas["WorkerLaunchContext"];
export type WorkerBootstrapResponse = Schemas["WorkerBootstrapResponse"];
export type WorkerHeartbeatInput = Schemas["WorkerHeartbeatInput"];
export type WorkerHeartbeatResponse = Schemas["WorkerHeartbeatResponse"];
export type WorkerReadyPayload = Schemas["WorkerReadyPayload"];
export type WorkerOutputPayload = Schemas["WorkerOutputPayload"];
export type WorkerActivityPayload = Schemas["WorkerActivityPayload"];
export type WorkerReadyEventInput = Schemas["WorkerReadyEventInput"];
export type WorkerOutputEventInput = Schemas["WorkerOutputEventInput"];
export type WorkerActivityEventInput = Schemas["WorkerActivityEventInput"];
export type WorkerEventInput = Schemas["WorkerEventInput"];
export type WorkerOKResponse = Schemas["WorkerOKResponse"];
export type WorkerTurn = Schemas["WorkerTurn"];
export type WorkerClaimTurnResponse = Schemas["WorkerClaimTurnResponse"];
export type WorkerCancellationResponse =
  Schemas["WorkerCancellationResponse"];
export type WorkerCompleteTurnInput = Schemas["WorkerCompleteTurnInput"];
export type WorkerFailTurnInput = Schemas["WorkerFailTurnInput"];
export type WorkerFinishTurnResponse = Schemas["WorkerFinishTurnResponse"];
export type WorkerCredentialResponse = Schemas["WorkerCredentialResponse"];
export type WorkerCheckoutGrantResponse =
  Schemas["WorkerCheckoutGrantResponse"];
export type CreateWorkerChildInput = Schemas["CreateWorkerChildInput"];
export type SendMessageInput = Schemas["SendMessageInput"];
export type WorkerWorkspaceListPayload =
  Schemas["WorkerWorkspaceListPayload"];
export type WorkerWorkspaceReadPayload =
  Schemas["WorkerWorkspaceReadPayload"];
export type WorkerWorkspaceWritePayload =
  Schemas["WorkerWorkspaceWritePayload"];
export type WorkerWorkspaceEntryPage =
  Schemas["WorkerWorkspaceEntryPage"];
export type WorkerTerminalOpenPayload =
  Schemas["WorkerTerminalOpenPayload"];
export type WorkerTerminalInputPayload =
  Schemas["WorkerTerminalInputPayload"];
export type WorkerTerminalResizePayload =
  Schemas["WorkerTerminalResizePayload"];
export type WorkerTerminalClosePayload =
  Schemas["WorkerTerminalClosePayload"];
export type WorkerTerminalOpenResult =
  Schemas["WorkerTerminalOpenResult"];
export type WorkerTerminalInputResult =
  Schemas["WorkerTerminalInputResult"];
export type WorkerTerminalResizeResult =
  Schemas["WorkerTerminalResizeResult"];
export type WorkerTerminalCloseResult =
  Schemas["WorkerTerminalCloseResult"];
export type WorkerWorkspaceListTransport =
  Schemas["WorkerWorkspaceListTransport"];
export type WorkerWorkspaceReadTransport =
  Schemas["WorkerWorkspaceReadTransport"];
export type WorkerWorkspaceWriteTransport =
  Schemas["WorkerWorkspaceWriteTransport"];
export type WorkerWorkspaceDiffTransport =
  Schemas["WorkerWorkspaceDiffTransport"];
export type WorkerTerminalOpenTransport =
  Schemas["WorkerTerminalOpenTransport"];
export type WorkerTerminalInputTransport =
  Schemas["WorkerTerminalInputTransport"];
export type WorkerTerminalResizeTransport =
  Schemas["WorkerTerminalResizeTransport"];
export type WorkerTerminalCloseTransport =
  Schemas["WorkerTerminalCloseTransport"];
export type WorkerTransportRequest = Schemas["WorkerTransportRequest"];
export type WorkerClaimTransportResponse =
  Schemas["WorkerClaimTransportResponse"];
export type WorkerTransportResult = Schemas["WorkerTransportResult"];
export type WorkerCompleteTransportInput =
  Schemas["WorkerCompleteTransportInput"];
export type WorkerFailTransportInput = Schemas["WorkerFailTransportInput"];
export type WorkerAgentTerminalResponse =
  Schemas["WorkerAgentTerminalResponse"];
export type WorkerTerminalExitInput = Schemas["WorkerTerminalExitInput"];
export type WorkerTerminalOutputInput =
  Schemas["WorkerTerminalOutputInput"];
export type WorkerTerminalOutputResponse =
  Schemas["WorkerTerminalOutputResponse"];

export interface PaginationOptions {
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
}

export interface EventReplayOptions {
  after?: number;
  limit?: number;
  signal?: AbortSignal;
}

export interface IdempotentRequestOptions {
  idempotencyKey: string;
  signal?: AbortSignal;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface AppSessionListOptions extends RequestOptions {
  project?: string;
  active?: boolean;
  orchestratorOnly?: boolean;
  fresh?: boolean;
}
