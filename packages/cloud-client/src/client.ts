import type {
  CloudTokenSet,
  SpawnWorkerSessionInput,
  CreateWorkspacePlacementInput,
  CurrentAccount,
  ErrorEnvelope,
  GitHubInstallation,
  GitHubInstallationStart,
  GitHubRepository,
  GitHubRepositoryAllowlistInput,
  GoogleIdentityExchange,
  IdempotentRequestOptions,
  PaginationOptions,
  PutAgentProviderConnectionInput,
  RedactedProviderConnection,
  RefreshTokenInput,
  RequestOptions,
  TerminalTicket,
  TerminalTicketGrant,
  TerminalTicketRedemption,
  TerminalTicketRequest,
  WorkerBootstrapGrant,
  WorkerBootstrapInput,
  WorkerAcceptedResponse,
  WorkerCancellationResponse,
  WorkerClaimTurnResponse,
  WorkerCheckoutGrant,
  WorkerCheckoutGrantInput,
  WorkerCompleteTransportInput,
  WorkerCompleteTurnInput,
  WorkerEventInput,
  WorkerFailTransportInput,
  WorkerFailTurnInput,
  WorkerFinishTurnResponse,
  WorkerHeartbeatInput,
  SendWorkerMessageInput,
  WorkerMessagePage,
  WorkerOKResponse,
  WorkerPRState,
  ClaimWorkerPRInput,
  WorkerPullRequestPage,
  WorkerReviewResult,
  WorkerReviewPage,
  SubmitWorkerReviewInput,
  WorkerSessionRecord,
  WorkerSessionRecordPage,
  WorkerStatusResponse,
  WorkerWorkspaceTransportRequest,
  WorkspacePlacement,
  WorkspacePlacementPage,
} from "./types.js";

type MaybePromise<T> = T | Promise<T>;

export interface CloudClientConfig {
  baseUrl: string;
  getAccessToken: () => MaybePromise<string | null | undefined>;
  fetch?: typeof globalThis.fetch;
}

export interface WorkerClientConfig {
  baseUrl: string;
  /** Reads the capability provisioned out of band at /run/ao/capability. */
  getCapability: () => MaybePromise<string | null | undefined>;
  fetch?: typeof globalThis.fetch;
}

interface JSONRequestOptions extends RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  idempotencyKey?: string;
  cache?: RequestCache;
}

export class CloudApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  readonly details?: Record<string, unknown>;
  readonly envelope: ErrorEnvelope;

  constructor(status: number, envelope: ErrorEnvelope) {
    super(envelope.message);
    this.name = "CloudApiError";
    this.status = status;
    this.code = envelope.code;
    this.requestId = envelope.requestId;
    this.details = envelope.details;
    this.envelope = envelope;
  }
}

abstract class JSONClient {
  readonly baseUrl: string;
  protected readonly fetch: typeof globalThis.fetch;

  constructor(baseUrl: string, fetchImpl?: typeof globalThis.fetch) {
    const parsed = new URL(baseUrl);
    if (parsed.search || parsed.hash || parsed.username || parsed.password) {
      throw new TypeError(
        "Cloud API baseUrl must not contain credentials, a query, or a fragment.",
      );
    }
    this.baseUrl = parsed.toString().replace(/\/+$/, "");
    this.fetch = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  protected async finish<T>(response: Response): Promise<T> {
    if (!response.ok) {
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        value = undefined;
      }
      throw new CloudApiError(response.status, toErrorEnvelope(response, value));
    }
    if (response.status === 204) return undefined as T;
    try {
      return (await response.json()) as T;
    } catch {
      throw new CloudApiError(response.status, {
        error: "Invalid Response",
        code: "INVALID_RESPONSE",
        message: "Cloud API returned an invalid JSON response.",
        requestId: response.headers.get("X-Request-Id") ?? "",
      });
    }
  }
}

export class CloudClient extends JSONClient {
  private readonly getAccessToken: CloudClientConfig["getAccessToken"];

  constructor(config: CloudClientConfig) {
    super(config.baseUrl, config.fetch);
    this.getAccessToken = config.getAccessToken;
  }

  exchangeGoogleIdentity(
    input: GoogleIdentityExchange,
    options: RequestOptions = {},
  ): Promise<CloudTokenSet> {
    return this.unauthenticatedRequest("/api/cloud/v1/auth/google", {
      method: "POST",
      body: input,
      cache: "no-store",
      signal: options.signal,
    });
  }

