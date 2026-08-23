import { describe, expect, it, vi } from "vitest";

import {
  ORGANIZATION_HEADER,
  organizationHeaders,
  CloudApiError,
  createCloudClient,
  createSandboxClient,
  createWorkerClient,
  type AgentProfile,
  type Project,
  type TerminalConnection,
  type TerminalTicket,
} from "../src/index.js";

describe("CloudClient", () => {
  it("exchanges Google identity without sending an AO bearer token", async () => {
    const session = {
      accessToken: "ao-access-token",
      refreshToken: "ao_refresh_token",
      expiresAt: "2026-08-19T20:00:00Z",
      user: {
        id: "aa4c5117-d075-4a4e-a384-149e75f7dc45",
        email: "alice@example.com",
        displayName: "Alice",
        authProvider: "google",
      },
      organizations: [],
    } as const;
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse(session),
    );
    const client = createCloudClient({
      baseUrl: "https://cloud.example.com",
      getAccessToken: () => null,
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      client.exchangeGoogleIdentity({ idToken: "google-id-token" }),
    ).resolves.toEqual(session);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://cloud.example.com/api/cloud/v1/auth/google",
    );
    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    expect(init?.cache).toBe("no-store");
  });

  it("loads the authenticated account and organization memberships", async () => {
    const account = {
      user: {
        id: "aa4c5117-d075-4a4e-a384-149e75f7dc45",
        email: "alice@example.com",
        displayName: "Alice",
        authProvider: "workos",
      },
      organizations: [
        {
          id: "4165753c-c6ad-4ac2-8f12-e0cbb24d9750",
          slug: "acme",
          displayName: "Acme",
          role: "admin",
        },
      ],
    } as const;
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse(account),
    );
    const client = createCloudClient({
      baseUrl: "https://cloud.example.com",
      getAccessToken: () => "access-token",
      fetch: fetchMock as typeof fetch,
    });

    await expect(client.getCurrentAccount()).resolves.toEqual(account);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://cloud.example.com/api/cloud/v1/me",
    );
  });

  it("uses the shared /api/v1 project and session contracts with tenant scope", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ projects: [], sessions: [], status: "ok" }),
    );
    const client = createCloudClient({
      baseUrl: "https://cloud.example.com",
      getAccessToken: () => "access-token",
      fetch: fetchMock as typeof fetch,
    });

    await client.listAppProjects("org one");
    await client.getAppProject("org one", "project one");
    await client.listSessions("org one", {
      project: "project one",
      active: true,
      orchestratorOnly: false,
      fresh: true,
    });
    await client.spawnSession("org one", {
      projectId: "project one",
      harness: "claude-code",
      prompt: "Ship it",
    });
    await client.getSession("org one", "session one");
    await client.killSession("org one", "session one");
    await client.restoreSession("org one", "session one");
    await client.sendMessage("org one", "session one", {
      message: "Status?",
    });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://cloud.example.com/api/v1/projects",
      "https://cloud.example.com/api/v1/projects/project%20one",
      "https://cloud.example.com/api/v1/sessions?project=project+one&active=true&orchestratorOnly=false&fresh=true",
      "https://cloud.example.com/api/v1/sessions",
      "https://cloud.example.com/api/v1/sessions/session%20one",
      "https://cloud.example.com/api/v1/sessions/session%20one/kill",
      "https://cloud.example.com/api/v1/sessions/session%20one/restore",
      "https://cloud.example.com/api/v1/sessions/session%20one/send",
    ]);
    expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual([
      "GET",
      "GET",
      "GET",
      "POST",
      "GET",
      "POST",
      "POST",
      "POST",
    ]);
    for (const call of fetchMock.mock.calls) {
      expect(new Headers(call[1]?.headers).get(ORGANIZATION_HEADER)).toBe(
        "org one",
      );
    }
    expect(JSON.parse(String(fetchMock.mock.calls[7]?.[1]?.body))).toEqual({
      message: "Status?",
    });
  });

  it("requests durable project deletion on the project resource", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse(
          { project: { id: "project one", deleted: true } },
          202,
        ),
    );
    const client = createCloudClient({
      baseUrl: "https://cloud.example.com",
      getAccessToken: () => "access-token",
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      client.deleteProject("org one", "project one", {
        idempotencyKey: "delete-project-1",
      }),
    ).resolves.toEqual({
      project: { id: "project one", deleted: true },
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://cloud.example.com/api/cloud/v1/orgs/org%20one/projects/project%20one",
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("DELETE");
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Idempotency-Key"),
    ).toBe("delete-project-1");
  });

  it("reads one project and resumes a suspended project workspace", async () => {
    const suspended = {
      id: "project one",
      orgId: "aa4c5117-d075-4a4e-a384-149e75f7dc45",
      displayName: "Cloud API",
      repositoryUrl: "https://github.com/acme/cloud-api",
      defaultBranch: "main",
      config: {},
      createdAt: "2026-08-19T20:00:00Z",
      updatedAt: "2026-08-19T20:00:00Z",
      lifecycleState: "suspended",
    } as const satisfies Project;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) =>
        String(input).endsWith("/resume")
          ? jsonResponse(
              { project: { ...suspended, lifecycleState: "provisioning" } },
              202,
            )
          : jsonResponse({ project: suspended }),
    );
    const client = createCloudClient({
      baseUrl: "https://cloud.example.com",
      getAccessToken: () => "access-token",
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      client.getProject("org one", "project one"),
    ).resolves.toEqual({ project: suspended });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://cloud.example.com/api/cloud/v1/orgs/org%20one/projects/project%20one",
    );

    const resumed = await client.resumeProject("org one", "project one", {
      idempotencyKey: "resume-project-1",
    });
    expect(resumed.project.lifecycleState).toBe("provisioning");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://cloud.example.com/api/cloud/v1/orgs/org%20one/projects/project%20one/resume",
    );
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({});
    expect(
      new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Idempotency-Key"),
    ).toBe("resume-project-1");
  });

  it("mints a scoped terminal ticket and attaches to the listener it names", async () => {
    const connection: TerminalConnection = {
      transport: "websocket",
      protocol: "ao.mux.v1",
      url: "https://terminals.cloud.example.com/attach?region=us-east-1",
      kinds: ["agent", "workspace"],
      features: ["input", "resize", "replay"],
      maxFrameBytes: 16384,
    };
    const ticket: TerminalTicket = {
      ticket: "tkt_live",
      expiresIn: 30,
      scopes: ["terminal:read"],
      sessionId: "a9dc6493-bd04-4c03-bb45-55733ed83784",
      kind: "agent",
      connection,
      lastSequence: 4211,
    };
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse(ticket, 201),
    );
    const client = createCloudClient({
      baseUrl: "https://cloud.example.com",
      getAccessToken: () => "access-token",
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      client.createTerminalTicket("org one", "session one", "agent", {
        scopes: ["terminal:read", "terminal:operate"],
      }),
    ).resolves.toEqual(ticket);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://cloud.example.com/api/cloud/v1/orgs/org%20one/sessions/session%20one/terminal-ticket",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      kind: "agent",
      scopes: ["terminal:read", "terminal:operate"],
    });
    // The mint response carries a ticket; it must never be cached.
    expect(fetchMock.mock.calls[0]?.[1]?.cache).toBe("no-store");

    // The listener is not the API origin, and its own query is preserved.
    const url = client.terminalUrl({
      connection,
      after: ticket.lastSequence,
    });
    expect(url).toBe(
      "wss://terminals.cloud.example.com/attach?region=us-east-1&after=4211",
    );
    // The ticket must not reach the URL: a query string lands in proxy logs,
    // browser history and referrers.
    expect(url).not.toContain("tkt_live");

    expect(client.terminalSubprotocols(ticket)).toEqual([
      "ao.mux.v1",
      "ao.ticket.tkt_live",
    ]);
  });

  it("falls back to the control-plane terminal route and default subprotocols", () => {
    const client = createCloudClient({
      baseUrl: "https://cloud.example.com",
      getAccessToken: () => "access-token",
      fetch: vi.fn() as unknown as typeof fetch,
    });

    expect(client.terminalUrl()).toBe(
      "wss://cloud.example.com/api/cloud/v1/terminal",
    );
    // A server that reported no connection still gets the documented defaults.
    expect(
      client.terminalSubprotocols({
        ticket: "tkt_live",
        expiresIn: 30,
        scopes: ["terminal:operate"],
      }),
    ).toEqual(["ao.mux.v1", "ao.ticket.tkt_live"]);
  });

  it("honours a listener that versions its ticket subprotocol prefix", () => {
    const client = createCloudClient({
      baseUrl: "https://cloud.example.com",
      getAccessToken: () => "access-token",
      fetch: vi.fn() as unknown as typeof fetch,
    });

    expect(
      client.terminalSubprotocols({
        ticket: "tkt_live",
        expiresIn: 30,
        scopes: ["terminal:operate"],
        connection: {
          transport: "websocket",
          protocol: "ao.mux.v1",
          url: "wss://terminals.example.com/attach",
          kinds: ["workspace"],
          features: [],
          ticketSubprotocolPrefix: "ao.ticket2.",
        },
      }),
    ).toEqual(["ao.mux.v1", "ao.ticket2.tkt_live"]);
  });

  it("lists runtime-supplied agent profiles for an organization", async () => {
    const profile: AgentProfile = {
      id: "runtime-agent",
      label: "Runtime Agent",
      capabilities: ["interface.chat", "model.custom"],
      availability: {
        available: false,
        installation: "installed",
        authentication: "unauthorized",
        organizationPolicy: "denied",
        reason: "Disabled for this organization.",
      },
    };
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ agents: [profile] }),
    );
    const client = createCloudClient({
      baseUrl: "https://cloud.example.com",
      getAccessToken: () => "access-token",
      fetch: fetchMock as typeof fetch,
    });

    await expect(client.listAgents("tenant one/blue")).resolves.toEqual([
      profile,
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://cloud.example.com/api/cloud/v1/orgs/tenant%20one%2Fblue/agents",
    );
  });

  it("uses the canonical tenant-scoped GitHub App routes", async () => {
    const installation = {
      id: "installation-1",
      orgId: "tenant one",
      provider: "github",
      accountLogin: "acme",
      accountType: "Organization",
      appSlug: "ao",
      repositorySelection: "selected",
      status: "active",
      createdAt: "2026-08-11T00:00:00Z",
      updatedAt: "2026-08-11T00:00:00Z",
    } as const;
    const repositories = {
      repositories: [
        {
          id: "repository-1",
          fullName: "acme/api",
          private: true,
          allowed: true,
        },
      ],
    };
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse({ installations: [installation] }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            installUrl: "https://github.com/apps/ao/installations/new",
            expiresAt: "2026-08-11T00:10:00Z",
          },
          201,
        ),
      )
      .mockResolvedValueOnce(jsonResponse(repositories))
      .mockResolvedValueOnce(jsonResponse(repositories))
      .mockResolvedValueOnce(jsonResponse(repositories))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createCloudClient({
      baseUrl: "https://cloud.example.com",
      getAccessToken: () => "access-token",
      fetch: fetchMock as typeof fetch,
    });

    await expect(client.listGitHubInstallations("tenant one")).resolves.toEqual([
      installation,
    ]);
    await client.startGitHubInstallation("tenant one");
    await client.listGitHubRepositories("tenant one", "installation one");
    await client.syncGitHubRepositories("tenant one", "installation one");
    await client.setGitHubRepositoryAllowlist(
      "tenant one",
      "installation one",
      { repositories: ["acme/api"] },
    );
    await client.disconnectGitHubInstallation(
      "tenant one",
      "installation one",
    );

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://cloud.example.com/api/cloud/v1/scm/github/installations",
      "https://cloud.example.com/api/cloud/v1/scm/github/installations",
      "https://cloud.example.com/api/cloud/v1/scm/github/installations/installation%20one/repositories",
      "https://cloud.example.com/api/cloud/v1/scm/github/installations/installation%20one/repositories/sync",
      "https://cloud.example.com/api/cloud/v1/scm/github/installations/installation%20one/allowlist",
      "https://cloud.example.com/api/cloud/v1/scm/github/installations/installation%20one",
    ]);
    expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual([
      "GET",
      "POST",
      "GET",
      "POST",
      "PUT",
      "DELETE",
    ]);
    for (let index = 0; index < fetchMock.mock.calls.length; index += 1) {
      expect(requestHeaders(fetchMock, index).get(ORGANIZATION_HEADER)).toBe(
        "tenant one",
      );
    }
    expect(JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body))).toEqual({
      repositories: ["acme/api"],
    });
  });

  it("scopes and encodes organization and session URLs", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ project: {} }),
    );
    const client = createCloudClient({
      baseUrl: "https://cloud.example.com/",
      getAccessToken: () => "access-token",
      fetch: fetchMock as typeof fetch,
    });

    await client.getProject("tenant one/blue", "project one?");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://cloud.example.com/api/cloud/v1/orgs/tenant%20one%2Fblue/projects/project%20one%3F",
    );
  });

  it("injects the latest access token into every request", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ providerConnections: [] }),
    );
    const getAccessToken = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("first-token")
      .mockResolvedValueOnce("second-token");
    const client = createCloudClient({
      baseUrl: "https://cloud.example.com",
      getAccessToken,
      fetch: fetchMock as typeof fetch,
    });

    await client.listProviderConnections("tenant");
    await client.listProviderConnections("tenant");

    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(requestHeaders(fetchMock, 0).get("Authorization")).toBe(
      "Bearer first-token",
    );
    expect(requestHeaders(fetchMock, 1).get("Authorization")).toBe(
      "Bearer second-token",
    );
  });

  it("connects and disconnects coding-agent credentials", async () => {
    const providerConnection = {
      id: "connection-1",
      provider: "claude-code",
      label: "default",
      config: { credentialType: "api_key" },
      validationState: "valid",
      validatedAt: "2026-08-12T00:00:00Z",
      createdAt: "2026-08-12T00:00:00Z",
      updatedAt: "2026-08-12T00:00:00Z",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ providerConnection }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createCloudClient({
      baseUrl: "https://cloud.example.com",
      getAccessToken: () => "access-token",
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      client.putAgentProviderConnection("tenant", "claude-code", {
        credentialType: "api_key",
        secret: "secret-value",
      }),
    ).resolves.toEqual({ providerConnection });
    await expect(
      client.deleteAgentProviderConnection("tenant", "claude-code"),
    ).resolves.toBeUndefined();

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://cloud.example.com/api/cloud/v1/orgs/tenant/provider-connections/agents/claude-code",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({
        credentialType: "api_key",
        secret: "secret-value",
      }),
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
  });

  it("throws a typed error with the standard error envelope", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse(
          {
            error: "Conflict",
            code: "IDEMPOTENCY_CONFLICT",
            message: "That key was used for a different command.",
            requestId: "request-123",
            details: { field: "Idempotency-Key" },
          },
          409,
        ),
    );
    const client = createCloudClient({
      baseUrl: "https://cloud.example.com",
      getAccessToken: () => "access-token",
      fetch: fetchMock as typeof fetch,
    });

    const request = client.resumeProject("tenant", "project", {
      idempotencyKey: "resume-1",
    });

    const error: unknown = await request.catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(CloudApiError);
    expect(error).toMatchObject({
      name: "CloudApiError",
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
      requestId: "request-123",
      details: { field: "Idempotency-Key" },
    });
  });

  it("sends idempotency keys on mutating commands", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ project: { id: "project" } }, 202),
    );
    const client = createCloudClient({
      baseUrl: "https://cloud.example.com",
      getAccessToken: () => "access-token",
      fetch: fetchMock as typeof fetch,
    });

    await client.resumeProject("tenant", "project", {
      idempotencyKey: "placement-command-1",
    });

    expect(requestHeaders(fetchMock, 0).get("Idempotency-Key")).toBe(
      "placement-command-1",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({}),
    });
  });

});

