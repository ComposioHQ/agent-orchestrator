import { describe, it, expect, vi, beforeEach } from "vitest";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import type { RuntimeHandle } from "@composio/ao-core";

// Mock node:child_process with custom promisify support
vi.mock("node:child_process", () => {
  const mockExecFile = vi.fn();
  (mockExecFile as any)[Symbol.for("nodejs.util.promisify.custom")] = vi.fn();
  return { execFile: mockExecFile };
});

// Mock node:crypto for deterministic UUIDs
vi.mock("node:crypto", () => ({
  randomUUID: () => "test-uuid-1234",
}));

// Mock node:fs for writeFileSync / unlinkSync
vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Get reference to the promisify-custom mock
const mockExecFileCustom = (childProcess.execFile as any)[
  Symbol.for("nodejs.util.promisify.custom")
] as ReturnType<typeof vi.fn>;

/** Queue a successful docker command with the given stdout. */
function mockDockerSuccess(stdout = "") {
  mockExecFileCustom.mockResolvedValueOnce({ stdout: stdout + "\n", stderr: "" });
}

/** Queue a failed docker command. */
function mockDockerError(message: string) {
  mockExecFileCustom.mockRejectedValueOnce(new Error(message));
}

/** Create a RuntimeHandle for testing. */
function makeHandle(id: string, createdAt?: number): RuntimeHandle {
  return {
    id,
    runtimeName: "docker",
    data: {
      createdAt: createdAt ?? 1000,
      workspacePath: "/tmp/workspace",
      image: "node:20-slim",
    },
  };
}

// Import after mocks are set up
import dockerPlugin, { manifest, create } from "./index.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("manifest", () => {
  it("has name 'docker' and slot 'runtime'", () => {
    expect(manifest.name).toBe("docker");
    expect(manifest.slot).toBe("runtime");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.description).toBe("Runtime plugin: Docker containers");
  });

  it("default export includes manifest and create", () => {
    expect(dockerPlugin.manifest).toBe(manifest);
    expect(dockerPlugin.create).toBe(create);
  });
});

describe("create()", () => {
  it("returns a Runtime with name 'docker'", () => {
    const runtime = create();
    expect(runtime.name).toBe("docker");
  });
});

describe("runtime.create()", () => {
  it("calls docker create and start with correct args", async () => {
    const runtime = create();

    // docker create
    mockDockerSuccess("container-id-abc");
    // docker start
    mockDockerSuccess();
    // docker exec (launch command)
    mockDockerSuccess();

    const handle = await runtime.create({
      sessionId: "test-session",
      workspacePath: "/tmp/workspace",
      launchCommand: "node app.js",
      environment: {},
    });

    expect(handle.id).toBe("test-session");
    expect(handle.runtimeName).toBe("docker");
    expect(handle.data.workspacePath).toBe("/tmp/workspace");

    // docker create call
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(1, "docker", [
      "create",
      "--name", "test-session",
      "-w", "/workspace",
      "-v", "/tmp/workspace:/workspace",
      "node:20-slim",
      "sleep", "infinity",
    ], { timeout: 30_000 });

    // docker start call
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(2, "docker", [
      "start", "test-session",
    ], { timeout: 30_000 });

    // docker exec call for launch command
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(3, "docker", [
      "exec", "-d", "test-session", "sh", "-c", "node app.js",
    ], { timeout: 30_000 });
  });

  it("includes -e KEY=VALUE flags for environment variables", async () => {
    const runtime = create();

    mockDockerSuccess("cid");
    mockDockerSuccess();
    mockDockerSuccess();

    await runtime.create({
      sessionId: "env-session",
      workspacePath: "/tmp/ws",
      launchCommand: "bash",
      environment: { AO_SESSION: "env-session", FOO: "bar" },
    });

    const createArgs = mockExecFileCustom.mock.calls[0][1] as string[];
    expect(createArgs).toContain("-e");
    expect(createArgs).toContain("AO_SESSION=env-session");
    expect(createArgs).toContain("FOO=bar");
  });

  it("rejects invalid container names with special characters", async () => {
    const runtime = create();

    await expect(
      runtime.create({
        sessionId: "bad name!",
        workspacePath: "/tmp/ws",
        launchCommand: "echo",
        environment: {},
      }),
    ).rejects.toThrow('Invalid container name "bad name!"');
  });

  it("rejects container names with dots", async () => {
    const runtime = create();

    await expect(
      runtime.create({
        sessionId: "bad.name",
        workspacePath: "/tmp/ws",
        launchCommand: "echo",
        environment: {},
      }),
    ).rejects.toThrow("Invalid container name");
  });

  it("uses custom image from config", async () => {
    const runtime = create({ image: "ubuntu:22.04" });

    mockDockerSuccess("cid");
    mockDockerSuccess();
    mockDockerSuccess();

    await runtime.create({
      sessionId: "custom-image",
      workspacePath: "/tmp/ws",
      launchCommand: "bash",
      environment: {},
    });

    const createArgs = mockExecFileCustom.mock.calls[0][1] as string[];
    expect(createArgs).toContain("ubuntu:22.04");
  });
});