  refreshSession(
    input: RefreshTokenInput,
    options: RequestOptions = {},
  ): Promise<CloudTokenSet> {
    return this.unauthenticatedRequest("/api/cloud/v1/auth/refresh", {
      method: "POST",
      body: input,
      cache: "no-store",
      signal: options.signal,
    });
  }

  logoutSession(
    input: RefreshTokenInput,
    options: RequestOptions = {},
  ): Promise<void> {
    return this.unauthenticatedRequest("/api/cloud/v1/auth/logout", {
      method: "POST",
      body: input,
      cache: "no-store",
      signal: options.signal,
    });
  }

  getCurrentAccount(options: RequestOptions = {}): Promise<CurrentAccount> {
    return this.request("/api/cloud/v1/me", options);
  }

  listWorkspacePlacements(
    orgId: string,
    options: PaginationOptions = {},
  ): Promise<WorkspacePlacementPage> {
    return this.request(
      withQuery(this.orgPath(orgId, "/workspaces"), options),
      { signal: options.signal },
    );
  }

  createWorkspacePlacement(
    orgId: string,
    input: CreateWorkspacePlacementInput,
    options: IdempotentRequestOptions,
  ): Promise<WorkspacePlacement> {
    return this.request(this.orgPath(orgId, "/workspaces"), mutation(input, options));
  }

  getWorkspacePlacement(
    orgId: string,
    workspaceId: string,
    options: RequestOptions = {},
  ): Promise<WorkspacePlacement> {
    return this.request(this.workspacePath(orgId, workspaceId), options);
  }

  deleteWorkspacePlacement(
    orgId: string,
    workspaceId: string,
    options: IdempotentRequestOptions,
  ): Promise<WorkspacePlacement> {
    return this.request(this.workspacePath(orgId, workspaceId), {
      method: "DELETE",
      idempotencyKey: options.idempotencyKey,
      signal: options.signal,
    });
  }

  resumeWorkspacePlacement(
    orgId: string,
    workspaceId: string,
    options: IdempotentRequestOptions,
  ): Promise<WorkspacePlacement> {
    return this.request(`${this.workspacePath(orgId, workspaceId)}/resume`, {
      method: "POST",
      idempotencyKey: options.idempotencyKey,
      signal: options.signal,
    });
  }

  async listGitHubInstallations(
    orgId: string,
    options: RequestOptions = {},
  ): Promise<GitHubInstallation[]> {
    const response = await this.request<{ installations: GitHubInstallation[] }>(
      this.orgPath(orgId, "/github/installations"),
      options,
    );
    return response.installations;
  }

  startGitHubInstallation(
    orgId: string,
    options: RequestOptions = {},
  ): Promise<GitHubInstallationStart> {
    return this.request(this.orgPath(orgId, "/github/installations/start"), {
      method: "POST",
      cache: "no-store",
      signal: options.signal,
    });
  }

  disconnectGitHubInstallation(
    orgId: string,
    installationId: string,
    options: RequestOptions = {},
  ): Promise<void> {
    return this.request(
      `${this.installationPath(orgId, installationId)}/disconnect`,
      { method: "DELETE", signal: options.signal },
    );
  }

  async listGitHubRepositories(
    orgId: string,
    installationId: string,
    options: RequestOptions = {},
  ): Promise<GitHubRepository[]> {
    const response = await this.request<{ repositories: GitHubRepository[] }>(
      `${this.installationPath(orgId, installationId)}/repositories`,
      options,
    );
    return response.repositories;
  }

  async setGitHubRepositoryAllowlist(
    orgId: string,
    installationId: string,
    input: GitHubRepositoryAllowlistInput,
    options: RequestOptions = {},
  ): Promise<GitHubRepository[]> {
    const response = await this.request<{ repositories: GitHubRepository[] }>(
      `${this.installationPath(orgId, installationId)}/repositories`,
      { method: "PUT", body: input, signal: options.signal },
    );
    return response.repositories;
  }

  async syncGitHubInstallation(
    orgId: string,
    installationId: string,
    options: IdempotentRequestOptions,
  ): Promise<GitHubRepository[]> {
    const response = await this.request<{ repositories: GitHubRepository[] }>(
      `${this.installationPath(orgId, installationId)}/sync`,
      {
        method: "POST",
        idempotencyKey: options.idempotencyKey,
        signal: options.signal,
      },
    );
    return response.repositories;
  }

