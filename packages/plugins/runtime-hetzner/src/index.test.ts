import { describe, it, expect, vi, beforeEach } from "vitest";
import * as childProcess from "node:child_process";
import type { RuntimeHandle } from "@composio/ao-core";

// Mock node:child_process with custom promisify support
vi.mock("node:child_process", () => {
  const mockExecFile = vi.fn();
  (mockExecFile as any)[Symbol.for("nodejs.util.promisify.custom")] = vi.fn();
  return { execFile: mockExecFile };
});

// Get reference to the promisify-custom mock
const mockExecFileCustom = (childProcess.execFile as any)[
  Symbol.for("nodejs.util.promisify.custom")
] as ReturnType<typeof vi.fn>;

/** Queue a successful SSH/CLI command */
function mockSshSuccess(stdout = "") {
  mockExecFileCustom.mockResolvedValueOnce({ stdout: stdout + "\n", stderr: "" });
}

/** Queue a failed SSH/CLI command */
function mockSshError(message: string) {
  mockExecFileCustom.mockRejectedValueOnce(new Error(message));
}

/** Build a mock fetch that returns a successful Hetzner API response */
function mockHetznerOk<T>(result: T) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(result),
    text: () => Promise.resolve(""),
  });
}

/** Build a mock fetch that returns an error response */
function mockHetznerError(status: number, body = "error") {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: "Error",
    text: () => Promise.resolve(body),
  });
}

function makeHandle(
  id = "12345",
  ipAddress = "192.168.1.1",
  createdAt?: number,
): RuntimeHandle {
  return {
    id,
    runtimeName: "hetzner",
    data: {
      ipAddress,
      createdAt: createdAt ?? 1000,
      workspacePath: "/tmp/workspace",
    },
  };
}

import pluginDefault, { manifest, create } from "./index.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env["HETZNER_API_TOKEN"] = "test-hetzner-token";
  delete process.env["HETZNER_SERVER_TYPE"];
  delete process.env["HETZNER_IMAGE"];
  delete process.env["HETZNER_LOCATION"];
  delete process.env["HETZNER_SSH_KEY_NAME"];
  delete process.env["HETZNER_SSH_KEY_PATH"];
});

describe("manifest", () => {
  it("has name 'hetzner' and slot 'runtime'", () => {
    expect(manifest.name).toBe("hetzner");
    expect(manifest.slot).toBe("runtime");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.description).toBe("Runtime plugin: Hetzner Cloud VMs");
  });

  it("default export includes manifest and create", () => {
    expect(pluginDefault.manifest).toBe(manifest);
    expect(pluginDefault.create).toBe(create);
  });
});

describe("create()", () => {
  it("returns a Runtime with name 'hetzner'", () => {
    const runtime = create();
    expect(runtime.name).toBe("hetzner");
  });
});

