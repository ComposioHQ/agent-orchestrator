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

/** Queue a successful lxc command */
function mockLxcSuccess(stdout = "") {
  mockExecFileCustom.mockResolvedValueOnce({ stdout: stdout + "\n", stderr: "" });
}

/** Queue a failed lxc command */
function mockLxcError(message: string) {
  mockExecFileCustom.mockRejectedValueOnce(new Error(message));
}

function makeHandle(
  id = "ao-test-session",
  createdAt?: number,
): RuntimeHandle {
  return {
    id,
    runtimeName: "lxc",
    data: {
      createdAt: createdAt ?? 1000,
      workspacePath: "/tmp/workspace",
    },
  };
}

import pluginDefault, { manifest, create } from "./index.js";

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env["LXC_BINARY"];
  delete process.env["LXC_IMAGE"];
  delete process.env["LXC_REMOTE"];
});

describe("manifest", () => {
  it("has name 'lxc' and slot 'runtime'", () => {
    expect(manifest.name).toBe("lxc");
    expect(manifest.slot).toBe("runtime");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.description).toBe(
      "Runtime plugin: LXC/LXD/Incus system containers",
    );
  });

  it("default export includes manifest and create", () => {
    expect(pluginDefault.manifest).toBe(manifest);
    expect(pluginDefault.create).toBe(create);
  });
});

describe("create()", () => {
  it("returns a Runtime with name 'lxc'", () => {
    const runtime = create();
    expect(runtime.name).toBe("lxc");
  });
});

describe("runtime.create()", () => {
  it("launches container and sets up environment", async () => {
    const runtime = create();

    // lxc launch
    mockLxcSuccess("");
    // lxc info (readiness check) -- returns Status: RUNNING
    mockLxcSuccess("Name: ao-test-session\nStatus: RUNNING\neth0: 10.0.0.1");
    // lxc config set (AO_SESSION_ID)
    mockLxcSuccess("");
    // lxc config set (AO_WORKSPACE)
    mockLxcSuccess("");
    // lxc exec mkdir
    mockLxcSuccess("");
    // lxc exec (launch command)
    mockLxcSuccess("");

    const handle = await runtime.create({
      sessionId: "test-session",
      workspacePath: "/tmp/workspace",
      launchCommand: "node app.js",
      environment: {},
    });

    expect(handle.id).toBe("ao-test-session");
    expect(handle.runtimeName).toBe("lxc");

    // lxc launch call
    const launchArgs = mockExecFileCustom.mock.calls[0][1] as string[];
    expect(launchArgs).toContain("launch");
    expect(launchArgs).toContain("ubuntu:22.04");
    expect(launchArgs).toContain("ao-test-session");
  });

  it("includes environment variables via lxc config set", async () => {
    const runtime = create();

    // lxc launch
    mockLxcSuccess("");
    // lxc info (readiness check)
    mockLxcSuccess("Status: RUNNING");
    // lxc config set FOO=bar
    mockLxcSuccess("");
    // lxc config set AO_SESSION_ID
    mockLxcSuccess("");
    // lxc config set AO_WORKSPACE
    mockLxcSuccess("");
    // lxc exec mkdir
    mockLxcSuccess("");
    // lxc exec (launch command)
    mockLxcSuccess("");

    await runtime.create({
      sessionId: "test-session",
      workspacePath: "/tmp/ws",
      launchCommand: "bash",
      environment: { FOO: "bar" },
    });

    // Find the config set call for FOO
    const configSetCall = mockExecFileCustom.mock.calls.find(
      (call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes("config") && args.includes("environment.FOO");
      },
    );
    expect(configSetCall).toBeDefined();
  });

  it("uses custom binary from LXC_BINARY env var", async () => {
    process.env["LXC_BINARY"] = "incus";
    const runtime = create();

    // incus launch
    mockLxcSuccess("");
    // incus info (readiness check)
    mockLxcSuccess("Status: RUNNING");
    // incus config set AO_SESSION_ID
    mockLxcSuccess("");
    // incus config set AO_WORKSPACE
    mockLxcSuccess("");
    // incus exec mkdir
    mockLxcSuccess("");
    // incus exec (launch command)
    mockLxcSuccess("");

    await runtime.create({
      sessionId: "test-session",
      workspacePath: "/tmp/ws",
      launchCommand: "bash",
      environment: {},
    });

    // All calls should use "incus" binary
    expect(mockExecFileCustom.mock.calls[0][0]).toBe("incus");
  });

  it("rejects invalid session IDs", async () => {
    const runtime = create();

    await expect(
      runtime.create({
        sessionId: "bad name!",
        workspacePath: "/tmp",
        launchCommand: "echo",
        environment: {},
      }),
    ).rejects.toThrow("Cannot create valid LXC container name");
  });

  it("throws when container does not become ready", async () => {
    const runtime = create();

    // lxc launch
    mockLxcSuccess("");
    // 10 lxc info attempts that don't show RUNNING
    for (let i = 0; i < 10; i++) {
      mockLxcSuccess("Status: STOPPED");
    }
    // lxc delete --force (cleanup)
    mockLxcSuccess("");

    await expect(
      runtime.create({
        sessionId: "test-session",
        workspacePath: "/tmp",
        launchCommand: "echo",
        environment: {},
      }),
    ).rejects.toThrow("did not reach running state");
  }, 30_000);
});