  async listProviderConnections(
    orgId: string,
    options: RequestOptions = {},
  ): Promise<RedactedProviderConnection[]> {
    const response = await this.request<{
      providerConnections: RedactedProviderConnection[];
    }>(this.orgPath(orgId, "/provider-connections"), options);
    return response.providerConnections;
  }

  async putAgentProviderConnection(
    orgId: string,
    provider: "claude-code" | "codex" | "cursor",
    input: PutAgentProviderConnectionInput,
    options: IdempotentRequestOptions,
  ): Promise<RedactedProviderConnection> {
    const response = await this.request<{
      providerConnection: RedactedProviderConnection;
    }>(this.providerPath(orgId, provider), mutation(input, options, "PUT"));
    return response.providerConnection;
  }

  deleteAgentProviderConnection(
    orgId: string,
    provider: "claude-code" | "codex" | "cursor",
    options: IdempotentRequestOptions,
  ): Promise<void> {
    return this.request(this.providerPath(orgId, provider), {
      method: "DELETE",
      idempotencyKey: options.idempotencyKey,
      signal: options.signal,
    });
  }

  createTerminalTicket(
    orgId: string,
    sessionId: string,
    input: TerminalTicketRequest,
    options: IdempotentRequestOptions,
  ): Promise<TerminalTicket> {
    return this.request(
      this.orgPath(orgId, `/sessions/${encodeURIComponent(sessionId)}/terminal-ticket`),
      { ...mutation(input, options), cache: "no-store" },
    );
  }

  private orgPath(orgId: string, suffix: string): string {
    return `/api/cloud/v1/orgs/${encodeURIComponent(requireValue(orgId, "orgId"))}${suffix}`;
  }

  private workspacePath(orgId: string, workspaceId: string): string {
    return this.orgPath(orgId, `/workspaces/${encodeURIComponent(workspaceId)}`);
  }

  private installationPath(orgId: string, installationId: string): string {
    return this.orgPath(
      orgId,
      `/github/installations/${encodeURIComponent(installationId)}`,
    );
  }

  private providerPath(orgId: string, provider: string): string {
    return this.orgPath(
      orgId,
      `/provider-connections/agents/${encodeURIComponent(provider)}`,
    );
  }

  private async request<T>(path: string, options: JSONRequestOptions = {}): Promise<T> {
    const token = await this.getAccessToken();
    if (!token) throw authError("AO access token is unavailable.");
    return this.send<T>(path, options, token);
  }

  private unauthenticatedRequest<T>(
    path: string,
    options: JSONRequestOptions,
  ): Promise<T> {
    return this.send(path, options);
  }

  private async send<T>(
    path: string,
    options: JSONRequestOptions,
    bearer?: string,
  ): Promise<T> {
    const headers = jsonHeaders(options);
    if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: encodeBody(options.body),
      cache: options.cache,
      signal: options.signal,
    });
    return this.finish(response);
  }
}

export class WorkerClient extends JSONClient {
  private readonly getCapability: WorkerClientConfig["getCapability"];

  constructor(config: WorkerClientConfig) {
    super(config.baseUrl, config.fetch);
    this.getCapability = config.getCapability;
  }

  acknowledgeBootstrap(
    input: WorkerBootstrapInput,
    options: IdempotentRequestOptions,
  ): Promise<WorkerBootstrapGrant> {
    return this.request("/api/cloud/v1/worker/bootstrap", {
      ...mutation(input, options),
      cache: "no-store",
    });
  }

  getStatus(options: RequestOptions = {}): Promise<WorkerStatusResponse> {
    return this.request("/api/cloud/v1/worker/status", options);
  }

  heartbeat(
    input: WorkerHeartbeatInput,
    options: RequestOptions = {},
  ): Promise<WorkerStatusResponse> {
    return this.request("/api/cloud/v1/worker/heartbeat", {
      method: "POST",
      body: input,
      signal: options.signal,
    });
  }

  listSessions(options: PaginationOptions = {}): Promise<WorkerSessionRecordPage> {
    return this.request(withQuery("/api/cloud/v1/worker/sessions", options), {
      signal: options.signal,
    });
  }

  createSession(
    input: SpawnWorkerSessionInput,
    options: IdempotentRequestOptions,
  ): Promise<WorkerAcceptedResponse> {
    return this.request("/api/cloud/v1/worker/sessions", mutation(input, options));
  }

