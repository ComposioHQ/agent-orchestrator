import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RuntimeHandle } from "@composio/ao-core";

/** Build a mock fetch that returns a successful response */
function mockOsOk(jsonBody: unknown = {}) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(jsonBody),
    text: () => Promise.resolve(""),
  });
}

/** Build a mock fetch that returns an error */
function mockOsError(status: number, body = "error") {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: "Error",
    text: () => Promise.resolve(body),
  });
}

function makeHandle(
  id = "sbx-abc",
  createdAt?: number,
): RuntimeHandle {
  return {
    id,
    runtimeName: "opensandbox",
    data: {
      createdAt: createdAt ?? 1000,
      workspacePath: "/tmp/workspace",
    },
  };
}

import pluginDefault, { manifest, create } from "./index.js";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env["OPENSANDBOX_API_KEY"] = "test-os-key";
  process.env["OPENSANDBOX_HOST"] = "https://opensandbox.example.com";
  delete process.env["OPENSANDBOX_IMAGE"];
});

describe("manifest", () => {
  it("has name 'opensandbox' and slot 'runtime'", () => {
    expect(manifest.name).toBe("opensandbox");
    expect(manifest.slot).toBe("runtime");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.description).toBe(
      "Runtime plugin: OpenSandbox (Docker/K8s backends, CRIU pause/resume)",
    );
  });

  it("default export includes manifest and create", () => {
    expect(pluginDefault.manifest).toBe(manifest);
    expect(pluginDefault.create).toBe(create);
  });
});

describe("create()", () => {
  it("returns a Runtime with name 'opensandbox'", () => {
    const runtime = create();
    expect(runtime.name).toBe("opensandbox");
  });
});

describe("runtime.create()", () => {
  it("POSTs to sandboxes API and runs launch command", async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ id: "sbx-new", status: "running" }),
          text: () => Promise.resolve(""),
        });
      }
      // Run command
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    const handle = await runtime.create({
      sessionId: "test-session",
      workspacePath: "/tmp/ws",
      launchCommand: "node app.js",
      environment: { FOO: "bar" },
    });

    expect(handle.id).toBe("sbx-new");
    expect(handle.runtimeName).toBe("opensandbox");
    expect(handle.data["workspacePath"]).toBe("/tmp/ws");

    // First call: create sandbox
    const [createUrl, createOpts] = fetchMock.mock.calls[0];
    expect(createUrl).toBe(
      "https://opensandbox.example.com/v1/sandboxes",
    );
    expect(createOpts.method).toBe("POST");
    expect(createOpts.headers["Authorization"]).toBe("Bearer test-os-key");

    const createBody = JSON.parse(createOpts.body);
    expect(createBody.name).toBe("ao-test-session");
    expect(createBody.image).toBe("ubuntu:22.04");
    expect(createBody.environment.FOO).toBe("bar");
    expect(createBody.environment.AO_SESSION_ID).toBe("test-session");
    expect(createBody.workdir).toBe("/tmp/ws");

    // Second call: run command
    const [runUrl, runOpts] = fetchMock.mock.calls[1];
    expect(runUrl).toContain("/sandboxes/sbx-new/commands/run");
    expect(runOpts.method).toBe("POST");
    const runBody = JSON.parse(runOpts.body);
    expect(runBody.command).toBe("node app.js");
    expect(runBody.background).toBe(true);
  });

  it("throws when OPENSANDBOX_API_KEY is missing", async () => {
    delete process.env["OPENSANDBOX_API_KEY"];
    const runtime = create();

    await expect(
      runtime.create({
        sessionId: "s1",
        workspacePath: "/tmp",
        launchCommand: "echo",
        environment: {},
      }),
    ).rejects.toThrow("OPENSANDBOX_API_KEY environment variable is required");
  });

  it("throws when OPENSANDBOX_HOST is missing", async () => {
    delete process.env["OPENSANDBOX_HOST"];
    const runtime = create();

    await expect(
      runtime.create({
        sessionId: "s1",
        workspacePath: "/tmp",
        launchCommand: "echo",
        environment: {},
      }),
    ).rejects.toThrow("OPENSANDBOX_HOST environment variable is required");
  });

  it("throws on API HTTP error", async () => {
    const fetchMock = mockOsError(500, "server error");
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    await expect(
      runtime.create({
        sessionId: "s1",
        workspacePath: "/tmp",
        launchCommand: "echo",
        environment: {},
      }),
    ).rejects.toThrow("OpenSandbox API error 500");
  });

  it("throws when sandbox ID is missing from response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "", status: "running" }),
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
    ).rejects.toThrow("did not return a sandbox ID");
  });

  it("strips trailing slash from OPENSANDBOX_HOST", async () => {
    process.env["OPENSANDBOX_HOST"] = "https://example.com///";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "sbx-1", status: "running" }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    await runtime.create({
      sessionId: "s1",
      workspacePath: "/tmp",
      launchCommand: "echo",
      environment: {},
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://example.com/v1/sandboxes",
    );
  });
});

