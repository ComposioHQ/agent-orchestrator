import { NextRequest } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mode: vi.fn<() => "local" | "staging">(),
  withAuth: vi.fn(),
}));

vi.mock("@workos-inc/authkit-nextjs", () => ({
  withAuth: mocks.withAuth,
}));

vi.mock("@/lib/cloud-config", () => ({
  cloudApiBaseUrl: () => "https://staging-api.example.com",
  cloudControlEnvironment: () => "staging",
  cloudWebMode: mocks.mode,
  environmentControlToken: () => "environment-control-token-32-bytes",
  githubApiBaseUrl: () => "https://api.example.com",
  localAuthCookie: "ao_cloud_local_session",
  repositoryBrokerToken: () => "repository-broker-token-32-bytes",
}));

import { DELETE, GET, POST, PUT } from "./route";

beforeEach(() => {
  vi.restoreAllMocks();
  mocks.mode.mockReturnValue("staging");
  mocks.withAuth.mockResolvedValue({
    user: { id: "user-1" },
    accessToken: "workos-token",
  });
});

it("accepts the browser origin that matches the request Host header", async () => {
  mocks.mode.mockReturnValue("local");
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json({
      user: { id: "user-1", email: "user@example.com" },
      organizations: [],
      token: "local-token",
      expiresAt: "2026-09-12T00:00:00Z",
    }),
  );
  const request = new NextRequest(
    "http://localhost:3000/api/cloud/v1/auth/local/login",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000",
      },
      body: JSON.stringify({
        email: "user@example.com",
        password: "password",
      }),
    },
  );

  const response = await POST(request, {
    params: Promise.resolve({ path: ["auth", "local", "login"] }),
  });

  expect(response.status).toBe(200);
  expect(fetchMock).toHaveBeenCalledOnce();
});

it("rejects a browser origin that does not match the request host", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch");
  const request = new NextRequest(
    "http://localhost:3000/api/cloud/v1/auth/local/login",
    {
      method: "POST",
      headers: {
        host: "localhost:3000",
        origin: "https://attacker.example",
      },
      body: "{}",
    },
  );

  const response = await POST(request, {
    params: Promise.resolve({ path: ["auth", "local", "login"] }),
  });

  expect(response.status).toBe(403);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("forwards workspace writes through the authenticated gateway", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json({ path: "README.md", content: "updated\n", size: 8 }),
  );
  const request = new NextRequest(
    "http://localhost:3000/api/cloud/v1/orgs/org-1/sessions/session-1/workspace/file",
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({ path: "README.md", content: "updated\n" }),
    },
  );
  const response = await PUT(request, {
    params: Promise.resolve({
      path: [
        "orgs",
        "org-1",
        "sessions",
        "session-1",
        "workspace",
        "file",
      ],
    }),
  });

  expect(response.status).toBe(200);
  expect(fetchMock).toHaveBeenCalledOnce();
  const [input, init] = fetchMock.mock.calls[0];
  expect(String(input)).toBe(
    "https://staging-api.example.com/api/cloud/v1/orgs/org-1/sessions/session-1/workspace/file",
  );
  expect(init?.method).toBe("PUT");
  expect(new Headers(init?.headers).get("authorization")).toBe(
    "Bearer workos-token",
  );
});

it("brokers GitHub repository imports through production", async () => {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      Response.json({
        organizations: [{ id: "prod-org", slug: "workos-shared" }],
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        organizations: [{ id: "staging-org", slug: "workos-shared" }],
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        items: [
          {
            githubRepositoryId: "9007199254740993",
            name: "cloud",
            htmlUrl: "https://github.com/acme/cloud",
            defaultBranch: "main",
            access: "active",
          },
        ],
      }),
    )
    .mockResolvedValueOnce(
      Response.json(
        {
          project: {
            id: "project-1",
            displayName: "cloud",
          },
        },
        { status: 201 },
      ),
    );
  const request = new NextRequest(
    "http://localhost:3000/api/cloud/v1/orgs/staging-org/github/projects",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "project-key",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        githubRepositoryId: "9007199254740993",
      }),
    },
  );

  const response = await POST(request, {
    params: Promise.resolve({
      path: ["orgs", "staging-org", "github", "projects"],
    }),
  });

  expect(response.status).toBe(201);
  expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
    "https://api.example.com/api/cloud/v1/me",
    "https://staging-api.example.com/api/cloud/v1/me",
    "https://api.example.com/api/cloud/v1/orgs/prod-org/github/repositories?limit=100",
    "https://staging-api.example.com/api/cloud/v1/orgs/staging-org/projects",
  ]);
  const projectRequest = fetchMock.mock.calls[3]?.[1];
  expect(JSON.parse(String(projectRequest?.body))).toEqual({
    displayName: "cloud",
    repositoryUrl: "https://github.com/acme/cloud",
    defaultBranch: "main",
    githubRepositoryId: "9007199254740993",
    config: {},
  });
});

