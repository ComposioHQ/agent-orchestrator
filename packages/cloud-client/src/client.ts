import type {
  AgentProfile,
  AOSession,
  AppKillSessionResponse,
  AppListProjectsResponse,
  AppListSessionsResponse,
  AppProjectGetResponse,
  AppRestoreSessionResponse,
  AppSendSessionMessageRequest,
  AppSendSessionMessageResponse,
  AppSessionListOptions,
  AppSessionResponse,
  AppSpawnSessionRequest,
  AppSpawnSessionResponse,
  CreateProjectInput,
  CreateWorkerChildInput,
  CurrentAccount,
  DeleteProjectResponse,
  DeleteSessionResponse,
  ErrorEnvelope,
  GoogleIdentityExchange,
  IdempotentRequestOptions,
  PaginationOptions,
  Project,
  ProjectPage,
  PutAgentProviderConnectionInput,
  RedactedProviderConnection,
  RefreshTokenInput,
  RequestOptions,
  ResumeProjectInput,
  SandboxTicketGrant,
  SandboxTicketRedemptionInput,
  SCMAllowlistInput,
  SCMInstallStart,
  SCMInstallation,
  SCMRepositoryList,
  TerminalConnection,
  TerminalKind,
  TerminalScope,
  TerminalTicket,
  UserMessageEvent,
  WorkerAgentTerminalResponse,
  WorkerBootstrapInput,
  WorkerBootstrapResponse,
  WorkerCancellationResponse,
  WorkerCheckoutGrantResponse,
  WorkerChildSession,
  WorkerChildSessionPage,
  WorkerCompleteTransportInput,
  WorkerCompleteTurnInput,
  WorkerCredentialResponse,
  WorkerEventInput,
  WorkerFailTransportInput,
  WorkerFailTurnInput,
  WorkerFinishTurnResponse,
  WorkerHeartbeatInput,
  WorkerHeartbeatResponse,
  WorkerOKResponse,
  WorkerTerminalExitInput,
  WorkerTerminalOutputInput,
  WorkerTerminalOutputResponse,
  WorkerTransportRequest,
  WorkerTurn,
  WorkspaceFileWriteInput,
} from "./types.js";

type MaybePromise<T> = T | Promise<T>;

export interface CloudClientConfig {
  baseUrl: string;
  getAccessToken: () => MaybePromise<string | null | undefined>;
  fetch?: typeof globalThis.fetch;
}

export interface WorkerClientConfig {
  baseUrl: string;
  getWorkerToken: () => MaybePromise<string | null | undefined>;
  fetch?: typeof globalThis.fetch;
}

export interface SandboxClientConfig {
  baseUrl: string;
  getCapability: () => MaybePromise<string | null | undefined>;
  fetch?: typeof globalThis.fetch;
}

interface JSONRequestOptions extends RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  idempotencyKey?: string;
  cache?: RequestCache;
  organization?: string;
}

/**
 * Header that selects the organization for a hosted app request to `/api/v1`.
 *
 * Exported so the desktop, the daemon mount, and this package cannot drift to
 * three spellings of the same header — it has already been renamed once. The
 * value is an organization id or slug, and it is only required when the caller
 * belongs to more than one organization.
 */
export const ORGANIZATION_HEADER = "X-AO-Org";

/**
 * Builds the organization header for a hosted app request, or nothing when
 * there is no organization to name.
 *
 * A caller with one active membership may omit it; a caller with several must
 * send it, because the server refuses to guess. Passing the id is preferred
 * over the slug, which is renameable.
 */
