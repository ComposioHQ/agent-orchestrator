import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RuntimeHandle } from "@composio/ao-core";

/** Build a mock fetch that returns a successful Cloudflare API response */
function mockCfOk<T>(result: T) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () =>
      Promise.resolve({ success: true, result, errors: [], messages: [] }),
    text: () => Promise.resolve(""),
  });
}

/** Build a mock fetch that returns a Cloudflare API error */
function mockCfHttpError(status: number, body = "error") {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: "Error",
    text: () => Promise.resolve(body),
  });
}

function makeHandle(
  id = "container-abc",
  accountId = "acct-123",
  createdAt?: number,
): RuntimeHandle {
  return {
    id,
    runtimeName: "cloudflare",
    data: {
      accountId,
      createdAt: createdAt ?? 1000,
      workspacePath: "/tmp/workspace",
    },
  };
}

import pluginDefault, { manifest, create } from "./index.js";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env["CLOUDFLARE_API_TOKEN"] = "test-token";
  process.env["CLOUDFLARE_ACCOUNT_ID"] = "acct-123";
});

describe("manifest", () => {
  it("has name 'cloudflare' and slot 'runtime'", () => {
    expect(manifest.name).toBe("cloudflare");
    expect(manifest.slot).toBe("runtime");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.description).toBe(
      "Runtime plugin: Cloudflare Workers / Containers",
    );
  });

  it("default export includes manifest and create", () => {
    expect(pluginDefault.manifest).toBe(manifest);
    expect(pluginDefault.create).toBe(create);
  });
});

describe("create()", () => {
  it("returns a Runtime with name 'cloudflare'", () => {
    const runtime = create();
    expect(runtime.name).toBe("cloudflare");
  });
});

describe("runtime.create()", () => {
  it("POSTs to the containers API and returns a handle", async () => {
    const fetchMock = mockCfOk({ id: "ctr-abc", status: "running" });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    const handle = await runtime.create({
      sessionId: "test-session",
      workspacePath: "/tmp/ws",
      launchCommand: "node app.js",
      environment: { FOO: "bar" },
    });

    expect(handle.id).toBe("ctr-abc");
    expect(handle.runtimeName).toBe("cloudflare");
    expect(handle.data["accountId"]).toBe("acct-123");
    expect(handle.data["workspacePath"]).toBe("/tmp/ws");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct-123/containers",
    );
    expect(opts.method).toBe("POST");
    expect(opts.headers["Authorization"]).toBe("Bearer test-token");

    const body = JSON.parse(opts.body);
    expect(body.name).toBe("ao-test-session");
    expect(body.image).toBe("ubuntu:22.04");
    expect(body.command).toEqual(["sh", "-c", "node app.js"]);
  });

  it("passes environment variables in the request body", async () => {
    const fetchMock = mockCfOk({ id: "ctr-xyz", status: "running" });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    await runtime.create({
      sessionId: "env-test",
      workspacePath: "/workspace",
      launchCommand: "bash",
      environment: { KEY: "value", ANOTHER: "val2" },
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const envNames = body.environment_variables.map(
      (e: { name: string }) => e.name,
    );
    expect(envNames).toContain("KEY");
    expect(envNames).toContain("ANOTHER");
    expect(envNames).toContain("AO_SESSION_ID");
    expect(envNames).toContain("AO_WORKSPACE");
  });

  it("throws when CLOUDFLARE_API_TOKEN is missing", async () => {
    delete process.env["CLOUDFLARE_API_TOKEN"];
    const runtime = create();

    await expect(
      runtime.create({
        sessionId: "s1",
        workspacePath: "/tmp",
        launchCommand: "echo",
        environment: {},
      }),
    ).rejects.toThrow("CLOUDFLARE_API_TOKEN environment variable is required");
  });

  it("throws when CLOUDFLARE_ACCOUNT_ID is missing", async () => {
    delete process.env["CLOUDFLARE_ACCOUNT_ID"];
    const runtime = create();

    await expect(
      runtime.create({
        sessionId: "s1",
        workspacePath: "/tmp",
        launchCommand: "echo",
        environment: {},
      }),
    ).rejects.toThrow(
      "CLOUDFLARE_ACCOUNT_ID environment variable is required",
    );
  });

  it("throws when API returns non-ok HTTP response", async () => {
    const fetchMock = mockCfHttpError(500, "internal error");
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    await expect(
      runtime.create({
        sessionId: "s1",
        workspacePath: "/tmp",
        launchCommand: "echo",
        environment: {},
      }),
    ).rejects.toThrow("Cloudflare API error 500");
  });

  it("throws when API returns success:false", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: false,
          result: null,
          errors: [{ code: 1000, message: "bad request" }],
          messages: [],
        }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    await expect(
      runtime.create({
        sessionId: "s1",
        workspacePath: "/tmp",
        launchCommand: "echo",
        environment: {},
      }),
    ).rejects.toThrow("Cloudflare API error: bad request");
  });

  it("throws when container ID is missing from response", async () => {
    const fetchMock = mockCfOk({ id: "", status: "running" });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    await expect(
      runtime.create({
        sessionId: "s1",
        workspacePath: "/tmp",
        launchCommand: "echo",
        environment: {},
      }),
    ).rejects.toThrow("did not return a container ID");
  });
});