describe("runtime.create()", () => {
  it("POSTs to Hetzner API and returns a handle with IP", async () => {
    const fetchMock = mockHetznerOk({
      server: {
        id: 12345,
        public_net: { ipv4: { ip: "203.0.113.1" } },
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    const handle = await runtime.create({
      sessionId: "test-session",
      workspacePath: "/tmp/ws",
      launchCommand: "node app.js",
      environment: { FOO: "bar" },
    });

    expect(handle.id).toBe("12345");
    expect(handle.runtimeName).toBe("hetzner");
    expect(handle.data["ipAddress"]).toBe("203.0.113.1");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.hetzner.cloud/v1/servers");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Authorization"]).toBe("Bearer test-hetzner-token");

    const body = JSON.parse(opts.body);
    expect(body.name).toBe("ao-test-session");
    expect(body.server_type).toBe("cx22");
    expect(body.image).toBe("ubuntu-22.04");
    expect(body.location).toBe("fsn1");
    expect(body.labels["ao-session"]).toBe("test-session");
    expect(body.user_data).toContain("node app.js");
    expect(body.user_data).toContain("AO_SESSION_ID");
  });

  it("includes ssh_keys when HETZNER_SSH_KEY_NAME is set", async () => {
    process.env["HETZNER_SSH_KEY_NAME"] = "my-key";
    const fetchMock = mockHetznerOk({
      server: {
        id: 99,
        public_net: { ipv4: { ip: "10.0.0.1" } },
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    await runtime.create({
      sessionId: "s1",
      workspacePath: "/tmp",
      launchCommand: "echo",
      environment: {},
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.ssh_keys).toEqual(["my-key"]);
  });

  it("throws when HETZNER_API_TOKEN is missing", async () => {
    delete process.env["HETZNER_API_TOKEN"];
    const runtime = create();

    await expect(
      runtime.create({
        sessionId: "s1",
        workspacePath: "/tmp",
        launchCommand: "echo",
        environment: {},
      }),
    ).rejects.toThrow("HETZNER_API_TOKEN environment variable is required");
  });

  it("throws on API HTTP error", async () => {
    const fetchMock = mockHetznerError(500, "server error");
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    await expect(
      runtime.create({
        sessionId: "s1",
        workspacePath: "/tmp",
        launchCommand: "echo",
        environment: {},
      }),
    ).rejects.toThrow("Hetzner API error 500");
  });
});

describe("runtime.destroy()", () => {
  it("sends DELETE to the server endpoint", async () => {
    const fetchMock = mockHetznerOk({});
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    await runtime.destroy(makeHandle("12345"));

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.hetzner.cloud/v1/servers/12345");
    expect(opts.method).toBe("DELETE");
  });

  it("does not throw if server is already destroyed", async () => {
    const fetchMock = mockHetznerError(404, "not found");
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    await expect(
      runtime.destroy(makeHandle("99")),
    ).resolves.toBeUndefined();
  });
});

describe("runtime.sendMessage()", () => {
  it("sends message via SSH using printf", async () => {
    const runtime = create();
    mockSshSuccess("");

    await runtime.sendMessage(makeHandle("123", "192.168.1.100"), "hello");

    expect(mockExecFileCustom).toHaveBeenCalledOnce();
    expect(mockExecFileCustom.mock.calls[0][0]).toBe("ssh");
    const args = mockExecFileCustom.mock.calls[0][1] as string[];
    expect(args).toContain("root@192.168.1.100");
    const cmdArg = args[args.length - 1];
    expect(cmdArg).toContain("printf");
    expect(cmdArg).toContain("'hello'");
    expect(cmdArg).not.toMatch(/echo\s+/);
  });

  it("wraps message in single quotes to prevent shell injection", async () => {
    const runtime = create();
    mockSshSuccess("");

    await runtime.sendMessage(makeHandle("123", "192.168.1.100"), "$(rm -rf /)");

    const args = mockExecFileCustom.mock.calls[0][1] as string[];
    const cmdArg = args[args.length - 1];
    // shellEscape wraps in single quotes — $(rm -rf /) becomes '$(rm -rf /)'
    expect(cmdArg).toContain("'$(rm -rf /)'");
    expect(cmdArg).toContain("printf");
  });

  it("uses custom SSH key from HETZNER_SSH_KEY_PATH", async () => {
    process.env["HETZNER_SSH_KEY_PATH"] = "/custom/key";
    const runtime = create();
    mockSshSuccess("");

    await runtime.sendMessage(makeHandle(), "hi");

    const args = mockExecFileCustom.mock.calls[0][1] as string[];
    expect(args).toContain("-i");
    expect(args).toContain("/custom/key");
  });

  it("throws when ipAddress is missing", async () => {
    const runtime = create();
    const handle: RuntimeHandle = {
      id: "123",
      runtimeName: "hetzner",
      data: {},
    };

    await expect(runtime.sendMessage(handle, "hello")).rejects.toThrow(
      "No IP address found",
    );
  });
});

describe("runtime.getOutput()", () => {
  it("gets output via SSH tail command", async () => {
    const runtime = create();
    mockSshSuccess("line1\nline2");

    const output = await runtime.getOutput(makeHandle());
    expect(output).toBe("line1\nline2");
  });

  it("passes default 50 lines", async () => {
    const runtime = create();
    mockSshSuccess("output");

    await runtime.getOutput(makeHandle());

    const args = mockExecFileCustom.mock.calls[0][1] as string[];
    const cmdArg = args[args.length - 1];
    expect(cmdArg).toContain("50");
  });

  it("passes custom line count", async () => {
    const runtime = create();
    mockSshSuccess("output");

    await runtime.getOutput(makeHandle(), 200);

    const args = mockExecFileCustom.mock.calls[0][1] as string[];
    const cmdArg = args[args.length - 1];
    expect(cmdArg).toContain("200");
  });

  it("returns empty string on SSH error", async () => {
    const runtime = create();
    mockSshError("connection refused");

    const output = await runtime.getOutput(makeHandle());
    expect(output).toBe("");
  });

  it("returns empty string when ipAddress is missing", async () => {
    const runtime = create();
    const handle: RuntimeHandle = {
      id: "123",
      runtimeName: "hetzner",
      data: {},
    };

    const output = await runtime.getOutput(handle);
    expect(output).toBe("");
  });
});

describe("runtime.isAlive()", () => {
  it("returns true when server status is 'running'", async () => {
    const fetchMock = mockHetznerOk({ server: { status: "running" } });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    const alive = await runtime.isAlive(makeHandle());
    expect(alive).toBe(true);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("/servers/12345");
  });

  it("returns false when server status is not 'running'", async () => {
    const fetchMock = mockHetznerOk({ server: { status: "off" } });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    const alive = await runtime.isAlive(makeHandle());
    expect(alive).toBe(false);
  });

  it("returns false on API error", async () => {
    const fetchMock = mockHetznerError(404);
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    const alive = await runtime.isAlive(makeHandle());
    expect(alive).toBe(false);
  });
});

describe("runtime.getMetrics()", () => {
  it("returns uptimeMs based on createdAt", async () => {
    const runtime = create();
    const now = Date.now();
    const handle = makeHandle("123", "1.2.3.4", now - 5000);

    const metrics = await runtime.getMetrics!(handle);
    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(5000);
    expect(metrics.uptimeMs).toBeLessThan(6000);
  });

  it("handles missing createdAt gracefully", async () => {
    const runtime = create();
    const handle: RuntimeHandle = {
      id: "123",
      runtimeName: "hetzner",
      data: {},
    };

    const metrics = await runtime.getMetrics!(handle);
    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(metrics.uptimeMs).toBeLessThan(1000);
  });
});

describe("runtime.getAttachInfo()", () => {
  it("returns ssh type with SSH command", async () => {
    const runtime = create();
    const handle = makeHandle("123", "203.0.113.1");

    const info = await runtime.getAttachInfo!(handle);
    expect(info).toEqual({
      type: "ssh",
      target: "203.0.113.1",
      command: "ssh root@203.0.113.1",
    });
  });

  it("uses handle id as target when ipAddress is missing", async () => {
    const runtime = create();
    const handle: RuntimeHandle = {
      id: "123",
      runtimeName: "hetzner",
      data: {},
    };

    const info = await runtime.getAttachInfo!(handle);
    expect(info.target).toBe("123");
    expect(info.command).toBeUndefined();
  });
});