it("keeps scratch capabilities server-side while splitting production and environment writes", async () => {
  const capability = "opaque-production-capability";
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      Response.json({
        organizations: [{ id: "prod-org", slug: "workos-shared" }],
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        organizations: [{ id: "staging-org", slug: "workos-shared" }],
      }),
    )
    .mockResolvedValueOnce(
      Response.json(
        {
          capability,
          githubInstallationId: "7",
          githubRepositoryId: "9",
          userExternalId: "workos-user",
          targetEnvironment: "staging",
        },
        { status: 201 },
      ),
    )
    .mockResolvedValueOnce(
      Response.json(
        {
          project: { id: "project-1" },
          session: { id: "session-1" },
        },
        { status: 201 },
      ),
    );
  const request = new NextRequest(
    "http://localhost:3000/api/cloud/v1/orgs/staging-org/projects/scratch",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "scratch-key",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        displayName: "Private work",
        githubInstallationId: "7",
        orchestrator: { harness: "cursor" },
      }),
    },
  );

  const response = await POST(request, {
    params: Promise.resolve({
      path: ["orgs", "staging-org", "projects", "scratch"],
    }),
  });

  expect(response.status).toBe(201);
  expect(await response.text()).not.toContain(capability);
  expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
    "https://api.example.com/api/cloud/v1/me",
    "https://staging-api.example.com/api/cloud/v1/me",
    "https://api.example.com/api/cloud/v1/orgs/prod-org/github/scratch-capabilities",
    "https://staging-api.example.com/api/cloud/v1/control/github/scratch-projects",
  ]);
  const controlRequest = fetchMock.mock.calls[3]?.[1];
  const capabilityRequest = fetchMock.mock.calls[2]?.[1];
  expect(new Headers(capabilityRequest?.headers).get("authorization")).toBe(
    "Bearer repository-broker-token-32-bytes",
  );
  expect(
    new Headers(capabilityRequest?.headers).get("x-ao-user-authorization"),
  ).toBe("Bearer workos-token");
  expect(new Headers(controlRequest?.headers).get("authorization")).toBe(
    "Bearer environment-control-token-32-bytes",
  );
  expect(String(controlRequest?.body)).toContain(capability);
});

it("compensates the production repository when environment persistence fails", async () => {
  const capability = "opaque-production-capability";
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      Response.json({
        organizations: [{ id: "prod-org", slug: "workos-shared" }],
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        organizations: [{ id: "staging-org", slug: "workos-shared" }],
      }),
    )
    .mockResolvedValueOnce(
      Response.json(
        {
          capability,
          githubInstallationId: "7",
          githubRepositoryId: "9",
          userExternalId: "workos-user",
          targetEnvironment: "staging",
        },
        { status: 201 },
      ),
    )
    .mockResolvedValueOnce(
      Response.json({ code: "SANDBOX_QUOTA_EXCEEDED" }, { status: 409 }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  const request = new NextRequest(
    "http://localhost:3000/api/cloud/v1/orgs/staging-org/projects/scratch",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "scratch-key",
      },
      body: JSON.stringify({
        displayName: "Private work",
        githubInstallationId: "7",
        orchestrator: { harness: "cursor" },
      }),
    },
  );

  const response = await POST(request, {
    params: Promise.resolve({
      path: ["orgs", "staging-org", "projects", "scratch"],
    }),
  });

  expect(response.status).toBe(409);
  expect(String(fetchMock.mock.calls[4]?.[0])).toBe(
    "https://api.example.com/api/cloud/v1/orgs/prod-org/github/scratch-capabilities/revoke",
  );
  expect(fetchMock.mock.calls[4]?.[1]?.body).toBe(
    JSON.stringify({ capability }),
  );
});

it("requires hosted auth before local GitHub broker requests", async () => {
  mocks.mode.mockReturnValue("local");
  mocks.withAuth.mockResolvedValue({ user: null, accessToken: undefined });
  const request = new NextRequest(
    "http://localhost:3000/api/cloud/v1/orgs/local-org/github/repositories",
    {
      headers: {
        cookie: "ao_cloud_local_session=local-token",
      },
    },
  );

  const response = await GET(request, {
    params: Promise.resolve({
      path: ["orgs", "local-org", "github", "repositories"],
    }),
  });

  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toMatchObject({
    code: "GITHUB_AUTH_REQUIRED",
  });
});

it("brokers account-wide GitHub authorization and revocation through production", async () => {
  mocks.mode.mockReturnValue("local");
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(null, { status: 204 }),
  );
  const request = new NextRequest(
    "http://localhost:3000/api/cloud/v1/github/user",
    {
      method: "DELETE",
      headers: {
        cookie: "ao_cloud_local_session=local-token",
        origin: "http://localhost:3000",
      },
    },
  );

  const response = await DELETE(request, {
    params: Promise.resolve({ path: ["github", "user"] }),
  });

  expect(response.status).toBe(204);
  expect(fetchMock).toHaveBeenCalledOnce();
  const [input, init] = fetchMock.mock.calls[0];
  expect(String(input)).toBe("https://api.example.com/api/cloud/v1/github/user");
  expect(init?.method).toBe("DELETE");
  expect(new Headers(init?.headers).get("authorization")).toBe(
    "Bearer workos-token",
  );
});
