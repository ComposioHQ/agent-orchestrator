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
  cloudWebMode: mocks.mode,
  githubApiBaseUrl: () => "https://api.example.com",
  localAuthCookie: "ao_cloud_local_session",
}));

import { GET, POST } from "./route";

beforeEach(() => {
  vi.restoreAllMocks();
  mocks.mode.mockReturnValue("staging");
  mocks.withAuth.mockResolvedValue({
    user: { id: "user-1" },
    accessToken: "workos-token",
  });
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