  getSession(sessionId: string, options: RequestOptions = {}): Promise<WorkerSessionRecord> {
    return this.request(this.sessionPath(sessionId), options);
  }

  deleteSession(
    sessionId: string,
    options: IdempotentRequestOptions,
  ): Promise<WorkerAcceptedResponse> {
    return this.request(this.sessionPath(sessionId), {
      method: "DELETE",
      idempotencyKey: options.idempotencyKey,
      signal: options.signal,
    });
  }

  listMessages(
    sessionId: string,
    options: PaginationOptions = {},
  ): Promise<WorkerMessagePage> {
    return this.request(withQuery(`${this.sessionPath(sessionId)}/messages`, options), {
      signal: options.signal,
    });
  }

  sendMessage(
    sessionId: string,
    input: SendWorkerMessageInput,
    options: IdempotentRequestOptions,
  ): Promise<WorkerAcceptedResponse> {
    return this.request(
      `${this.sessionPath(sessionId)}/messages`,
      mutation(input, options),
    );
  }

  claimPullRequest(
    sessionId: string,
    input: ClaimWorkerPRInput,
    options: RequestOptions = {},
  ): Promise<WorkerPRState> {
    return this.request(
      `${this.sessionPath(sessionId)}/pr/claim`,
      { method: "POST", body: input, signal: options.signal },
    );
  }

  listPullRequests(
    sessionId: string,
    options: RequestOptions = {},
  ): Promise<WorkerPullRequestPage> {
    return this.request(`${this.sessionPath(sessionId)}/pr`, options);
  }

  listReviews(
    sessionId: string,
    options: RequestOptions = {},
  ): Promise<WorkerReviewPage> {
    return this.request(`${this.sessionPath(sessionId)}/reviews`, options);
  }

  submitReview(
    sessionId: string,
    input: SubmitWorkerReviewInput,
    options: RequestOptions = {},
  ): Promise<WorkerReviewResult> {
    return this.request(
      `${this.sessionPath(sessionId)}/reviews/submit`,
      { method: "POST", body: input, signal: options.signal },
    );
  }

  publishEvent(
    input: WorkerEventInput,
    options: RequestOptions = {},
  ): Promise<WorkerOKResponse> {
    return this.request("/api/cloud/v1/worker/events", {
      method: "POST",
      body: input,
      signal: options.signal,
    });
  }

  async claimTurn(options: RequestOptions = {}) {
    const response = await this.request<{ turn: WorkerClaimTurnResponse["turn"] }>(
      "/api/cloud/v1/worker/turns/claim",
      { method: "POST", signal: options.signal },
    );
    return response.turn;
  }

  getTurnCancellation(
    turnId: string,
    attempt: number,
    options: RequestOptions = {},
  ): Promise<WorkerCancellationResponse> {
    return this.request(
      withQuery(`/api/cloud/v1/worker/turns/${encodeURIComponent(turnId)}/cancellation`, {
        attempt,
      }),
      options,
    );
  }

  completeTurn(
    turnId: string,
    input: WorkerCompleteTurnInput,
    options: RequestOptions = {},
  ): Promise<WorkerFinishTurnResponse> {
    return this.request(`/api/cloud/v1/worker/turns/${encodeURIComponent(turnId)}/complete`, {
      method: "POST",
      body: input,
      signal: options.signal,
    });
  }

  failTurn(
    turnId: string,
    input: WorkerFailTurnInput,
    options: RequestOptions = {},
  ): Promise<WorkerFinishTurnResponse> {
    return this.request(`/api/cloud/v1/worker/turns/${encodeURIComponent(turnId)}/fail`, {
      method: "POST",
      body: input,
      signal: options.signal,
    });
  }

  async claimTransport(options: RequestOptions = {}): Promise<WorkerWorkspaceTransportRequest | null> {
    const response = await this.request<{ request: WorkerWorkspaceTransportRequest | null }>(
      "/api/cloud/v1/worker/transport/claim",
      { method: "POST", signal: options.signal },
    );
    return response.request;
  }

  completeTransport(
    requestId: string,
    input: WorkerCompleteTransportInput,
    options: RequestOptions = {},
  ): Promise<WorkerOKResponse> {
    return this.request(
      `/api/cloud/v1/worker/transport/${encodeURIComponent(requestId)}/complete`,
      { method: "POST", body: input, signal: options.signal },
    );
  }