export function organizationHeaders(
  organization?: string | null,
): Record<string, string> {
  const value = organization?.trim();
  return value ? { [ORGANIZATION_HEADER]: value } : {};
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

export class CloudClient {
  readonly baseUrl: string;

  private readonly getAccessToken: CloudClientConfig["getAccessToken"];
  private readonly fetch: typeof globalThis.fetch;

  constructor(config: CloudClientConfig) {
    const baseUrl = new URL(config.baseUrl);
    if (baseUrl.search || baseUrl.hash) {
      throw new TypeError("Cloud API baseUrl must not contain a query or fragment.");
    }

    this.baseUrl = baseUrl.toString().replace(/\/+$/, "");
    this.getAccessToken = config.getAccessToken;
    this.fetch = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  exchangeGoogleIdentity(
    input: GoogleIdentityExchange,
    options: RequestOptions = {},
  ): Promise<AOSession> {
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
  ): Promise<AOSession> {
    return this.unauthenticatedRequest("/api/cloud/v1/auth/refresh", {
      method: "POST",
      body: input,
      cache: "no-store",
      signal: options.signal,
    });
  }

  async logoutSession(
    input: RefreshTokenInput,
    options: RequestOptions = {},
  ): Promise<void> {
    await this.unauthenticatedRequest<void>("/api/cloud/v1/auth/logout", {
      method: "POST",
      body: input,
      cache: "no-store",
      signal: options.signal,
    });
  }

  getCurrentAccount(options: RequestOptions = {}): Promise<CurrentAccount> {
    return this.request("/api/cloud/v1/me", options);
  }

  listAppProjects(
    organization: string,
    options: RequestOptions = {},
  ): Promise<AppListProjectsResponse> {
    return this.request("/api/v1/projects", {
      organization,
      signal: options.signal,
    });
  }

  getAppProject(
    organization: string,
    projectId: string,
    options: RequestOptions = {},
  ): Promise<AppProjectGetResponse> {
    return this.request(`/api/v1/projects/${encodeURIComponent(projectId)}`, {
      organization,
      signal: options.signal,
    });
  }

  listSessions(
    organization: string,
    options: AppSessionListOptions = {},
  ): Promise<AppListSessionsResponse> {
    return this.request(
      this.withQuery("/api/v1/sessions", {
        project: options.project,
        active: options.active,
        orchestratorOnly: options.orchestratorOnly,
        fresh: options.fresh,
      }),
      { organization, signal: options.signal },
    );
  }

  spawnSession(
    organization: string,
    input: AppSpawnSessionRequest,
    options: RequestOptions = {},
  ): Promise<AppSpawnSessionResponse> {
    return this.request("/api/v1/sessions", {
      method: "POST",
      body: input,
      organization,
      signal: options.signal,
    });
  }

  getSession(
    organization: string,
    sessionId: string,
    options: RequestOptions = {},
  ): Promise<AppSessionResponse> {
    return this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
      organization,
      signal: options.signal,
    });
  }

  killSession(
    organization: string,
    sessionId: string,
    options: RequestOptions = {},
  ): Promise<AppKillSessionResponse> {
    return this.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/kill`,
      { method: "POST", organization, signal: options.signal },
    );
  }

  restoreSession(
    organization: string,
    sessionId: string,
    options: RequestOptions = {},
  ): Promise<AppRestoreSessionResponse> {
    return this.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/restore`,
      { method: "POST", organization, signal: options.signal },
    );
  }

  sendMessage(
    organization: string,
    sessionId: string,
    input: AppSendSessionMessageRequest,
    options: RequestOptions = {},
  ): Promise<AppSendSessionMessageResponse> {
    return this.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/send`,
      {
        method: "POST",
        body: input,
        organization,
        signal: options.signal,
      },
    );
  }

  async listAgents(
    orgId: string,
    options: RequestOptions = {},
  ): Promise<AgentProfile[]> {
    const response = await this.request<{ agents: AgentProfile[] }>(
      this.orgPath(orgId, "/agents"),
      options,
    );
    return response.agents;
  }

  listProjects(
    orgId: string,
    options: PaginationOptions = {},
  ): Promise<ProjectPage> {
    return this.request(
      this.withQuery(this.orgPath(orgId, "/projects"), {
        cursor: options.cursor,
        limit: options.limit,
      }),
      { signal: options.signal },
    );
  }

  createProject(
    orgId: string,
    input: CreateProjectInput,
    options: IdempotentRequestOptions,
  ): Promise<{ project: Project }> {
    return this.request(this.orgPath(orgId, "/projects"), {
      method: "POST",
      body: input,
      idempotencyKey: options.idempotencyKey,
      signal: options.signal,
    });
  }

  /**
   * @deprecated Superseded by `GET /api/v1/projects/{id}` on the hosted app
   * API. See `contracts/cloud/CHANGELOG.md`.
   */
  getProject(
    orgId: string,
    projectId: string,
    options: RequestOptions = {},
  ): Promise<{ project: Project }> {
    return this.request(
      this.orgPath(orgId, `/projects/${encodeURIComponent(projectId)}`),
      options,
    );
  }

  deleteProject(
    orgId: string,
    projectId: string,
    options: IdempotentRequestOptions,
  ): Promise<DeleteProjectResponse> {
    return this.request(
      this.orgPath(orgId, `/projects/${encodeURIComponent(projectId)}`),
      {
        method: "DELETE",
        idempotencyKey: options.idempotencyKey,
        signal: options.signal,
      },
    );
  }

  resumeProject(
    orgId: string,
    projectId: string,
    options: IdempotentRequestOptions & { input?: ResumeProjectInput },
  ): Promise<{ project: Project }> {
    return this.request(
      this.orgPath(orgId, `/projects/${encodeURIComponent(projectId)}/resume`),
      {
        method: "POST",
        body: options.input ?? {},
        idempotencyKey: options.idempotencyKey,
        signal: options.signal,
      },
    );
  }

  async listGitHubInstallations(
    organization: string,
    options: RequestOptions = {},
  ): Promise<SCMInstallation[]> {
    const response = await this.request<{ installations: SCMInstallation[] }>(
      "/api/cloud/v1/scm/github/installations",
      { organization, signal: options.signal },
    );
    return response.installations;
  }

  startGitHubInstallation(
    organization: string,
    options: RequestOptions = {},
  ): Promise<SCMInstallStart> {
    return this.request("/api/cloud/v1/scm/github/installations", {
      method: "POST",
      organization,
      signal: options.signal,
    });
  }

  syncGitHubRepositories(
    organization: string,
    installationId: string,
    options: RequestOptions = {},
  ): Promise<SCMRepositoryList> {
    return this.request(
      `/api/cloud/v1/scm/github/installations/${encodeURIComponent(installationId)}/repositories/sync`,
      { method: "POST", organization, signal: options.signal },
    );
  }

  async disconnectGitHubInstallation(
    organization: string,
    installationId: string,
    options: RequestOptions = {},
  ): Promise<void> {
    await this.request(
      `/api/cloud/v1/scm/github/installations/${encodeURIComponent(installationId)}`,
      { method: "DELETE", organization, signal: options.signal },
    );
  }

  listGitHubRepositories(
    organization: string,
    installationId: string,
    options: RequestOptions = {},
  ): Promise<SCMRepositoryList> {
    return this.request(
      `/api/cloud/v1/scm/github/installations/${encodeURIComponent(installationId)}/repositories`,
      { organization, signal: options.signal },
    );
  }

  setGitHubRepositoryAllowlist(
    organization: string,
    installationId: string,
    input: SCMAllowlistInput,
    options: RequestOptions = {},
  ): Promise<SCMRepositoryList> {
    return this.request(
      `/api/cloud/v1/scm/github/installations/${encodeURIComponent(installationId)}/allowlist`,
      { method: "PUT", body: input, organization, signal: options.signal },
    );
  }

  createTerminalTicket(
    orgId: string,
    sessionId: string,
    kind: TerminalKind = "workspace",
    options: RequestOptions & { scopes?: TerminalScope[] } = {},
  ): Promise<TerminalTicket> {
    return this.request(
      this.orgPath(
        orgId,
        `/sessions/${encodeURIComponent(sessionId)}/terminal-ticket`,
      ),
      {
        method: "POST",
        body: options.scopes ? { kind, scopes: options.scopes } : { kind },
        cache: "no-store",
        signal: options.signal,
      },
    );
  }

  /**
   * Attach URL for a terminal ticket.
   *
   * The ticket is deliberately **not** in this URL: it travels as a WebSocket
   * subprotocol (see {@link terminalSubprotocols}), because a query string
   * reaches proxy logs, browser history and referrers, and a credential in
   * three such places is a credential leaked.
   *
   * The listener need not live on the API origin, so the ticket's own
   * `connection.url` wins; the control plane's default is used only when the
   * server reported none.
   */
  terminalUrl(
    options: { after?: number; connection?: TerminalConnection } = {},
  ): string {
    const url = new URL(
      options.connection?.url ?? `${this.baseUrl}/api/cloud/v1/terminal`,
    );
    if (url.protocol === "https:" || url.protocol === "http:") {
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    }
    if (options.after !== undefined) {
      url.searchParams.set("after", String(options.after));
    }
    return url.toString();
  }

  /**
   * Subprotocols to offer on the attach handshake: the framing version, then
   * the ticket as `ao.ticket.<opaque>`.
   *
   * The server authenticates from the ticket entry and selects only the framing
   * one, so the credential is never echoed back. Close the socket if anything
   * other than the framing protocol is selected rather than guessing a framing.
   */
  terminalSubprotocols(ticket: TerminalTicket): [string, string] {
    const connection = ticket.connection;
    const prefix = connection?.ticketSubprotocolPrefix ?? "ao.ticket.";
    return [connection?.protocol ?? "ao.mux.v1", `${prefix}${ticket.ticket}`];
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

  putAgentProviderConnection(
    orgId: string,
    provider: "claude-code" | "codex" | "cursor",
    input: PutAgentProviderConnectionInput,
    options: RequestOptions = {},
  ): Promise<{ providerConnection: RedactedProviderConnection }> {
    return this.request(
      this.orgPath(
        orgId,
        `/provider-connections/agents/${encodeURIComponent(provider)}`,
      ),
      {
        method: "PUT",
        body: input,
        signal: options.signal,
      },
    );
  }

  async deleteAgentProviderConnection(
    orgId: string,
    provider: "claude-code" | "codex" | "cursor",
    options: RequestOptions = {},
  ): Promise<void> {
    const response = await this.authorizedFetch(
      this.orgPath(
        orgId,
        `/provider-connections/agents/${encodeURIComponent(provider)}`,
      ),
      {
        method: "DELETE",
        headers: new Headers({ Accept: "application/json" }),
        signal: options.signal,
      },
    );
    await this.throwIfError(response);
  }

  private orgPath(orgId: string, path: string): string {
    return `/api/cloud/v1/orgs/${encodeURIComponent(orgId)}${path}`;
  }

  private withQuery(
    path: string,
    values: Record<string, string | number | boolean | undefined>,
  ): string {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) query.set(key, String(value));
    }
    const encoded = query.toString();
    return encoded ? `${path}?${encoded}` : path;
  }

  private async request<T>(
    path: string,
    options: JSONRequestOptions = {},
  ): Promise<T> {
    const headers = new Headers({ Accept: "application/json" });
    for (const [name, value] of Object.entries(
      organizationHeaders(options.organization),
    )) {
      headers.set(name, value);
    }
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    if (options.idempotencyKey !== undefined) {
      headers.set(
        "Idempotency-Key",
        validateIdempotencyKey(options.idempotencyKey),
      );
    }

    const response = await this.authorizedFetch(path, {
      method: options.method ?? "GET",
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      // Threaded like the worker client already does, so a secret-bearing
      // route asking for "no-store" actually gets it.
      cache: options.cache,
      signal: options.signal,
    });
    await this.throwIfError(response);
    if (response.status === 204) return undefined as T;

    try {
      return (await response.json()) as T;
    } catch {
      throw this.invalidResponse(
        response.status,
        "Cloud API returned an invalid JSON response.",
      );
    }
  }

  private async unauthenticatedRequest<T>(
    path: string,
    options: JSONRequestOptions,
  ): Promise<T> {
    const headers = new Headers({
      Accept: "application/json",
      "Content-Type": "application/json",
    });
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "POST",
      headers,
      body: JSON.stringify(options.body),
      cache: options.cache,
      signal: options.signal,
    });
    await this.throwIfError(response);
    if (response.status === 204) return undefined as T;
    try {
      return (await response.json()) as T;
    } catch {
      throw this.invalidResponse(
        response.status,
        "Cloud API returned an invalid JSON response.",
      );
    }
  }

  private async authorizedFetch(
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    const token = (await this.getAccessToken())?.trim();
    if (!token) {
      throw new CloudApiError(401, {
        error: "Unauthorized",
        code: "AUTH_REQUIRED",
        message: "A Cloud API access token is required.",
        requestId: "",
      });
    }

    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return this.fetch(`${this.baseUrl}${path}`, { ...init, headers });
  }

  private async throwIfError(response: Response): Promise<void> {
    if (response.ok) return;

    let value: unknown;
    try {
      value = await response.json();
    } catch {
      value = undefined;
    }
    const envelope = toErrorEnvelope(response, value);
    throw new CloudApiError(response.status, envelope);
  }

  private invalidResponse(status: number, message: string): CloudApiError {
    return new CloudApiError(status, {
      error: "Invalid Response",
      code: "INVALID_RESPONSE",
      message,
      requestId: "",
    });
  }
}

export function createCloudClient(config: CloudClientConfig): CloudClient {
  return new CloudClient(config);
}

export class WorkerClient {
  readonly baseUrl: string;

  private readonly getWorkerToken: WorkerClientConfig["getWorkerToken"];
  private readonly fetch: typeof globalThis.fetch;

  constructor(config: WorkerClientConfig) {
    const baseUrl = new URL(config.baseUrl);
    if (baseUrl.search || baseUrl.hash) {
      throw new TypeError("Cloud API baseUrl must not contain a query or fragment.");
    }
    this.baseUrl = baseUrl.toString().replace(/\/+$/, "");
    this.getWorkerToken = config.getWorkerToken;
    this.fetch = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  bootstrap(
    input: WorkerBootstrapInput,
    options: RequestOptions = {},
  ): Promise<WorkerBootstrapResponse> {
    return this.unauthenticatedRequest("/api/cloud/v1/worker/bootstrap", {
      method: "POST",
      body: input,
      cache: "no-store",
      signal: options.signal,
    });
  }

  heartbeat(
    input: WorkerHeartbeatInput,
    options: RequestOptions = {},
  ): Promise<WorkerHeartbeatResponse> {
    return this.request("/api/cloud/v1/worker/heartbeat", {
      method: "POST",
      body: input,
      cache: "no-store",
      signal: options.signal,
    });
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

  async claimTurn(options: RequestOptions = {}): Promise<WorkerTurn | null> {
    const response = await this.request<{ turn: WorkerTurn | null }>(
      "/api/cloud/v1/worker/turns/claim",
      { method: "POST", body: {}, signal: options.signal },
    );
    return response.turn;
  }

  getTurnCancellation(
    turnId: string,
    attempt: number,
    options: RequestOptions = {},
  ): Promise<WorkerCancellationResponse> {
    const query = new URLSearchParams({ attempt: String(attempt) });
    return this.request(
      `/api/cloud/v1/worker/turns/${encodeURIComponent(turnId)}/cancellation?${query.toString()}`,
      { signal: options.signal },
    );
  }

  completeTurn(
    turnId: string,
    input: WorkerCompleteTurnInput,
    options: RequestOptions = {},
  ): Promise<WorkerFinishTurnResponse> {
    return this.request(
      `/api/cloud/v1/worker/turns/${encodeURIComponent(turnId)}/complete`,
      { method: "POST", body: input, signal: options.signal },
    );
  }

  failTurn(
    turnId: string,
    input: WorkerFailTurnInput,
    options: RequestOptions = {},
  ): Promise<WorkerFinishTurnResponse> {
    return this.request(
      `/api/cloud/v1/worker/turns/${encodeURIComponent(turnId)}/fail`,
      { method: "POST", body: input, signal: options.signal },
    );
  }

  getCredential(
    options: RequestOptions = {},
  ): Promise<WorkerCredentialResponse> {
    return this.request("/api/cloud/v1/worker/credential", {
      cache: "no-store",
      signal: options.signal,
    });
  }

  createCheckoutGrant(
    options: RequestOptions = {},
  ): Promise<WorkerCheckoutGrantResponse> {
    return this.request("/api/cloud/v1/worker/checkout-grant", {
      method: "POST",
      cache: "no-store",
      signal: options.signal,
    });
  }

  listChildren(
    options: PaginationOptions = {},
  ): Promise<WorkerChildSessionPage> {
    const query = new URLSearchParams();
    if (options.cursor !== undefined) query.set("cursor", options.cursor);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return this.request(`/api/cloud/v1/worker/children${suffix}`, {
      signal: options.signal,
    });
  }

  createChild(
    input: CreateWorkerChildInput,
    options: IdempotentRequestOptions,
  ): Promise<{ session: WorkerChildSession }> {
    return this.request("/api/cloud/v1/worker/children", {
      method: "POST",
      body: input,
      idempotencyKey: options.idempotencyKey,
      signal: options.signal,
    });
  }

  sendChildMessage(
    sessionId: string,
    text: string,
    options: IdempotentRequestOptions,
  ): Promise<{ event: UserMessageEvent }> {
    return this.request(
      `/api/cloud/v1/worker/children/${encodeURIComponent(sessionId)}/messages`,
      {
        method: "POST",
        body: { text },
        idempotencyKey: options.idempotencyKey,
        signal: options.signal,
      },
    );
  }

  deleteChild(
    sessionId: string,
    options: RequestOptions = {},
  ): Promise<DeleteSessionResponse> {
    return this.request(
      `/api/cloud/v1/worker/children/${encodeURIComponent(sessionId)}`,
      { method: "DELETE", signal: options.signal },
    );
  }

  async claimTransport(
    options: RequestOptions = {},
  ): Promise<WorkerTransportRequest | null> {
    const response = await this.request<{
      request: WorkerTransportRequest | null;
    }>("/api/cloud/v1/worker/transport/claim", {
      method: "POST",
      body: {},
      signal: options.signal,
    });
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

  ensureAgentTerminal(
    options: RequestOptions = {},
  ): Promise<WorkerAgentTerminalResponse> {
    return this.request("/api/cloud/v1/worker/terminals/agent", {
      method: "POST",
      body: {},
      signal: options.signal,
    });
  }

  publishTerminalOutput(
    terminalId: string,
    input: WorkerTerminalOutputInput,
    options: RequestOptions = {},
  ): Promise<WorkerTerminalOutputResponse> {
    return this.request(
      `/api/cloud/v1/worker/terminals/${encodeURIComponent(terminalId)}/output`,
      { method: "POST", body: input, signal: options.signal },
    );
  }

  publishTerminalExit(
    terminalId: string,
    input: WorkerTerminalExitInput,
    options: RequestOptions = {},
  ): Promise<WorkerOKResponse> {
    return this.request(
      `/api/cloud/v1/worker/terminals/${encodeURIComponent(terminalId)}/exit`,
      { method: "POST", body: input, signal: options.signal },
    );
  }

  private async request<T>(
    path: string,
    options: JSONRequestOptions = {},
  ): Promise<T> {
    const headers = new Headers({ Accept: "application/json" });
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    if (options.idempotencyKey !== undefined) {
      headers.set(
        "Idempotency-Key",
        validateIdempotencyKey(options.idempotencyKey),
      );
    }
    const response = await this.authorizedFetch(path, {
      method: options.method ?? "GET",
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: options.cache,
      signal: options.signal,
    });
    await throwIfErrorResponse(response);
    return readJSONResponse<T>(response);
  }

  private async unauthenticatedRequest<T>(
    path: string,
    options: JSONRequestOptions,
  ): Promise<T> {
    const headers = new Headers({
      Accept: "application/json",
      "Content-Type": "application/json",
    });
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "POST",
      headers,
      body: JSON.stringify(options.body),
      cache: options.cache,
      signal: options.signal,
    });
    await throwIfErrorResponse(response);
    return readJSONResponse<T>(response);
  }

  private async authorizedFetch(
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    const token = (await this.getWorkerToken())?.trim();
    if (!token) {
      throw new CloudApiError(401, {
        error: "Unauthorized",
        code: "WORKER_AUTH_REQUIRED",
        message: "A worker credential is required.",
        requestId: "",
      });
    }
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Worker ${token}`);
    return this.fetch(`${this.baseUrl}${path}`, { ...init, headers });
  }
}