describe("runtime.destroy()", () => {
  it("calls docker rm -f with the handle id", async () => {
    const runtime = create();
    const handle = makeHandle("destroy-test");

    mockDockerSuccess();

    await runtime.destroy(handle);

    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "docker",
      ["rm", "-f", "destroy-test"],
      { timeout: 30_000 },
    );
  });

  it("does not throw if container is already removed", async () => {
    const runtime = create();
    const handle = makeHandle("already-gone");

    mockDockerError("no such container");

    await expect(runtime.destroy(handle)).resolves.toBeUndefined();
  });
});

describe("runtime.sendMessage()", () => {
  it("copies message file to container and executes it", async () => {
    const runtime = create();
    const handle = makeHandle("msg-test");

    // docker cp
    mockDockerSuccess();
    // docker exec (cat + rm)
    mockDockerSuccess();

    await runtime.sendMessage(handle, "hello world");

    expect(mockExecFileCustom).toHaveBeenCalledTimes(2);

    // docker cp call
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(1, "docker", [
      "cp",
      expect.stringContaining("ao-docker-msg-test-uuid-1234.txt"),
      "msg-test:/tmp/ao-message.txt",
    ], { timeout: 30_000 });

    // docker exec call
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(2, "docker", [
      "exec",
      "msg-test",
      "sh",
      "-c",
      "cat /tmp/ao-message.txt && rm -f /tmp/ao-message.txt",
    ], { timeout: 30_000 });

    // Verify writeFileSync was called with the message + newline
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("ao-docker-msg-test-uuid-1234.txt"),
      "hello world\n",
      { encoding: "utf-8", mode: 0o600 },
    );

    // Verify unlinkSync was called for cleanup
    expect(fs.unlinkSync).toHaveBeenCalledWith(
      expect.stringContaining("ao-docker-msg-test-uuid-1234.txt"),
    );
  });

  it("cleans up temp file even on docker cp failure", async () => {
    const runtime = create();
    const handle = makeHandle("msg-fail");

    // docker cp fails
    mockDockerError("cp failed");

    await expect(runtime.sendMessage(handle, "hello")).rejects.toThrow("cp failed");

    // unlinkSync should still be called for temp file cleanup
    expect(fs.unlinkSync).toHaveBeenCalledWith(
      expect.stringContaining("ao-docker-msg-test-uuid-1234.txt"),
    );
  });
});

describe("runtime.getOutput()", () => {
  it("calls docker logs with correct args and default lines", async () => {
    const runtime = create();
    const handle = makeHandle("output-test");

    mockDockerSuccess("some output from docker");

    const output = await runtime.getOutput(handle);

    expect(output).toBe("some output from docker");
    expect(mockExecFileCustom).toHaveBeenCalledWith("docker", [
      "logs", "--tail", "50", "output-test",
    ], { timeout: 30_000 });
  });

  it("passes custom line count", async () => {
    const runtime = create();
    const handle = makeHandle("output-custom");

    mockDockerSuccess("output");

    await runtime.getOutput(handle, 100);

    expect(mockExecFileCustom).toHaveBeenCalledWith("docker", [
      "logs", "--tail", "100", "output-custom",
    ], { timeout: 30_000 });
  });

  it("returns empty string on error", async () => {
    const runtime = create();
    const handle = makeHandle("output-err");

    mockDockerError("container not found");

    const output = await runtime.getOutput(handle);
    expect(output).toBe("");
  });
});

describe("runtime.isAlive()", () => {
  it("returns true when container is running", async () => {
    const runtime = create();
    const handle = makeHandle("alive-test");

    mockDockerSuccess("true");

    const alive = await runtime.isAlive(handle);

    expect(alive).toBe(true);
    expect(mockExecFileCustom).toHaveBeenCalledWith("docker", [
      "inspect", "--format", "{{.State.Running}}", "alive-test",
    ], { timeout: 30_000 });
  });

  it("returns false when container is not running", async () => {
    const runtime = create();
    const handle = makeHandle("stopped-test");

    mockDockerSuccess("false");

    const alive = await runtime.isAlive(handle);
    expect(alive).toBe(false);
  });

  it("returns false when inspect fails", async () => {
    const runtime = create();
    const handle = makeHandle("dead-test");

    mockDockerError("no such container");

    const alive = await runtime.isAlive(handle);
    expect(alive).toBe(false);
  });
});

describe("runtime.getMetrics()", () => {
  it("returns uptimeMs based on createdAt", async () => {
    const runtime = create();
    const now = Date.now();
    const handle = makeHandle("metrics-test", now - 5000);

    const metrics = await runtime.getMetrics!(handle);

    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(5000);
    expect(metrics.uptimeMs).toBeLessThan(6000);
  });

  it("handles missing createdAt by using Date.now()", async () => {
    const runtime = create();
    const handle: RuntimeHandle = {
      id: "metrics-no-created",
      runtimeName: "docker",
      data: {},
    };

    const metrics = await runtime.getMetrics!(handle);

    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(metrics.uptimeMs).toBeLessThan(1000);
  });
});

describe("runtime.getAttachInfo()", () => {
  it("returns docker type and exec command", async () => {
    const runtime = create();
    const handle = makeHandle("attach-test");

    const info = await runtime.getAttachInfo!(handle);

    expect(info).toEqual({
      type: "docker",
      target: "attach-test",
      command: "docker exec -it attach-test /bin/sh",
    });
  });
});