describe("SandboxClient", () => {
  it("redeems a sandbox ticket with the rotating sandbox capability", async () => {
    const grant = {
      sandboxId: "sandbox-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      scopes: ["terminal:read"],
      expiresAt: "2026-08-23T21:00:00Z",
    } as const;
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () => jsonResponse(grant));
    const client = createSandboxClient({
      baseUrl: "https://cloud.example.com",
      getCapability: () => "sandbox-capability",
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      client.redeemSandboxTicket({
        ticket: "one-time-ticket",
        sandboxId: grant.sandboxId,
        workspaceId: grant.workspaceId,
        sessionId: grant.sessionId,
      }),
    ).resolves.toEqual(grant);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://cloud.example.com/api/cloud/v1/sandbox/terminal-tickets/consume",
    );
    expect(requestHeaders(fetchMock, 0).get("Authorization")).toBe(
      "Bearer sandbox-capability",
    );
    expect(fetchMock.mock.calls[0]?.[1]?.cache).toBe("no-store");
  });
});

describe("WorkerClient", () => {
  it("matches the worker lifecycle, execution, orchestration, and transport routes", async () => {
    const turn = {
      id: "1933df78-7495-492a-bfde-31448c448e12",
      prompt: "fix auth",
      mode: "standard",
      deniedCommands: [],
      harness: "claude-code",
      attempt: 2,
      cancelRequested: false,
    };
    const transport = {
      id: "3d75e11c-c450-4d7e-8daf-ab2af9087c8f",
      kind: "workspace.read",
      attempt: 2,
      payload: { path: "README.md" },
    };
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        jsonResponse({
          workerToken: "[redacted-bootstrap-token]",
          workerId: "session:4",
          epoch: 4,
          expiresIn: 900,
          sessionId: "678ae2c1-d9d3-4f87-be65-338818505299",
          launch: {
            sessionId: "678ae2c1-d9d3-4f87-be65-338818505299",
            projectId: "fb351a69-df93-40ab-8982-bd5ea3a231eb",
            kind: "worker",
            harness: "claude-code",
            displayName: "Auth",
            branch: "feat/auth",
            repositoryUrl: "https://github.com/acme/api",
            defaultBranch: "main",
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          workerToken: "[redacted-renewed-token]",
          expiresIn: 900,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }, 202))
      .mockResolvedValueOnce(jsonResponse({ turn }))
      .mockResolvedValueOnce(jsonResponse({ requested: false }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, alreadyFinished: false }))
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, alreadyFinished: false }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          provider: "claude-code",
          credentialType: "api_key",
          secret: "[redacted-agent-secret]",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          cloneUrl: "https://github.com/acme/api.git",
          token: "[redacted-checkout-token]",
          expiresAt: "2026-08-12T12:00:00Z",
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ items: [], page: { hasMore: false } }))
      .mockResolvedValueOnce(jsonResponse({ session: { id: "child" } }, 201))
      .mockResolvedValueOnce(jsonResponse({ event: { sequence: 1 } }, 202))
      .mockResolvedValueOnce(
        jsonResponse(
          { session: { id: "child", desiredState: "deleted" } },
          202,
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ request: transport }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ terminalId: "agent-terminal" }))
      .mockResolvedValueOnce(jsonResponse({ sequence: 7 }, 202))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = createWorkerClient({
      baseUrl: "https://cloud.example.com",
      getWorkerToken: () => "worker-token",
      fetch: fetchMock as typeof fetch,
    });

    await client.bootstrap({
      bootstrapToken: "[redacted-one-time-ticket]",
      version: "0.1.0",
      capabilities: ["worker.turns"],
    });
    await client.heartbeat({
      version: "0.1.0",
      capabilities: ["worker.turns"],
    });
    await client.publishEvent({
      type: "chat.assistant_delta",
      payload: {
        turnId: turn.id,
        attempt: turn.attempt,
        stream: "stdout",
        text: "done",
      },
    });
    await expect(client.claimTurn()).resolves.toEqual(turn);
    await client.getTurnCancellation(turn.id, turn.attempt);
    await client.completeTurn(turn.id, { attempt: turn.attempt });
    await client.failTurn(turn.id, {
      attempt: turn.attempt,
      error: "harness exited",
    });
    await client.getCredential();
    await client.createCheckoutGrant();
    await client.listChildren({ cursor: "next page", limit: 25 });
    await client.createChild(
      { harness: "codex", displayName: "Child", prompt: "inspect auth" },
      { idempotencyKey: "child-1" },
    );
    await client.sendChildMessage("child one", "Report status", {
      idempotencyKey: "message-1",
    });
    await client.deleteChild("child one");
    await expect(client.claimTransport()).resolves.toEqual(transport);
    await client.completeTransport(transport.id, {
      attempt: transport.attempt,
      response: { path: "README.md", content: "# API", size: 5 },
    });
    await client.failTransport("request one", {
      attempt: 3,
      code: "WORKER_OPERATION_FAILED",
      message: "Operation failed.",
    });
    await expect(client.ensureAgentTerminal()).resolves.toEqual({
      terminalId: "agent-terminal",
    });
    await client.publishTerminalOutput("terminal one", { data: "b2sK" });
    await client.publishTerminalExit("terminal one", { exitCode: 0 });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://cloud.example.com/api/cloud/v1/worker/bootstrap",
      "https://cloud.example.com/api/cloud/v1/worker/heartbeat",
      "https://cloud.example.com/api/cloud/v1/worker/events",
      "https://cloud.example.com/api/cloud/v1/worker/turns/claim",
      `https://cloud.example.com/api/cloud/v1/worker/turns/${turn.id}/cancellation?attempt=2`,
      `https://cloud.example.com/api/cloud/v1/worker/turns/${turn.id}/complete`,
      `https://cloud.example.com/api/cloud/v1/worker/turns/${turn.id}/fail`,
      "https://cloud.example.com/api/cloud/v1/worker/credential",
      "https://cloud.example.com/api/cloud/v1/worker/checkout-grant",
      "https://cloud.example.com/api/cloud/v1/worker/children?cursor=next+page&limit=25",
      "https://cloud.example.com/api/cloud/v1/worker/children",
      "https://cloud.example.com/api/cloud/v1/worker/children/child%20one/messages",
      "https://cloud.example.com/api/cloud/v1/worker/children/child%20one",
      "https://cloud.example.com/api/cloud/v1/worker/transport/claim",
      `https://cloud.example.com/api/cloud/v1/worker/transport/${transport.id}/complete`,
      "https://cloud.example.com/api/cloud/v1/worker/transport/request%20one/fail",
      "https://cloud.example.com/api/cloud/v1/worker/terminals/agent",
      "https://cloud.example.com/api/cloud/v1/worker/terminals/terminal%20one/output",
      "https://cloud.example.com/api/cloud/v1/worker/terminals/terminal%20one/exit",
    ]);
    expect(requestHeaders(fetchMock, 0).has("Authorization")).toBe(false);
    for (let index = 1; index < fetchMock.mock.calls.length; index += 1) {
      expect(requestHeaders(fetchMock, index).get("Authorization")).toBe(
        "Worker worker-token",
      );
    }
    expect(fetchMock.mock.calls[0]?.[1]?.cache).toBe("no-store");
    expect(fetchMock.mock.calls[1]?.[1]?.cache).toBe("no-store");
    expect(fetchMock.mock.calls[7]?.[1]?.cache).toBe("no-store");
    expect(fetchMock.mock.calls[8]?.[1]?.cache).toBe("no-store");
    expect(requestHeaders(fetchMock, 10).get("Idempotency-Key")).toBe("child-1");
    expect(requestHeaders(fetchMock, 11).get("Idempotency-Key")).toBe(
      "message-1",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[5]?.[1]?.body))).toEqual({
      attempt: 2,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[14]?.[1]?.body))).toEqual({
      attempt: 2,
      response: { path: "README.md", content: "# API", size: 5 },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[15]?.[1]?.body))).toEqual({
      attempt: 3,
      code: "WORKER_OPERATION_FAILED",
      message: "Operation failed.",
    });
  });

  it("unwraps empty claims from HTTP 200 response bodies", async () => {
    const client = createWorkerClient({
      baseUrl: "https://cloud.example.com",
      getWorkerToken: () => "worker-token",
      fetch: vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ turn: null }))
        .mockResolvedValueOnce(
          jsonResponse({ request: null }),
        ) as typeof fetch,
    });

    await expect(client.claimTurn()).resolves.toBeNull();
    await expect(client.claimTransport()).resolves.toBeNull();
  });
});

describe("organizationHeaders", () => {
  it("names the header once so hosts cannot drift to three spellings", () => {
    expect(ORGANIZATION_HEADER).toBe("X-AO-Org");
    expect(organizationHeaders("4165753c-c6ad-4ac2-8f12-e0cbb24d9750")).toEqual({
      "X-AO-Org": "4165753c-c6ad-4ac2-8f12-e0cbb24d9750",
    });
    // A slug is accepted too: the server takes either.
    expect(organizationHeaders("acme")).toEqual({ "X-AO-Org": "acme" });
  });

  it("omits the header when there is no organization to name", () => {
    // A caller with a single active membership may leave it off entirely, so
    // an absent value must produce no header rather than an empty one — an
    // empty header is a value the server would have to reject.
    expect(organizationHeaders()).toEqual({});
    expect(organizationHeaders(null)).toEqual({});
    expect(organizationHeaders("   ")).toEqual({});
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestHeaders(
  fetchMock: ReturnType<typeof vi.fn>,
  call: number,
): Headers {
  return new Headers((fetchMock.mock.calls[call]?.[1] as RequestInit).headers);
}