export function createWorkerClient(config: WorkerClientConfig): WorkerClient {
  return new WorkerClient(config);
}

export class SandboxClient {
  readonly baseUrl: string;

  private readonly getCapability: SandboxClientConfig["getCapability"];
  private readonly fetch: typeof globalThis.fetch;

  constructor(config: SandboxClientConfig) {
    const baseUrl = new URL(config.baseUrl);
    if (baseUrl.search || baseUrl.hash) {
      throw new TypeError("Cloud API baseUrl must not contain a query or fragment.");
    }
    this.baseUrl = baseUrl.toString().replace(/\/+$/, "");
    this.getCapability = config.getCapability;
    this.fetch = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async redeemSandboxTicket(
    input: SandboxTicketRedemptionInput,
    options: RequestOptions = {},
  ): Promise<SandboxTicketGrant> {
    const capability = (await this.getCapability())?.trim();
    if (!capability) {
      throw new CloudApiError(401, {
        error: "Unauthorized",
        code: "SANDBOX_CAPABILITY_REQUIRED",
        message: "A sandbox capability is required.",
        requestId: "",
      });
    }
    const response = await this.fetch(
      `${this.baseUrl}/api/cloud/v1/sandbox/terminal-tickets/consume`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${capability}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
        cache: "no-store",
        signal: options.signal,
      },
    );
    await throwIfErrorResponse(response);
    return readJSONResponse<SandboxTicketGrant>(response);
  }
}

