import type {
  AOSession,
  APIError,
  CreateWorkspacePlacementInput,
  CurrentAccount,
  ErrorEnvelope,
  GitHubInstallation,
  GitHubInstallationStart,
  GitHubRepository,
  GitHubRepositoryAllowlistInput,
  GoogleIdentityExchange,
  HostedSessionListOptions,
  IdempotentRequestOptions,
  ListProjectsResponse,
  ListReviewsResponse,
  ListSessionPRsResponse,
  ListSessionsResponse,
  ProjectGetResponse,
  RefreshTokenInput,
  RequestOptions,
  SendSessionMessageRequest,
  SendSessionMessageResponse,
  SessionResponse,
  SpawnSessionRequest,
  SpawnSessionResponse,
  TerminalConnection,
  TerminalConnectionRequest,
  WorkerBootstrapGrant,
  WorkerBootstrapInput,
  WorkerCheckoutGrant,
  WorkerCheckoutGrantInput,
  WorkerHeartbeatInput,
  WorkerStatus,
  WorkspaceFileResponse,
  WorkspacePlacementOperation,
  ListWorkspaceFilesResponse,
} from "./types.js";

type MaybePromise<T> = T | Promise<T>;
type APIErrorEnvelope = ErrorEnvelope | APIError;

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
  orgId?: string;
  cache?: RequestCache;
}