  failTransport(
    requestId: string,
    input: WorkerFailTransportInput,
    options: RequestOptions = {},
  ): Promise<WorkerOKResponse> {
    return this.request(
      `/api/cloud/v1/worker/transport/${encodeURIComponent(requestId)}/fail`,
      { method: "POST", body: input, signal: options.signal },
    );
  }

  requestCheckoutGrant(
    input: WorkerCheckoutGrantInput,
    options: IdempotentRequestOptions,
  ): Promise<WorkerCheckoutGrant> {
    return this.request("/api/cloud/v1/worker/checkout-grant", {
      ...mutation(input, options),
      cache: "no-store",
    });
  }

  consumeTerminalTicket(
    input: TerminalTicketRedemption,
    options: RequestOptions = {},
  ): Promise<TerminalTicketGrant> {
    return this.request("/api/cloud/v1/sandbox/terminal-tickets/consume", {
      method: "POST",
      body: input,
      cache: "no-store",
      signal: options.signal,
    });
  }

  private sessionPath(sessionId: string): string {
    return `/api/cloud/v1/worker/sessions/${encodeURIComponent(requireValue(sessionId, "sessionId"))}`;
  }

  private async request<T>(path: string, options: JSONRequestOptions = {}): Promise<T> {
    const capability = await this.getCapability();
    if (!capability) throw authError("Sandbox capability is unavailable.");
    const headers = jsonHeaders(options);
    headers.set("Authorization", `Bearer ${capability}`);
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: encodeBody(options.body),
      cache: options.cache,
      signal: options.signal,
    });
    return this.finish(response);
  }
}

export function createCloudClient(config: CloudClientConfig): CloudClient {
  return new CloudClient(config);
}

export function createWorkerClient(config: WorkerClientConfig): WorkerClient {
  return new WorkerClient(config);
}

function mutation(
  body: unknown,
  options: IdempotentRequestOptions,
  method: "POST" | "PUT" = "POST",
): JSONRequestOptions {
  return {
    method,
    body,
    idempotencyKey: options.idempotencyKey,
    signal: options.signal,
  };
}

function jsonHeaders(options: JSONRequestOptions): Headers {
  const headers = new Headers({ Accept: "application/json" });
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.idempotencyKey !== undefined) {
    headers.set("Idempotency-Key", validateIdempotencyKey(options.idempotencyKey));
  }
  return headers;
}

function encodeBody(body: unknown): string | undefined {
  return body === undefined ? undefined : JSON.stringify(body);
}

function validateIdempotencyKey(value: string): string {
  const key = value.trim();
  if (!key || key.length > 200 || /[\r\n]/u.test(key)) {
    throw new TypeError("idempotencyKey must contain 1 to 200 header-safe characters.");
  }
  return key;
}

function requireValue(value: string, name: string): string {
  const result = value.trim();
  if (!result) throw new TypeError(`${name} must not be empty.`);
  return result;
}

function withQuery(
  path: string,
  values: { cursor?: string; limit?: number; attempt?: number },
): string {
  const query = new URLSearchParams();
  if (values.cursor !== undefined) query.set("cursor", values.cursor);
  if (values.limit !== undefined) query.set("limit", String(values.limit));
  if (values.attempt !== undefined) query.set("attempt", String(values.attempt));
  const encoded = query.toString();
  return encoded ? `${path}?${encoded}` : path;
}

function authError(message: string): CloudApiError {
  return new CloudApiError(401, {
    error: "Unauthorized",
    code: "AUTH_REQUIRED",
    message,
    requestId: "",
  });
}

function toErrorEnvelope(response: Response, value: unknown): ErrorEnvelope {
  if (value && typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.error === "string" &&
      typeof candidate.code === "string" &&
      typeof candidate.message === "string"
    ) {
      return {
        error: candidate.error,
        code: candidate.code,
        message: candidate.message,
        requestId:
          typeof candidate.requestId === "string"
            ? candidate.requestId
            : response.headers.get("X-Request-Id") ?? "",
        details:
          candidate.details && typeof candidate.details === "object"
            ? (candidate.details as Record<string, never>)
            : undefined,
      };
    }
  }
  return {
    error: response.statusText || "Request Failed",
    code: "HTTP_ERROR",
    message: `Cloud API request failed with status ${response.status}.`,
    requestId: response.headers.get("X-Request-Id") ?? "",
  };
}
