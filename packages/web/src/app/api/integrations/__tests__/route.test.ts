import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockExecFileAsync } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
}));

vi.mock("node:child_process", () => {
  const fakeExecFile = Object.assign(
    (...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === "function") {
        mockExecFileAsync(...args.slice(0, -1))
          .then((result: unknown) => (cb as (err: null, r: unknown) => void)(null, result))
          .catch((err: unknown) => (cb as (err: unknown) => void)(err));
      }
    },
    { __promisify__: mockExecFileAsync },
  );
  return { execFile: fakeExecFile, default: { execFile: fakeExecFile } };
});

import { GET } from "../route";

const ENV_KEYS = ["GITHUB_TOKEN", "GH_TOKEN", "LINEAR_API_KEY", "SLACK_WEBHOOK_URL"] as const;
const savedEnv: Record<string, string | undefined> = {};

function clearEnvKey(key: string): void {
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete process.env[key];
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    clearEnvKey(key);
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key];
    } else {
      clearEnvKey(key);
    }
  }
});

describe("GET /api/integrations", () => {
  it("returns all disconnected when no env vars and gh auth fails", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("not logged in"));

    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.integrations).toHaveLength(3);
    expect(data.integrations[0]).toMatchObject({ name: "GitHub", connected: false });
    expect(data.integrations[1]).toMatchObject({ name: "Linear", connected: false });
    expect(data.integrations[2]).toMatchObject({ name: "Slack", connected: false });
  });

  it("detects GitHub via GITHUB_TOKEN env var", async () => {
    process.env.GITHUB_TOKEN = "ghp_test123";
    mockExecFileAsync.mockRejectedValue(new Error("not logged in"));

    const res = await GET();
    const data = await res.json();
    expect(data.integrations[0]).toMatchObject({ name: "GitHub", connected: true });
  });

  it("detects GitHub via GH_TOKEN env var", async () => {
    process.env.GH_TOKEN = "ghp_test123";
    mockExecFileAsync.mockRejectedValue(new Error("not logged in"));

    const res = await GET();
    const data = await res.json();
    expect(data.integrations[0]).toMatchObject({ name: "GitHub", connected: true });
  });

  it("detects GitHub via gh auth status", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

    const res = await GET();
    const data = await res.json();
    expect(data.integrations[0]).toMatchObject({ name: "GitHub", connected: true });
  });

  it("detects Linear via LINEAR_API_KEY", async () => {
    process.env.LINEAR_API_KEY = "lin_api_test";
    mockExecFileAsync.mockRejectedValue(new Error("not logged in"));

    const res = await GET();
    const data = await res.json();
    expect(data.integrations[1]).toMatchObject({ name: "Linear", connected: true });
  });

  it("detects Slack via SLACK_WEBHOOK_URL", async () => {
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/test";
    mockExecFileAsync.mockRejectedValue(new Error("not logged in"));

    const res = await GET();
    const data = await res.json();
    expect(data.integrations[2]).toMatchObject({ name: "Slack", connected: true });
  });

  it("returns all connected when everything is configured", async () => {
    process.env.GITHUB_TOKEN = "ghp_test";
    process.env.LINEAR_API_KEY = "lin_api_test";
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/test";
    mockExecFileAsync.mockRejectedValue(new Error("not logged in"));

    const res = await GET();
    const data = await res.json();
    for (const integration of data.integrations) {
      expect(integration.connected).toBe(true);
    }
  });
});