describe("runtime.destroy()", () => {
  it("calls lxc delete --force", async () => {
    const runtime = create();
    mockLxcSuccess("");

    await runtime.destroy(makeHandle());

    expect(mockExecFileCustom).toHaveBeenCalledOnce();
    const args = mockExecFileCustom.mock.calls[0][1] as string[];
    expect(args).toContain("delete");
    expect(args).toContain("ao-test-session");
    expect(args).toContain("--force");
  });

  it("does not throw if container is already deleted", async () => {
    const runtime = create();
    mockLxcError("not found");

    await expect(runtime.destroy(makeHandle())).resolves.toBeUndefined();
  });
});

describe("runtime.sendMessage()", () => {
  it("executes echo command via lxc exec", async () => {
    const runtime = create();
    mockLxcSuccess("");

    await runtime.sendMessage(makeHandle(), "hello world");

    expect(mockExecFileCustom).toHaveBeenCalledOnce();
    const args = mockExecFileCustom.mock.calls[0][1] as string[];
    expect(args).toContain("exec");
    expect(args).toContain("ao-test-session");
    expect(args).toContain("--");
    expect(args).toContain("sh");
  });
});

describe("runtime.getOutput()", () => {
  it("gets output via lxc exec tail", async () => {
    const runtime = create();
    mockLxcSuccess("line1\nline2");

    const output = await runtime.getOutput(makeHandle());
    expect(output).toBe("line1\nline2");
  });

  it("passes default 50 lines", async () => {
    const runtime = create();
    mockLxcSuccess("output");

    await runtime.getOutput(makeHandle());

    const args = mockExecFileCustom.mock.calls[0][1] as string[];
    expect(args).toContain("50");
  });

  it("passes custom line count", async () => {
    const runtime = create();
    mockLxcSuccess("output");

    await runtime.getOutput(makeHandle(), 200);

    const args = mockExecFileCustom.mock.calls[0][1] as string[];
    expect(args).toContain("200");
  });

  it("returns empty string on error", async () => {
    const runtime = create();
    mockLxcError("exec failed");

    const output = await runtime.getOutput(makeHandle());
    expect(output).toBe("");
  });
});

describe("runtime.isAlive()", () => {
  it("returns true when lxc list shows RUNNING", async () => {
    const runtime = create();
    mockLxcSuccess("RUNNING");

    const alive = await runtime.isAlive(makeHandle());
    expect(alive).toBe(true);

    const args = mockExecFileCustom.mock.calls[0][1] as string[];
    expect(args).toContain("list");
    expect(args).toContain("--format");
    expect(args).toContain("csv");
  });

  it("returns false when container is STOPPED", async () => {
    const runtime = create();
    mockLxcSuccess("STOPPED");

    const alive = await runtime.isAlive(makeHandle());
    expect(alive).toBe(false);
  });

  it("returns false when lxc list fails", async () => {
    const runtime = create();
    mockLxcError("not found");

    const alive = await runtime.isAlive(makeHandle());
    expect(alive).toBe(false);
  });
});

describe("runtime.getMetrics()", () => {
  it("returns uptimeMs and parses memory/cpu from lxc info", async () => {
    const runtime = create();
    const now = Date.now();
    const handle = makeHandle("ao-test", now - 5000);

    mockLxcSuccess(
      "Memory (current): 256.50MiB\nCPU usage (in seconds): 2.5",
    );

    const metrics = await runtime.getMetrics!(handle);
    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(5000);
    expect(metrics.uptimeMs).toBeLessThan(6000);
    expect(metrics.memoryMb).toBeCloseTo(256.5, 1);
    // cpuPercent = (cpuSeconds / uptimeSeconds) * 100
    expect(metrics.cpuPercent).toBeDefined();
    expect(metrics.cpuPercent!).toBeGreaterThan(0);
  });

  it("returns only uptimeMs when lxc info fails", async () => {
    const runtime = create();
    const now = Date.now();
    const handle = makeHandle("ao-test", now - 3000);

    mockLxcError("info failed");

    const metrics = await runtime.getMetrics!(handle);
    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(3000);
    expect(metrics.memoryMb).toBeUndefined();
    expect(metrics.cpuPercent).toBeUndefined();
  });

  it("handles missing createdAt gracefully", async () => {
    const runtime = create();
    const handle: RuntimeHandle = {
      id: "ao-test",
      runtimeName: "lxc",
      data: {},
    };

    mockLxcError("no info");

    const metrics = await runtime.getMetrics!(handle);
    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(metrics.uptimeMs).toBeLessThan(1000);
  });
});

describe("runtime.getAttachInfo()", () => {
  it("returns docker type with lxc exec command", async () => {
    const runtime = create();
    const handle = makeHandle("ao-attach");

    const info = await runtime.getAttachInfo!(handle);
    expect(info).toEqual({
      type: "docker",
      target: "ao-attach",
      command: "lxc exec ao-attach -- /bin/bash",
    });
  });

  it("uses custom binary from LXC_BINARY", async () => {
    process.env["LXC_BINARY"] = "incus";
    const runtime = create();
    const handle = makeHandle("ao-attach");

    const info = await runtime.getAttachInfo!(handle);
    expect(info.command).toBe("incus exec ao-attach -- /bin/bash");
  });
});
