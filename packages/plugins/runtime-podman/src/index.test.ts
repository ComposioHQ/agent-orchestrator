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

/** Queue a successful podman command with the given stdout. */
function mockPodmanSuccess(stdout = "") {
  mockExecFileCustom.mockResolvedValueOnce({ stdout: stdout + "\n", stderr: "" });
}

/** Queue a failed podman command. */
function mockPodmanError(message: string) {
  mockExecFileCustom.mockRejectedValueOnce(new Error(message));
}

/** Create a RuntimeHandle for testing. */
function makeHandle(id: string, overrides: Record<string, unknown> = {}): RuntimeHandle {
  return {
    id,
    runtimeName: "podman",
    data: {
      containerName: `ao-${id}`,
      createdAt: 1000,
      workspacePath: "/tmp/workspace",
      ...overrides,
    },
  };
}

// Import after mocks are set up
import podmanPlugin, { manifest, create } from "./index.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("manifest", () => {
  it("has name 'podman' and slot 'runtime'", () => {
    expect(manifest.name).toBe("podman");
    expect(manifest.slot).toBe("runtime");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.description).toBe("Runtime plugin: Podman (daemonless, rootless containers)");
  });

  it("default export includes manifest and create", () => {
    expect(podmanPlugin.manifest).toBe(manifest);
    expect(podmanPlugin.create).toBe(create);
  });
});

describe("create()", () => {
  it("returns a Runtime with name 'podman'", () => {
    const runtime = create();
    expect(runtime.name).toBe("podman");
  });
});

describe("runtime.create()", () => {
  it("calls podman create and start with correct args", async () => {
    const runtime = create();

    // podman create returns container ID
    mockPodmanSuccess("abc123def");
    // podman start
    mockPodmanSuccess();

    const handle = await runtime.create({
      sessionId: "test-session",
      workspacePath: "/tmp/workspace",
      launchCommand: "node app.js",
      environment: {},
    });

    expect(handle.id).toBe("abc123def");
    expect(handle.runtimeName).toBe("podman");
    expect(handle.data.containerName).toBe("ao-test-session");
    expect(handle.data.workspacePath).toBe("/tmp/workspace");

    // podman create call
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(1, "podman", [
      "create",
      "--name", "ao-test-session",
      "--workdir", "/tmp/workspace",
      "-v", "/tmp/workspace:/tmp/workspace",
      "-e", "AO_SESSION_ID=test-session",
      "-e", "AO_WORKSPACE=/tmp/workspace",
      expect.stringMatching(/ubuntu/),
      "sh", "-c", "node app.js",
    ], { timeout: 30_000 });

    // podman start call
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(2, "podman", [
      "start", "ao-test-session",
    ], { timeout: 30_000 });
  });

  it("includes -e KEY=VALUE flags for environment variables", async () => {
    const runtime = create();

    mockPodmanSuccess("cid");
    mockPodmanSuccess();

    await runtime.create({
      sessionId: "env-session",
      workspacePath: "/tmp/ws",
      launchCommand: "bash",
      environment: { FOO: "bar", BAZ: "qux" },
    });

    const createArgs = mockExecFileCustom.mock.calls[0][1] as string[];
    expect(createArgs).toContain("-e");
    expect(createArgs).toContain("FOO=bar");
    expect(createArgs).toContain("BAZ=qux");
    // Should also include AO_SESSION_ID and AO_WORKSPACE
    expect(createArgs).toContain("AO_SESSION_ID=env-session");
    expect(createArgs).toContain("AO_WORKSPACE=/tmp/ws");
  });
});

