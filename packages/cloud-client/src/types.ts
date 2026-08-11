import type { components } from "./schema.js";

type Schemas = components["schemas"];

export type ErrorEnvelope = Schemas["ErrorEnvelope"];
export type PageInfo = Schemas["PageInfo"];

export type AgentCapability = Schemas["AgentCapability"];
export type AgentInstallationState = Schemas["AgentInstallationState"];
export type AgentAuthenticationState = Schemas["AgentAuthenticationState"];
export type AgentOrganizationPolicy = Schemas["AgentOrganizationPolicy"];
export type AgentAvailability = Schemas["AgentAvailability"];
export type AgentProfile = Schemas["AgentProfile"];

export type Project = Schemas["Project"];
export type CreateProjectInput = Schemas["CreateProjectInput"];
export type ProjectPage = Schemas["ProjectPage"];

export type GitHubInstallationStatus = Schemas["GitHubInstallationStatus"];
export type GitHubSyncStatus = Schemas["GitHubSyncStatus"];
export type GitHubInstallation = Schemas["GitHubInstallation"];
export type GitHubInstallationStart = Schemas["GitHubInstallationStart"];
export type GitHubRepositoryAccessState =
  Schemas["GitHubRepositoryAccessState"];
export type GitHubRepository = Schemas["GitHubRepository"];
export type GitHubRepositoryPage = Schemas["GitHubRepositoryPage"];
export type CreateGitHubProjectInput = Schemas["CreateGitHubProjectInput"];

export type Session = Schemas["Session"];
export type SessionKind = Schemas["SessionKind"];
export type SessionActivityState = Schemas["SessionActivityState"];
export type SessionStatus = Schemas["SessionStatus"];
export type Turn = Schemas["Turn"];
export type CreateSessionInput = Schemas["CreateSessionInput"];
export type SessionPage = Schemas["SessionPage"];

export type PullRequestState = Schemas["PullRequestState"];
export type CIState = Schemas["CIState"];
export type PullRequestCheckStatus = Schemas["PullRequestCheckStatus"];
export type ReviewDecision = Schemas["ReviewDecision"];
export type MergeabilityState = Schemas["MergeabilityState"];
export type PullRequestFailingCheck = Schemas["PullRequestFailingCheck"];
export type PullRequestCISummary = Schemas["PullRequestCISummary"];
export type PullRequestReviewCommentLink =
  Schemas["PullRequestReviewCommentLink"];
export type PullRequestUnresolvedReviewer =
  Schemas["PullRequestUnresolvedReviewer"];
export type PullRequestSubmittedReview =
  Schemas["PullRequestSubmittedReview"];
export type PullRequestReviewSummary = Schemas["PullRequestReviewSummary"];
export type PullRequestConflictFile = Schemas["PullRequestConflictFile"];
export type PullRequestMergeabilitySummary =
  Schemas["PullRequestMergeabilitySummary"];
export type PullRequestSummary = Schemas["PullRequestSummary"];
export type SessionPullRequests = Schemas["SessionPullRequests"];

export type AOReviewRunStatus = Schemas["AOReviewRunStatus"];
export type AOReviewVerdict = Schemas["AOReviewVerdict"];
export type AOReviewState = Schemas["AOReviewState"];
export type AOReviewRun = Schemas["AOReviewRun"];
export type AOPullRequestReviewState = Schemas["AOPullRequestReviewState"];
export type SessionReviewState = Schemas["SessionReviewState"];

export type ClientEvent = Schemas["ClientEvent"];
export type ClientEventPage = Schemas["ClientEventPage"];
export type UserMessageEvent = Schemas["UserMessageEvent"];
export type AssistantDeltaEvent = Schemas["AssistantDeltaEvent"];
export type TurnStartedEvent = Schemas["TurnStartedEvent"];
export type TurnCompletedEvent = Schemas["TurnCompletedEvent"];
export type TurnInterruptedEvent = Schemas["TurnInterruptedEvent"];
export type TurnAbortedEvent = Schemas["TurnAbortedEvent"];
export type InterruptRequestedEvent = Schemas["InterruptRequestedEvent"];

export type TerminalKind = Schemas["TerminalKind"];
export type TerminalScope = Schemas["TerminalScope"];
export type TerminalTicket = Schemas["TerminalTicket"];

export type WorkspaceEntry = Schemas["WorkspaceEntry"];
export type WorkspaceEntryPage = Schemas["WorkspaceEntryPage"];
export type WorkspaceFile = Schemas["WorkspaceFile"];
export type WorkspaceFileStatus = Schemas["WorkspaceFileStatus"];
export type WorkspaceDiffFile = Schemas["WorkspaceDiffFile"];
export type WorkspaceDiff = Schemas["WorkspaceDiff"];

export type ProviderName = Schemas["ProviderName"];
export type ProviderPublicConfig = Schemas["ProviderPublicConfig"];
export type RedactedProviderConnection =
  Schemas["RedactedProviderConnection"];

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
