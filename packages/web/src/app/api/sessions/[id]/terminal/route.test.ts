import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const { mockIssueTerminalAccess } = vi.hoisted(() => ({
  mockIssueTerminalAccess: vi.fn((id: string) => ({
    sessionId: id,
    projectId: "my-app",
    token: `token-${id}`,
    expiresAt: "2026-04-09T00:00:00.000Z",
  })),
}));

vi.mock("@/lib/server/terminal-auth", () => ({
  TerminalAuthError: class TerminalAuthError extends Error {
    constructor(
      message: string,
      public statusCode: number,
      public code: string,
      public retryAfterSeconds?: number,
    ) {
      super(message);
    }
  },
  issueTerminalAccess: mockIssueTerminalAccess,
}));

import { GET } from "./route";
import { TerminalAuthError } from "@/lib/server/terminal-auth";

function makeRequest(url: string, init?: RequestInit): NextRequest {
  return new NextRequest(
    new URL(url, "http://localhost:3000"),
    init as ConstructorParameters<typeof NextRequest>[1],
  );
}

describe("GET /api/sessions/[id]/terminal", () => {
  const previousTerminalPort = process.env.TERMINAL_PORT;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.TERMINAL_PORT;
  });

  afterEach(() => {
    if (previousTerminalPort === undefined) {
      delete process.env.TERMINAL_PORT;
    } else {
      process.env.TERMINAL_PORT = previousTerminalPort;
    }
  });

  it("returns a signed terminal grant with ttyd URL that omits the token query param", async () => {
    const req = makeRequest("http://localhost:3000/api/sessions/backend-3/terminal");
    const res = await GET(req, { params: Promise.resolve({ id: "backend-3" }) });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      sessionId: string;
      projectId: string;
      token: string;
      expiresAt: string;
      url: string;
    };
    expect(mockIssueTerminalAccess).toHaveBeenCalledWith("backend-3");
    expect(data.sessionId).toBe("backend-3");
    expect(data.projectId).toBe("my-app");
    expect(data.token).toBe("token-backend-3");
    expect(data.expiresAt).toBeTruthy();
    expect(data.url).toContain("http://localhost:14800/terminal");
    expect(data.url).toContain("session=backend-3");
    expect(data.url).not.toContain("token=");
    expect(data.url).not.toContain("token-backend-3");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("uses forwarded protocol and host when present", async () => {
    const req = makeRequest("http://localhost:3000/api/sessions/backend-3/terminal", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "ao.example.com",
      },
    });
    const res = await GET(req, { params: Promise.resolve({ id: "backend-3" }) });
    const data = (await res.json()) as { url: string };
    expect(data.url).toContain("https://ao.example.com:14800/terminal");
  });

  it("strips port from x-forwarded-host when building the ttyd URL", async () => {
    const req = makeRequest("http://localhost:3000/api/sessions/backend-3/terminal", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "ao.example.com:8443",
      },
    });
    const res = await GET(req, { params: Promise.resolve({ id: "backend-3" }) });
    const data = (await res.json()) as { url: string };
    expect(data.url).toContain("https://ao.example.com:14800/terminal");
    expect(data.url).not.toContain("8443");
  });

  it("falls back to request URL protocol when x-forwarded-proto is not http(s)", async () => {
    const req = makeRequest("http://localhost:3000/api/sessions/backend-3/terminal", {
      headers: {
        "x-forwarded-proto": "ws",
        host: "localhost:3000",
      },
    });
    const res = await GET(req, { params: Promise.resolve({ id: "backend-3" }) });
    const data = (await res.json()) as { url: string };
    expect(data.url).toContain("http://localhost:14800/terminal");
  });

  it("uses TERMINAL_PORT when set", async () => {
    process.env.TERMINAL_PORT = "14802";
    const req = makeRequest("http://localhost:3000/api/sessions/backend-3/terminal");
    const res = await GET(req, { params: Promise.resolve({ id: "backend-3" }) });
    const data = (await res.json()) as { url: string };
    expect(data.url).toContain(":14802/terminal");
  });

  it("encodes session id in the ttyd query string", async () => {
    mockIssueTerminalAccess.mockImplementationOnce((id: string) => ({
      sessionId: id,
      projectId: "my-app",
      token: "tok",
      expiresAt: "2026-04-09T00:00:00.000Z",
    }));
    const id = "ao-enc_test";
    const req = makeRequest(`http://localhost:3000/api/sessions/${encodeURIComponent(id)}/terminal`);
    const res = await GET(req, { params: Promise.resolve({ id }) });
    const data = (await res.json()) as { url: string };
    expect(data.url).toContain(`session=${encodeURIComponent(id)}`);
  });

  it("returns auth errors with Retry-After when terminal auth is rate limited", async () => {
    mockIssueTerminalAccess.mockImplementationOnce(() => {
      throw new TerminalAuthError("Too many attempts", 429, "rate_limited", 12);
    });

    const req = makeRequest("http://localhost:3000/api/sessions/backend-3/terminal");
    const res = await GET(req, { params: Promise.resolve({ id: "backend-3" }) });
    const data = (await res.json()) as { code: string };
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("12");
    expect(data.code).toBe("rate_limited");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns 500 for unexpected errors from issueTerminalAccess", async () => {
    mockIssueTerminalAccess.mockImplementationOnce(() => {
      throw new Error("boom");
    });

    const req = makeRequest("http://localhost:3000/api/sessions/backend-3/terminal");
    const res = await GET(req, { params: Promise.resolve({ id: "backend-3" }) });
    const data = (await res.json()) as { error: string };
    expect(res.status).toBe(500);
    expect(data.error).toBe("boom");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