describe("runtime.destroy()", () => {
  it("calls podman stop then podman rm -f", async () => {
    const runtime = create();
    const handle = makeHandle("destroy-test");

    // podman stop
    mockPodmanSuccess();
    // podman rm -f
    mockPodmanSuccess();

    await runtime.destroy(handle);

    expect(mockExecFileCustom).toHaveBeenNthCalledWith(1, "podman", [
      "stop", "-t", "10", "ao-destroy-test",
    ], { timeout: 30_000 });

    expect(mockExecFileCustom).toHaveBeenNthCalledWith(2, "podman", [
      "rm", "-f", "ao-destroy-test",
    ], { timeout: 30_000 });
  });

  it("does not throw if podman stop fails (container already stopped)", async () => {
    const runtime = create();
    const handle = makeHandle("already-stopped");

    // podman stop fails
    mockPodmanError("container already stopped");
    // podman rm succeeds
    mockPodmanSuccess();

    await expect(runtime.destroy(handle)).resolves.toBeUndefined();
  });

  it("does not throw if both stop and rm fail", async () => {
    const runtime = create();
    const handle = makeHandle("fully-gone");

    mockPodmanError("no such container");
    mockPodmanError("no such container");

    await expect(runtime.destroy(handle)).resolves.toBeUndefined();
  });

  it("uses handle.id as fallback when containerName not in data", async () => {
    const runtime = create();
    const handle: RuntimeHandle = {
      id: "fallback-id",
      runtimeName: "podman",
      data: {},
    };

    mockPodmanSuccess();
    mockPodmanSuccess();

    await runtime.destroy(handle);

    expect(mockExecFileCustom).toHaveBeenNthCalledWith(1, "podman", [
      "stop", "-t", "10", "fallback-id",
    ], { timeout: 30_000 });
  });
});

describe("runtime.sendMessage()", () => {
  it("calls podman exec with shellEscape to write message to /tmp/ao-input", async () => {
    const runtime = create();
    const handle = makeHandle("msg-test");

    mockPodmanSuccess();

    await runtime.sendMessage(handle, "hello world");

    expect(mockExecFileCustom).toHaveBeenCalledWith("podman", [
      "exec", "ao-msg-test",
      "sh", "-c", "printf '%s\\n' 'hello world' >> /tmp/ao-input",
    ], { timeout: 30_000 });
  });

  it("uses shellEscape to prevent shell injection", async () => {
    const runtime = create();
    const handle = makeHandle("msg-test");

    mockPodmanSuccess();

    await runtime.sendMessage(handle, "$(evil) `cmd`");

    const args = mockExecFileCustom.mock.calls[0][1] as string[];
    const shCmd = args[4];
    // shellEscape wraps in single quotes, preventing shell expansion
    expect(shCmd).toContain("'$(evil) `cmd`'");
    expect(shCmd).not.toContain("JSON");
  });

  it("uses handle.id fallback when containerName missing", async () => {
    const runtime = create();
    const handle: RuntimeHandle = {
      id: "fallback-id",
      runtimeName: "podman",
      data: {},
    };

    mockPodmanSuccess();

    await runtime.sendMessage(handle, "test");

    const args = mockExecFileCustom.mock.calls[0][1] as string[];
    expect(args[1]).toBe("fallback-id");
  });
});

describe("runtime.getOutput()", () => {
  it("reads from /tmp/ao-output with default line count", async () => {
    const runtime = create();
    const handle = makeHandle("output-test");

    mockPodmanSuccess("line1\nline2");

    const output = await runtime.getOutput(handle);

    expect(output).toBe("line1\nline2");
    expect(mockExecFileCustom).toHaveBeenCalledWith("podman", [
      "exec", "ao-output-test",
      "tail", "-n", "50", "/tmp/ao-output",
    ], { timeout: 30_000 });
  });

  it("passes custom line count", async () => {
    const runtime = create();
    const handle = makeHandle("output-custom");

    mockPodmanSuccess("output");

    await runtime.getOutput(handle, 100);

    expect(mockExecFileCustom).toHaveBeenCalledWith("podman", [
      "exec", "ao-output-custom",
      "tail", "-n", "100", "/tmp/ao-output",
    ], { timeout: 30_000 });
  });

  it("falls back to podman logs when exec fails", async () => {
    const runtime = create();
    const handle = makeHandle("output-fallback");

    // First exec (tail) fails
    mockPodmanError("file not found");
    // Fallback to podman logs
    mockPodmanSuccess("fallback output");

    const output = await runtime.getOutput(handle);

    expect(output).toBe("fallback output");
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(2, "podman", [
      "logs", "--tail", "50", "ao-output-fallback",
    ], { timeout: 30_000 });
  });

  it("returns empty string when both exec and logs fail", async () => {
    const runtime = create();
    const handle = makeHandle("output-err");

    mockPodmanError("file not found");
    mockPodmanError("container not found");

    const output = await runtime.getOutput(handle);
    expect(output).toBe("");
  });
});