export function createSandboxClient(config: SandboxClientConfig): SandboxClient {
  return new SandboxClient(config);
}

function validateIdempotencyKey(value: string): string {
  const key = value.trim();
  if (!key || key.length > 200) {
    throw new TypeError("idempotencyKey must contain between 1 and 200 characters.");
  }
  return key;
}

async function waitForRetry(
  attempt: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (attempt <= 1 || signal?.aborted) return;
  const base = Math.min(250 * 2 ** Math.min(attempt - 2, 4), 4_000);
  const delay = base + Math.floor(Math.random() * Math.max(1, base / 4));
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, delay);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function toErrorEnvelope(response: Response, value: unknown): ErrorEnvelope {
  const object = isRecord(value) ? value : {};
  return {
    error:
      typeof object.error === "string"
        ? object.error
        : response.statusText || "Request Failed",
    code: typeof object.code === "string" ? object.code : "HTTP_ERROR",
    message:
      typeof object.message === "string"
        ? object.message
        : `Cloud API request failed with status ${response.status}.`,
    requestId:
      typeof object.requestId === "string"
        ? object.requestId
        : response.headers.get("x-request-id") ?? "",
    ...(isRecord(object.details) ? { details: object.details } : {}),
  };
}

async function throwIfErrorResponse(response: Response): Promise<void> {
  if (response.ok) return;
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    value = undefined;
  }
  throw new CloudApiError(response.status, toErrorEnvelope(response, value));
}

async function readJSONResponse<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new CloudApiError(response.status, {
      error: "Invalid Response",
      code: "INVALID_RESPONSE",
      message: "Cloud API returned an invalid JSON response.",
      requestId: "",
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