describe("runtime.destroy()", () => {
  it("sends DELETE to the container endpoint", async () => {
    const fetchMock = mockCfOk({});
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    await runtime.destroy(makeHandle("ctr-del", "acct-123"));

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct-123/containers/ctr-del",
    );
    expect(opts.method).toBe("DELETE");
  });

  it("does not throw if container is already destroyed", async () => {
    const fetchMock = mockCfHttpError(404, "not found");
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    await expect(
      runtime.destroy(makeHandle("gone", "acct-123")),
    ).resolves.toBeUndefined();
  });

  it("returns silently when accountId is missing", async () => {
    const fetchMock = mockCfOk({});
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    const handle: RuntimeHandle = {
      id: "ctr-x",
      runtimeName: "cloudflare",
      data: {},
    };
    await expect(runtime.destroy(handle)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("runtime.sendMessage()", () => {
  it("POSTs exec command with the message", async () => {
    const fetchMock = mockCfOk({});
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    await runtime.sendMessage(makeHandle("ctr-msg", "acct-123"), "hello");

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/containers/ctr-msg/exec");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body.command[0]).toBe("sh");
  });

  it("throws when accountId is missing", async () => {
    const runtime = create();
    const handle: RuntimeHandle = {
      id: "ctr-x",
      runtimeName: "cloudflare",
      data: {},
    };
    await expect(runtime.sendMessage(handle, "hi")).rejects.toThrow(
      "No account ID",
    );
  });
});

describe("runtime.getOutput()", () => {
  it("executes tail command and returns stdout", async () => {
    const fetchMock = mockCfOk({ stdout: "line1\nline2" });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    const output = await runtime.getOutput(makeHandle());
    expect(output).toBe("line1\nline2");
  });

  it("returns stderr when stdout is missing", async () => {
    const fetchMock = mockCfOk({ stderr: "error output" });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    const output = await runtime.getOutput(makeHandle());
    expect(output).toBe("error output");
  });

  it("uses default 50 lines", async () => {
    const fetchMock = mockCfOk({ stdout: "output" });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    await runtime.getOutput(makeHandle());

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.command).toContain("50");
  });

  it("passes custom line count", async () => {
    const fetchMock = mockCfOk({ stdout: "output" });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    await runtime.getOutput(makeHandle(), 200);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.command).toContain("200");
  });

  it("returns empty string on error", async () => {
    const fetchMock = mockCfHttpError(500);
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    const output = await runtime.getOutput(makeHandle());
    expect(output).toBe("");
  });

  it("returns empty string when accountId is missing", async () => {
    const runtime = create();
    const handle: RuntimeHandle = {
      id: "ctr-x",
      runtimeName: "cloudflare",
      data: {},
    };
    const output = await runtime.getOutput(handle);
    expect(output).toBe("");
  });
});

describe("runtime.isAlive()", () => {
  it("returns true when container status is 'running'", async () => {
    const fetchMock = mockCfOk({ status: "running" });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    const alive = await runtime.isAlive(makeHandle());
    expect(alive).toBe(true);
  });

  it("returns false when container status is not 'running'", async () => {
    const fetchMock = mockCfOk({ status: "stopped" });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    const alive = await runtime.isAlive(makeHandle());
    expect(alive).toBe(false);
  });

  it("returns false on API error", async () => {
    const fetchMock = mockCfHttpError(404);
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    const alive = await runtime.isAlive(makeHandle());
    expect(alive).toBe(false);
  });

  it("returns false when accountId is missing", async () => {
    const runtime = create();
    const handle: RuntimeHandle = {
      id: "ctr-x",
      runtimeName: "cloudflare",
      data: {},
    };
    const alive = await runtime.isAlive(handle);
    expect(alive).toBe(false);
  });
});

describe("runtime.getMetrics()", () => {
  it("returns uptimeMs based on createdAt", async () => {
    const runtime = create();
    const now = Date.now();
    const handle = makeHandle("m1", "acct-123", now - 5000);

    const metrics = await runtime.getMetrics!(handle);
    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(5000);
    expect(metrics.uptimeMs).toBeLessThan(6000);
  });

  it("handles missing createdAt gracefully", async () => {
    const runtime = create();
    const handle: RuntimeHandle = {
      id: "m2",
      runtimeName: "cloudflare",
      data: {},
    };

    const metrics = await runtime.getMetrics!(handle);
    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(metrics.uptimeMs).toBeLessThan(1000);
  });
});

describe("runtime.getAttachInfo()", () => {
  it("returns web type and wrangler command", async () => {
    const runtime = create();
    const handle = makeHandle("ctr-attach");

    const info = await runtime.getAttachInfo!(handle);
    expect(info).toEqual({
      type: "web",
      target: "ctr-attach",
      command: "wrangler containers exec ctr-attach -- /bin/sh",
    });
  });
});