export class CloudApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  readonly details?: Record<string, unknown>;
  readonly envelope: APIErrorEnvelope;

  constructor(status: number, envelope: APIErrorEnvelope) {
    super(envelope.message);
    this.name = "CloudApiError";
    this.status = status;
    this.code = envelope.code;
    this.requestId = envelope.requestId ?? "";
    this.details = envelope.details as Record<string, unknown> | undefined;
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

  protected async readJSON<T>(response: Response): Promise<T> {
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

  protected async throwIfError(response: Response): Promise<void> {
    if (response.ok) return;
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      value = undefined;
    }
    throw new CloudApiError(response.status, toErrorEnvelope(response, value));
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

  listProjects(
    orgId: string,
    options: RequestOptions = {},
  ): Promise<ListProjectsResponse> {
    return this.appRequest(orgId, "/api/v1/projects", options);
  }

  getProject(
    orgId: string,
    projectId: string,
    options: RequestOptions = {},
  ): Promise<ProjectGetResponse> {
    return this.appRequest(
      orgId,
      `/api/v1/projects/${encodeURIComponent(projectId)}`,
      options,
    );
  }

  createWorkspacePlacement(
    orgId: string,
    input: CreateWorkspacePlacementInput,
    options: IdempotentRequestOptions,
  ): Promise<WorkspacePlacementOperation> {
    return this.request(this.orgPath(orgId, "/workspaces"), {
      method: "POST",
      body: input,
      idempotencyKey: options.idempotencyKey,
      signal: options.signal,
    });
  }

  getWorkspacePlacement(
    orgId: string,
    operationId: string,
    options: RequestOptions = {},
  ): Promise<WorkspacePlacementOperation> {
    return this.request(
      this.orgPath(orgId, `/workspaces/${encodeURIComponent(operationId)}`),
      options,
    );
  }

  listSessions(
    orgId: string,
    options: HostedSessionListOptions = {},
  ): Promise<ListSessionsResponse> {
    const path = withQuery("/api/v1/sessions", {
      project: options.project,
      active: options.active,
      orchestratorOnly: options.orchestratorOnly,
      fresh: options.fresh,
    });
    return this.appRequest(orgId, path, { signal: options.signal });
  }

  getSession(
    orgId: string,
    sessionId: string,
    options: RequestOptions = {},
  ): Promise<SessionResponse> {
    return this.appRequest(
      orgId,
      `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
      options,
    );
  }

  spawnSession(
    orgId: string,
    input: SpawnSessionRequest,
    options: IdempotentRequestOptions,
  ): Promise<SpawnSessionResponse> {
    return this.appRequest(orgId, "/api/v1/sessions", {
      method: "POST",
      body: input,
      idempotencyKey: options.idempotencyKey,
      signal: options.signal,
    });
  }

  sendSessionMessage(
    orgId: string,
    sessionId: string,
    input: SendSessionMessageRequest,
    options: IdempotentRequestOptions,
  ): Promise<SendSessionMessageResponse> {
    return this.appRequest(
      orgId,
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/send`,
      {
        method: "POST",
        body: input,
        idempotencyKey: options.idempotencyKey,
        signal: options.signal,
      },
    );
  }

  listSessionPullRequests(
    orgId: string,
    sessionId: string,
    options: RequestOptions = {},
  ): Promise<ListSessionPRsResponse> {
    return this.appRequest(
      orgId,
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/pr`,
      options,
    );
  }

  listSessionReviews(
    orgId: string,
    sessionId: string,
    options: RequestOptions = {},
  ): Promise<ListReviewsResponse> {
    return this.appRequest(
      orgId,
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/reviews`,
      options,
    );
  }

  createTerminalConnection(
    orgId: string,
    sessionId: string,
    input: TerminalConnectionRequest,
    options: IdempotentRequestOptions,
  ): Promise<TerminalConnection> {
    return this.appRequest(
      orgId,
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/terminal-ticket`,
      {
        method: "POST",
        body: input,
        cache: "no-store",
        idempotencyKey: options.idempotencyKey,
        signal: options.signal,
      },
    );
  }

  listWorkspaceFiles(
    orgId: string,
    sessionId: string,
    options: RequestOptions = {},
  ): Promise<ListWorkspaceFilesResponse> {
    return this.appRequest(
      orgId,
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/workspace/files`,
      options,
    );
  }

  readWorkspaceFile(
    orgId: string,
    sessionId: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<WorkspaceFileResponse> {
    return this.appRequest(
      orgId,
      withQuery(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/workspace/file`,
        { path },
      ),
      options,
    );
  }

  async listGitHubInstallations(
    orgId: string,
    options: RequestOptions = {},
  ): Promise<GitHubInstallation[]> {
    const result = await this.request<{ installations: GitHubInstallation[] }>(
      this.orgPath(orgId, "/github/installations"),
      options,
    );
    return result.installations;
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

  async listGitHubRepositories(
    orgId: string,
    installationId: string,
    options: RequestOptions = {},
  ): Promise<GitHubRepository[]> {
    const result = await this.request<{ repositories: GitHubRepository[] }>(
      this.installationPath(orgId, installationId, "/repositories"),
      options,
    );
    return result.repositories;
  }

  async setGitHubRepositoryAllowlist(
    orgId: string,
    installationId: string,
    input: GitHubRepositoryAllowlistInput,
    options: RequestOptions = {},
  ): Promise<GitHubRepository[]> {
    const result = await this.request<{ repositories: GitHubRepository[] }>(
      this.installationPath(orgId, installationId, "/repositories"),
      { method: "PUT", body: input, signal: options.signal },
    );
    return result.repositories;
  }

  async syncGitHubInstallation(
    orgId: string,
    installationId: string,
    options: IdempotentRequestOptions,
  ): Promise<GitHubRepository[]> {
    const result = await this.request<{ repositories: GitHubRepository[] }>(
      this.installationPath(orgId, installationId, "/sync"),
      {
        method: "POST",
        idempotencyKey: options.idempotencyKey,
        signal: options.signal,
      },
    );
    return result.repositories;
  }

  async disconnectGitHubInstallation(
    orgId: string,
    installationId: string,
    options: RequestOptions = {},
  ): Promise<void> {
    await this.request<void>(this.installationPath(orgId, installationId, ""), {
      method: "DELETE",
      signal: options.signal,
    });
  }

  private appRequest<T>(
    orgId: string,
    path: string,
    options: JSONRequestOptions = {},
  ): Promise<T> {
    return this.request(path, { ...options, orgId: validateOrg(orgId) });
  }

  private orgPath(orgId: string, suffix: string): string {
    return `/api/cloud/v1/orgs/${encodeURIComponent(validateOrg(orgId))}${suffix}`;
  }

  private installationPath(
    orgId: string,
    installationId: string,
    suffix: string,
  ): string {
    return this.orgPath(
      orgId,
      `/github/installations/${encodeURIComponent(installationId)}${suffix}`,
    );
  }

  private async request<T>(
    path: string,
    options: JSONRequestOptions = {},
  ): Promise<T> {
    const headers = jsonHeaders(options);
    if (options.orgId !== undefined) headers.set("X-AO-Org", options.orgId);
    const token = await this.getAccessToken();
    if (!token) {
      throw new CloudApiError(401, authRequired("AO access token is unavailable."));
    }
    headers.set("Authorization", `Bearer ${token}`);
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: encodeBody(options.body),
      cache: options.cache,
      signal: options.signal,
    });
    await this.throwIfError(response);
    return this.readJSON<T>(response);
  }

  private async unauthenticatedRequest<T>(
    path: string,
    options: JSONRequestOptions,
  ): Promise<T> {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "POST",
      headers: jsonHeaders(options),
      body: encodeBody(options.body),
      cache: options.cache,
      signal: options.signal,
    });
    await this.throwIfError(response);
    return this.readJSON<T>(response);
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
      method: "POST",
      body: input,
      cache: "no-store",
      idempotencyKey: options.idempotencyKey,
      signal: options.signal,
    });
  }

  getStatus(options: RequestOptions = {}): Promise<WorkerStatus> {
    return this.request("/api/cloud/v1/worker/status", options);
  }

  heartbeat(
    input: WorkerHeartbeatInput,
    options: RequestOptions = {},
  ): Promise<WorkerStatus> {
    return this.request("/api/cloud/v1/worker/heartbeat", {
      method: "POST",
      body: input,
      signal: options.signal,
    });
  }

  sendSessionMessage(
    sessionId: string,
    input: SendSessionMessageRequest,
    options: IdempotentRequestOptions,
  ): Promise<SendSessionMessageResponse> {
    return this.request(
      `/api/cloud/v1/worker/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: "POST",
        body: input,
        idempotencyKey: options.idempotencyKey,
        signal: options.signal,
      },
    );
  }

  listSessionPullRequests(
    sessionId: string,
    options: RequestOptions = {},
  ): Promise<ListSessionPRsResponse> {
    return this.request(
      `/api/cloud/v1/worker/sessions/${encodeURIComponent(sessionId)}/pull-requests`,
      options,
    );
  }

  listSessionReviews(
    sessionId: string,
    options: RequestOptions = {},
  ): Promise<ListReviewsResponse> {
    return this.request(
      `/api/cloud/v1/worker/sessions/${encodeURIComponent(sessionId)}/reviews`,
      options,
    );
  }

  requestCheckoutGrant(
    input: WorkerCheckoutGrantInput,
    options: IdempotentRequestOptions,
  ): Promise<WorkerCheckoutGrant> {
    return this.request("/api/cloud/v1/worker/checkout-grant", {
      method: "POST",
      body: input,
      cache: "no-store",
      idempotencyKey: options.idempotencyKey,
      signal: options.signal,
    });
  }

  private async request<T>(
    path: string,
    options: JSONRequestOptions = {},
  ): Promise<T> {
    const capability = await this.getCapability();
    if (!capability) {
      throw new CloudApiError(
        401,
        authRequired("Sandbox capability is unavailable."),
      );
    }
    const headers = jsonHeaders(options);
    headers.set("Authorization", `Bearer ${capability}`);
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: encodeBody(options.body),
      cache: options.cache,
      signal: options.signal,
    });
    await this.throwIfError(response);
    return this.readJSON<T>(response);
  }
}

