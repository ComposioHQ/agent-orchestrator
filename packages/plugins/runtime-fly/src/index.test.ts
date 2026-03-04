import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RuntimeHandle } from "@composio/ao-core";

/** Build a mock fetch that returns a successful Fly API response */
function mockFlyOk(jsonBody: unknown = {}) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(jsonBody),
    text: () => Promise.resolve(""),
  });
}

/** Build a mock fetch that returns an error response */
function mockFlyError(status: number, body = "error") {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: "Error",
    text: () => Promise.resolve(body),
  });
}

function makeHandle(
  id = "machine-abc",
  app = "my-fly-app",
  createdAt?: number,
): RuntimeHandle {
  return {
    id,
    runtimeName: "fly",
    data: {
      app,
      createdAt: createdAt ?? 1000,
      workspacePath: "/tmp/workspace",
    },
  };
}

import pluginDefault, { manifest, create } from "./index.js";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env["FLY_API_TOKEN"] = "test-fly-token";
  process.env["FLY_APP_NAME"] = "my-fly-app";
});

describe("manifest", () => {
  it("has name 'fly' and slot 'runtime'", () => {
    expect(manifest.name).toBe("fly");
    expect(manifest.slot).toBe("runtime");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.description).toBe(
      "Runtime plugin: Fly.io Machines (Firecracker VMs)",
    );
  });

  it("default export includes manifest and create", () => {
    expect(pluginDefault.manifest).toBe(manifest);
    expect(pluginDefault.create).toBe(create);
  });
});

describe("create()", () => {
  it("returns a Runtime with name 'fly'", () => {
    const runtime = create();
    expect(runtime.name).toBe("fly");
  });
});

describe("runtime.create()", () => {
  it("POSTs to Fly machines API and waits for started state", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => {
        // Create machine
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ id: "mach-1", state: "created" }),
          text: () => Promise.resolve(""),
        });
      })
      .mockImplementation(() => {
        // Wait for started
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

    expect(handle.id).toBe("mach-1");
    expect(handle.runtimeName).toBe("fly");
    expect(handle.data["app"]).toBe("my-fly-app");

    // First call: POST to create
    const [createUrl, createOpts] = fetchMock.mock.calls[0];
    expect(createUrl).toBe(
      "https://api.machines.dev/v1/apps/my-fly-app/machines",
    );
    expect(createOpts.method).toBe("POST");
    expect(createOpts.headers["Authorization"]).toBe(
      "Bearer test-fly-token",
    );

    const body = JSON.parse(createOpts.body);
    expect(body.name).toBe("ao-test-session");
    expect(body.config.env.FOO).toBe("bar");
    expect(body.config.env.AO_SESSION_ID).toBe("test-session");
    expect(body.config.init.cmd).toEqual(["sh", "-c", "node app.js"]);

    // Second call: wait for started
    const [waitUrl] = fetchMock.mock.calls[1];
    expect(waitUrl).toContain("/wait?state=started");
  });

  it("throws when FLY_API_TOKEN is missing", async () => {
    delete process.env["FLY_API_TOKEN"];
    const runtime = create();

    await expect(
      runtime.create({
        sessionId: "s1",
        workspacePath: "/tmp",
        launchCommand: "echo",
        environment: {},
      }),
    ).rejects.toThrow("FLY_API_TOKEN environment variable is required");
  });

  it("throws when FLY_APP_NAME is missing", async () => {
    delete process.env["FLY_APP_NAME"];
    const runtime = create();

    await expect(
      runtime.create({
        sessionId: "s1",
        workspacePath: "/tmp",
        launchCommand: "echo",
        environment: {},
      }),
    ).rejects.toThrow("FLY_APP_NAME environment variable is required");
  });

  it("throws when machine ID is missing from response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "", state: "created" }),
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
    ).rejects.toThrow("did not return a machine ID");
  });

  it("throws on API HTTP error", async () => {
    const fetchMock = mockFlyError(500, "server error");
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    await expect(
      runtime.create({
        sessionId: "s1",
        workspacePath: "/tmp",
        launchCommand: "echo",
        environment: {},
      }),
    ).rejects.toThrow("Fly API error 500");
  });
});

