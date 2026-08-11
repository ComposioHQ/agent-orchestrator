import type {
  AgentProfile,
  ClientEvent,
  ClientEventPage,
  CreateGitHubProjectInput,
  CreateProjectInput,
  CreateSessionInput,
  ErrorEnvelope,
  EventReplayOptions,
  GitHubInstallation,
  GitHubInstallationStart,
  GitHubRepositoryPage,
  IdempotentRequestOptions,
  PaginationOptions,
  Project,
  ProjectPage,
  RedactedProviderConnection,
  RequestOptions,
  Session,
  SessionPage,
  SessionPullRequests,
  SessionReviewState,
  TerminalKind,
  TerminalTicket,
  UserMessageEvent,
  WorkspaceDiff,
  WorkspaceEntryPage,
  WorkspaceFile,
} from "./types.js";

type MaybePromise<T> = T | Promise<T>;

export interface CloudClientConfig {
  baseUrl: string;
  getAccessToken: () => MaybePromise<string | null | undefined>;
  fetch?: typeof globalThis.fetch;
}

interface JSONRequestOptions extends RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  idempotencyKey?: string;
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

  async listGitHubInstallations(
    orgId: string,
    options: RequestOptions = {},
  ): Promise<GitHubInstallation[]> {
    const response = await this.request<{
      installations: GitHubInstallation[];
    }>(this.orgPath(orgId, "/github/installations"), options);
    return response.installations;
  }

  startGitHubInstallation(
    orgId: string,
    options: RequestOptions = {},
  ): Promise<GitHubInstallationStart> {
    return this.request(this.orgPath(orgId, "/github/installations/start"), {
      method: "POST",
      signal: options.signal,
    });
  }

  syncGitHubInstallation(
    orgId: string,
    installationId: string,
    options: RequestOptions = {},
  ): Promise<{ installation: GitHubInstallation }> {
    return this.request(
      this.orgPath(
        orgId,
        `/github/installations/${encodeURIComponent(installationId)}/sync`,
      ),
      { method: "POST", signal: options.signal },
    );
  }

  disconnectGitHubInstallation(
    orgId: string,
    installationId: string,
    options: RequestOptions = {},
  ): Promise<{ installation: GitHubInstallation }> {
    return this.request(
      this.orgPath(
        orgId,
        `/github/installations/${encodeURIComponent(installationId)}/disconnect`,
      ),
      { method: "POST", signal: options.signal },
    );
  }

  listGitHubRepositories(
    orgId: string,
    options: PaginationOptions = {},
  ): Promise<GitHubRepositoryPage> {
    return this.request(
      this.withQuery(this.orgPath(orgId, "/github/repositories"), {
        cursor: options.cursor,
        limit: options.limit,
      }),
      { signal: options.signal },
    );
  }

  createProjectFromGitHub(
    orgId: string,
    input: CreateGitHubProjectInput,
    options: IdempotentRequestOptions,
  ): Promise<{ project: Project }> {
    return this.request(this.orgPath(orgId, "/github/projects"), {
      method: "POST",
      body: input,
      idempotencyKey: options.idempotencyKey,
      signal: options.signal,
    });
  }

  listSessions(
    orgId: string,
    options: PaginationOptions & { projectId?: string } = {},
  ): Promise<SessionPage> {
    return this.request(
      this.withQuery(this.orgPath(orgId, "/sessions"), {
        cursor: options.cursor,
        limit: options.limit,
        projectId: options.projectId,
      }),
      { signal: options.signal },
    );
  }

  getSession(
    orgId: string,
    sessionId: string,
    options: RequestOptions = {},
  ): Promise<{ session: Session }> {
    return this.request(
      this.orgPath(orgId, `/sessions/${encodeURIComponent(sessionId)}`),
      options,
    );
  }

  createSession(
    orgId: string,
    input: CreateSessionInput,
    options: IdempotentRequestOptions,
  ): Promise<{ session: Session }> {
    return this.request(this.orgPath(orgId, "/sessions"), {
      method: "POST",
      body: input,
      idempotencyKey: options.idempotencyKey,
      signal: options.signal,
    });
  }

  listSessionPullRequests(
    orgId: string,
    sessionId: string,
    options: RequestOptions = {},
  ): Promise<SessionPullRequests> {
    return this.request(
      this.orgPath(
        orgId,
        `/sessions/${encodeURIComponent(sessionId)}/pull-requests`,
      ),
      options,
    );
  }

  getSessionReviewState(
    orgId: string,
    sessionId: string,
    options: RequestOptions = {},
  ): Promise<SessionReviewState> {
    return this.request(
      this.orgPath(
        orgId,
        `/sessions/${encodeURIComponent(sessionId)}/reviews`,
      ),
      options,
    );
  }

  sendMessage(
    orgId: string,
    sessionId: string,
    text: string,
    options: IdempotentRequestOptions,
  ): Promise<{ event: UserMessageEvent }> {
    return this.request(
      this.orgPath(
        orgId,
        `/sessions/${encodeURIComponent(sessionId)}/messages`,
      ),
      {
        method: "POST",
        body: { text },
        idempotencyKey: options.idempotencyKey,
        signal: options.signal,
      },
    );
  }

  replayEvents(
    orgId: string,
    sessionId: string,
    options: EventReplayOptions = {},
  ): Promise<ClientEventPage> {
    const path = this.orgPath(
      orgId,
      `/sessions/${encodeURIComponent(sessionId)}/chat-events`,
    );
    return this.request(
      this.withQuery(path, {
        after: options.after ?? 0,
        limit: options.limit,
      }),
      { signal: options.signal },
    );
  }

  async *streamEvents(
    orgId: string,
    sessionId: string,
    options: Omit<EventReplayOptions, "limit"> = {},
  ): AsyncGenerator<ClientEvent, void, void> {
    const path = this.withQuery(
      this.orgPath(
        orgId,
        `/sessions/${encodeURIComponent(sessionId)}/events`,
      ),
      { after: options.after ?? 0 },
    );
    const response = await this.authorizedFetch(path, {
      headers: { Accept: "text/event-stream" },
      signal: options.signal,
    });
    await this.throwIfError(response);
    if (!response.body) {
      throw this.invalidResponse(
        response.status,
        "Cloud event stream returned no response body.",
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        buffer = buffer.replaceAll("\r\n", "\n");

        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const event = parseSSEBlock(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          if (event) yield event;
          boundary = buffer.indexOf("\n\n");
        }

        if (done) {
          const event = parseSSEBlock(buffer);
          if (event) yield event;
          return;
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  createTerminalTicket(
    orgId: string,
    sessionId: string,
    kind: TerminalKind = "agent",
    options: RequestOptions = {},
  ): Promise<TerminalTicket> {
    return this.request(
      this.orgPath(
        orgId,
        `/sessions/${encodeURIComponent(sessionId)}/terminal-ticket`,
      ),
      { method: "POST", body: { kind }, signal: options.signal },
    );
  }

  terminalUrl(
    ticket: string,
    options: { after?: number; kind?: TerminalKind } = {},
  ): string {
    const url = new URL(`${this.baseUrl}/api/cloud/v1/terminal`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("ticket", ticket);
    url.searchParams.set("after", String(options.after ?? 0));
    url.searchParams.set("kind", options.kind ?? "agent");
    return url.toString();
  }

  listWorkspaceFiles(
    orgId: string,
    sessionId: string,
    path = "",
    options: PaginationOptions = {},
  ): Promise<WorkspaceEntryPage> {
    const endpoint = this.orgPath(
      orgId,
      `/sessions/${encodeURIComponent(sessionId)}/workspace/files`,
    );
    return this.request(
      this.withQuery(endpoint, {
        path,
        cursor: options.cursor,
        limit: options.limit,
      }),
      { signal: options.signal },
    );
  }

  readWorkspaceFile(
    orgId: string,
    sessionId: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<WorkspaceFile> {
    const endpoint = this.orgPath(
      orgId,
      `/sessions/${encodeURIComponent(sessionId)}/workspace/file`,
    );
    return this.request(this.withQuery(endpoint, { path }), options);
  }

  getWorkspaceDiff(
    orgId: string,
    sessionId: string,
    options: RequestOptions = {},
  ): Promise<WorkspaceDiff> {
    return this.request(
      this.orgPath(
        orgId,
        `/sessions/${encodeURIComponent(sessionId)}/workspace/diff`,
      ),
      options,
    );
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

  private orgPath(orgId: string, path: string): string {
    return `/api/cloud/v1/orgs/${encodeURIComponent(orgId)}${path}`;
  }

  private withQuery(
    path: string,
    values: Record<string, string | number | undefined>,
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
      signal: options.signal,
    });
    await this.throwIfError(response);

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

function validateIdempotencyKey(value: string): string {
  const key = value.trim();
  if (!key || key.length > 200) {
    throw new TypeError("idempotencyKey must contain between 1 and 200 characters.");
  }
  return key;
}

function parseSSEBlock(block: string): ClientEvent | undefined {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  return data ? (JSON.parse(data) as ClientEvent) : undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