export function createCloudClient(config: CloudClientConfig): CloudClient {
  return new CloudClient(config);
}

export function createWorkerClient(config: WorkerClientConfig): WorkerClient {
  return new WorkerClient(config);
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

function validateOrg(value: string): string {
  const org = value.trim();
  if (!org) throw new TypeError("orgId must not be empty.");
  return org;
}

function withQuery(
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

function authRequired(message: string): ErrorEnvelope {
  return {
    error: "Unauthorized",
    code: "AUTH_REQUIRED",
    message,
    requestId: "",
  };
}

function toErrorEnvelope(response: Response, value: unknown): APIErrorEnvelope {
  if (isErrorEnvelope(value)) {
    return {
      ...value,
      requestId:
        value.requestId ?? response.headers.get("X-Request-Id") ?? "",
    };
  }
  return {
    error: response.statusText || "Request Failed",
    code: "HTTP_ERROR",
    message: `Cloud API request failed with status ${response.status}.`,
    requestId: response.headers.get("X-Request-Id") ?? "",
  };
}

function isErrorEnvelope(value: unknown): value is APIErrorEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.error === "string" &&
    typeof candidate.code === "string" &&
    typeof candidate.message === "string" &&
    (candidate.requestId === undefined || typeof candidate.requestId === "string")
  );
}