describe("runtime.destroy()", () => {
  it("stops, waits, and deletes the machine", async () => {
    const fetchMock = vi.fn().mockImplementation(() => {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    await runtime.destroy(makeHandle("mach-del", "my-fly-app"));

    // stop, wait, delete
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toContain("/stop");
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    expect(fetchMock.mock.calls[1][0]).toContain("/wait?state=stopped");
    expect(fetchMock.mock.calls[2][0]).toContain("?force=true");
    expect(fetchMock.mock.calls[2][1].method).toBe("DELETE");
  });

  it("does not throw if machine is already destroyed", async () => {
    const fetchMock = mockFlyError(404, "not found");
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    await expect(
      runtime.destroy(makeHandle("gone", "my-fly-app")),
    ).resolves.toBeUndefined();
  });

  it("returns silently when app is missing from handle", async () => {
    const fetchMock = mockFlyOk();
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    const handle: RuntimeHandle = {
      id: "mach-x",
      runtimeName: "fly",
      data: {},
    };
    await expect(runtime.destroy(handle)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("runtime.sendMessage()", () => {
  it("POSTs exec command with the message", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ exit_code: 0 }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    await runtime.sendMessage(makeHandle("mach-msg", "my-fly-app"), "hello");

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/machines/mach-msg/exec");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body.cmd[0]).toBe("sh");
  });

  it("throws when exit_code is non-zero", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ exit_code: 1 }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    await expect(
      runtime.sendMessage(makeHandle(), "hello"),
    ).rejects.toThrow("exit code 1");
  });

  it("throws when app is missing from handle", async () => {
    const runtime = create();
    const handle: RuntimeHandle = {
      id: "mach-x",
      runtimeName: "fly",
      data: {},
    };
    await expect(runtime.sendMessage(handle, "hi")).rejects.toThrow(
      "No app found",
    );
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

  it("returns stderr when stdout is absent", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ stderr: "err output" }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    const output = await runtime.getOutput(makeHandle());
    expect(output).toBe("err output");
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
    expect(body.cmd).toContain("50");
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
    expect(body.cmd).toContain("200");
  });

  it("returns empty string on error", async () => {
    const fetchMock = mockFlyError(500);
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    const output = await runtime.getOutput(makeHandle());
    expect(output).toBe("");
  });

  it("returns empty string when app is missing", async () => {
    const runtime = create();
    const handle: RuntimeHandle = {
      id: "mach-x",
      runtimeName: "fly",
      data: {},
    };
    const output = await runtime.getOutput(handle);
    expect(output).toBe("");
  });
});

describe("runtime.isAlive()", () => {
  it("returns true when machine state is 'started'", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ state: "started" }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    expect(await runtime.isAlive(makeHandle())).toBe(true);
  });

  it("returns true when machine state is 'starting'", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ state: "starting" }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    expect(await runtime.isAlive(makeHandle())).toBe(true);
  });

  it("returns false when machine state is 'stopped'", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ state: "stopped" }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    expect(await runtime.isAlive(makeHandle())).toBe(false);
  });

  it("returns false on API error", async () => {
    const fetchMock = mockFlyError(404);
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    expect(await runtime.isAlive(makeHandle())).toBe(false);
  });

  it("returns false when app is missing from handle", async () => {
    const runtime = create();
    const handle: RuntimeHandle = {
      id: "mach-x",
      runtimeName: "fly",
      data: {},
    };
    expect(await runtime.isAlive(handle)).toBe(false);
  });
});

describe("runtime.getMetrics()", () => {
  it("returns uptimeMs based on createdAt", async () => {
    const runtime = create();
    const now = Date.now();
    const handle = makeHandle("m1", "app", now - 5000);

    const metrics = await runtime.getMetrics!(handle);
    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(5000);
    expect(metrics.uptimeMs).toBeLessThan(6000);
  });

  it("handles missing createdAt gracefully", async () => {
    const runtime = create();
    const handle: RuntimeHandle = {
      id: "m2",
      runtimeName: "fly",
      data: {},
    };

    const metrics = await runtime.getMetrics!(handle);
    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(metrics.uptimeMs).toBeLessThan(1000);
  });
});

describe("runtime.getAttachInfo()", () => {
  it("returns ssh type with fly ssh command", async () => {
    const runtime = create();
    const handle = makeHandle("mach-attach", "cool-app");

    const info = await runtime.getAttachInfo!(handle);
    expect(info).toEqual({
      type: "ssh",
      target: "mach-attach",
      command: "fly ssh console -a cool-app -s mach-attach",
    });
  });
});