describe("runtime.isAlive()", () => {
  it("returns true when container is running", async () => {
    const runtime = create();
    const handle = makeHandle("alive-test");

    mockPodmanSuccess("running");

    const alive = await runtime.isAlive(handle);

    expect(alive).toBe(true);
    expect(mockExecFileCustom).toHaveBeenCalledWith("podman", [
      "inspect", "--format", "{{.State.Status}}", "ao-alive-test",
    ], { timeout: 30_000 });
  });

  it("returns false when container status is not running", async () => {
    const runtime = create();
    const handle = makeHandle("stopped-test");

    mockPodmanSuccess("exited");

    const alive = await runtime.isAlive(handle);
    expect(alive).toBe(false);
  });

  it("returns false when inspect fails", async () => {
    const runtime = create();
    const handle = makeHandle("dead-test");

    mockPodmanError("no such container");

    const alive = await runtime.isAlive(handle);
    expect(alive).toBe(false);
  });
});

describe("runtime.getMetrics()", () => {
  it("returns uptimeMs based on createdAt", async () => {
    const runtime = create();
    const now = Date.now();
    const handle = makeHandle("metrics-test", { createdAt: now - 5000 });

    // podman stats call
    mockPodmanError("stats not available");

    const metrics = await runtime.getMetrics!(handle);

    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(5000);
    expect(metrics.uptimeMs).toBeLessThan(6000);
  });

  it("handles missing createdAt by using Date.now()", async () => {
    const runtime = create();
    const handle: RuntimeHandle = {
      id: "metrics-no-created",
      runtimeName: "podman",
      data: { containerName: "ao-metrics-no-created" },
    };

    mockPodmanError("stats not available");

    const metrics = await runtime.getMetrics!(handle);

    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(metrics.uptimeMs).toBeLessThan(1000);
  });

  it("parses memory and CPU from podman stats output", async () => {
    const runtime = create();
    const now = Date.now();
    const handle = makeHandle("metrics-stats", { createdAt: now - 1000 });

    mockPodmanSuccess("256.5MiB / 1.0GiB||12.34%");

    const metrics = await runtime.getMetrics!(handle);

    expect(metrics.memoryMb).toBeCloseTo(256.5);
    expect(metrics.cpuPercent).toBeCloseTo(12.34);
  });

  it("returns only uptimeMs when stats parsing fails", async () => {
    const runtime = create();
    const now = Date.now();
    const handle = makeHandle("metrics-no-stats", { createdAt: now - 2000 });

    mockPodmanSuccess("invalid-output");

    const metrics = await runtime.getMetrics!(handle);

    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(2000);
    expect(metrics.memoryMb).toBeUndefined();
    expect(metrics.cpuPercent).toBeUndefined();
  });
});

describe("runtime.getAttachInfo()", () => {
  it("returns docker type and podman exec command", async () => {
    const runtime = create();
    const handle = makeHandle("attach-test");

    const info = await runtime.getAttachInfo!(handle);

    expect(info).toEqual({
      type: "docker",
      target: "ao-attach-test",
      command: "podman exec -it ao-attach-test /bin/bash",
    });
  });

  it("uses handle.id fallback when containerName missing", async () => {
    const runtime = create();
    const handle: RuntimeHandle = {
      id: "fallback-id",
      runtimeName: "podman",
      data: {},
    };

    const info = await runtime.getAttachInfo!(handle);

    expect(info).toEqual({
      type: "docker",
      target: "fallback-id",
      command: "podman exec -it fallback-id /bin/bash",
    });
  });
});