describe("runtime.destroy()", () => {
  it("sends DELETE to the sandbox endpoint", async () => {
    const fetchMock = mockOsOk();
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    await runtime.destroy(makeHandle("sbx-del"));

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/v1/sandboxes/sbx-del");
    expect(opts.method).toBe("DELETE");
  });

  it("does not throw if sandbox is already destroyed", async () => {
    const fetchMock = mockOsError(404, "not found");
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    await expect(runtime.destroy(makeHandle("gone"))).resolves.toBeUndefined();
  });
});

describe("runtime.sendMessage()", () => {
  it("POSTs run command with the message", async () => {
    const fetchMock = mockOsOk();
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    await runtime.sendMessage(makeHandle("sbx-msg"), "hello world");

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/sandboxes/sbx-msg/commands/run");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body.command).toContain("hello world");
  });
});

describe("runtime.getOutput()", () => {
  it("executes tail command and returns stdout", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ stdout: "line1\nline2" }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    const output = await runtime.getOutput(makeHandle());
    expect(output).toBe("line1\nline2");
  });

  it("returns output field when stdout is absent", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ output: "fallback output" }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    const output = await runtime.getOutput(makeHandle());
    expect(output).toBe("fallback output");
  });

  it("uses default 50 lines", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ stdout: "out" }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    await runtime.getOutput(makeHandle());

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.command).toContain("50");
  });

  it("passes custom line count", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ stdout: "out" }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    await runtime.getOutput(makeHandle(), 200);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.command).toContain("200");
  });

  it("returns empty string on error", async () => {
    const fetchMock = mockOsError(500);
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    const output = await runtime.getOutput(makeHandle());
    expect(output).toBe("");
  });
});

describe("runtime.isAlive()", () => {
  it("returns true when sandbox status is 'running'", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "running" }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    expect(await runtime.isAlive(makeHandle())).toBe(true);
  });

  it("returns false when sandbox status is not 'running'", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "paused" }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    expect(await runtime.isAlive(makeHandle())).toBe(false);
  });

  it("returns false on API error", async () => {
    const fetchMock = mockOsError(404);
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    expect(await runtime.isAlive(makeHandle())).toBe(false);
  });
});

describe("runtime.getMetrics()", () => {
  it("returns uptimeMs and API metrics when available", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ memory_mb: 256, cpu_percent: 45.2 }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    const now = Date.now();
    const handle = makeHandle("m1", now - 5000);

    const metrics = await runtime.getMetrics!(handle);
    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(5000);
    expect(metrics.uptimeMs).toBeLessThan(6000);
    expect(metrics.memoryMb).toBe(256);
    expect(metrics.cpuPercent).toBe(45.2);

    expect(fetchMock.mock.calls[0][0]).toContain("/metrics");
  });

  it("returns only uptimeMs when metrics API fails", async () => {
    const fetchMock = mockOsError(500);
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    const now = Date.now();
    const handle = makeHandle("m2", now - 3000);

    const metrics = await runtime.getMetrics!(handle);
    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(3000);
    expect(metrics.memoryMb).toBeUndefined();
    expect(metrics.cpuPercent).toBeUndefined();
  });

  it("handles missing createdAt gracefully", async () => {
    const fetchMock = mockOsError(500);
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    const handle: RuntimeHandle = {
      id: "m3",
      runtimeName: "opensandbox",
      data: {},
    };

    const metrics = await runtime.getMetrics!(handle);
    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(metrics.uptimeMs).toBeLessThan(1000);
  });
});

describe("runtime.getAttachInfo()", () => {
  it("returns web type with terminal URL and exec command", async () => {
    const runtime = create();
    const handle = makeHandle("sbx-attach");

    const info = await runtime.getAttachInfo!(handle);
    expect(info).toEqual({
      type: "web",
      target:
        "https://opensandbox.example.com/v1/sandboxes/sbx-attach/terminal",
      command: "opensandbox exec sbx-attach -- /bin/bash",
    });
  });
});
