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

/** Queue a successful command */
function mockCmdSuccess(stdout = "") {
  mockExecFileCustom.mockResolvedValueOnce({ stdout: stdout + "\n", stderr: "" });
}

/** Queue a failed command */
function mockCmdError(message: string) {
  mockExecFileCustom.mockRejectedValueOnce(new Error(message));
}

function makeHandle(
  id = "ao-test-session",
  createdAt?: number,
): RuntimeHandle {
  return {
    id,
    runtimeName: "nspawn",
    data: {
      machinePath: "/var/lib/machines/ao-test-session",
      createdAt: createdAt ?? 1000,
      workspacePath: "/tmp/workspace",
    },
  };
}

import pluginDefault, { manifest, create } from "./index.js";

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env["NSPAWN_MACHINES_DIR"];
  delete process.env["NSPAWN_BASE_IMAGE"];
});

describe("manifest", () => {
  it("has name 'nspawn' and slot 'runtime'", () => {
    expect(manifest.name).toBe("nspawn");
    expect(manifest.slot).toBe("runtime");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.description).toBe(
      "Runtime plugin: systemd-nspawn (lightweight Linux containers)",
    );
  });

  it("default export includes manifest and create", () => {
    expect(pluginDefault.manifest).toBe(manifest);
    expect(pluginDefault.create).toBe(create);
  });
});

describe("create()", () => {
  it("returns a Runtime with name 'nspawn'", () => {
    const runtime = create();
    expect(runtime.name).toBe("nspawn");
  });
});

describe("runtime.create()", () => {
  it("creates machine directory, starts with systemd-run, and executes launch command", async () => {
    const runtime = create();

    // mkdir -p (create machine directories)
    mockCmdSuccess("");
    // systemd-run (start nspawn)
    mockCmdSuccess("");
    // machinectl status (readiness check) -- returns State: running
    mockCmdSuccess("State: running");
    // machinectl shell (execute launch command via nspawnExec)
    mockCmdSuccess("");

    const handle = await runtime.create({
      sessionId: "test-session",
      workspacePath: "/tmp/workspace",
      launchCommand: "node app.js",
      environment: { FOO: "bar" },
    });

    expect(handle.id).toBe("ao-test-session");
    expect(handle.runtimeName).toBe("nspawn");
    expect(handle.data["machinePath"]).toBe(
      "/var/lib/machines/ao-test-session",
    );

    // mkdir call
    expect(mockExecFileCustom.mock.calls[0][0]).toBe("mkdir");

    // systemd-run call
    expect(mockExecFileCustom.mock.calls[1][0]).toBe("systemd-run");
    const sysArgs = mockExecFileCustom.mock.calls[1][1] as string[];
    expect(sysArgs).toContain("--unit");
    expect(sysArgs).toContain("systemd-nspawn");
    expect(sysArgs.some((a: string) => a.includes("--setenv=FOO=bar"))).toBe(true);
    expect(sysArgs.some((a: string) => a.includes("--setenv=AO_SESSION_ID=test-session"))).toBe(true);
  });

  it("clones from base image when NSPAWN_BASE_IMAGE is set", async () => {
    process.env["NSPAWN_BASE_IMAGE"] = "base-ubuntu";
    const runtime = create();

    // machinectl clone
    mockCmdSuccess("");
    // systemd-run
    mockCmdSuccess("");
    // machinectl status (readiness)
    mockCmdSuccess("State: running");
    // nspawnExec (launch command)
    mockCmdSuccess("");

    await runtime.create({
      sessionId: "test-session",
      workspacePath: "/tmp/workspace",
      launchCommand: "bash",
      environment: {},
    });

    // First call should be machinectl clone
    expect(mockExecFileCustom.mock.calls[0][0]).toBe("machinectl");
    const cloneArgs = mockExecFileCustom.mock.calls[0][1] as string[];
    expect(cloneArgs).toContain("clone");
    expect(cloneArgs).toContain("base-ubuntu");
    expect(cloneArgs).toContain("ao-test-session");
  });

  it("uses custom machines dir from NSPAWN_MACHINES_DIR", async () => {
    process.env["NSPAWN_MACHINES_DIR"] = "/custom/machines";
    const runtime = create();

    // mkdir
    mockCmdSuccess("");
    // systemd-run
    mockCmdSuccess("");
    // machinectl status
    mockCmdSuccess("State: running");
    // nspawnExec
    mockCmdSuccess("");

    const handle = await runtime.create({
      sessionId: "test-session",
      workspacePath: "/tmp/ws",
      launchCommand: "bash",
      environment: {},
    });

    expect(handle.data["machinePath"]).toBe(
      "/custom/machines/ao-test-session",
    );
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
    ).rejects.toThrow("Cannot create valid nspawn machine name");
  });

  it("cleans up and throws when machine does not become ready", async () => {
    const runtime = create();

    // mkdir
    mockCmdSuccess("");
    // systemd-run
    mockCmdSuccess("");
    // 15 machinectl status attempts that don't show running
    for (let i = 0; i < 15; i++) {
      mockCmdSuccess("State: initializing");
    }
    // machinectl terminate (cleanup)
    mockCmdSuccess("");
    // machinectl remove (cleanup)
    mockCmdSuccess("");

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
  it("powers off and removes the machine", async () => {
    const runtime = create();

    // machinectl poweroff
    mockCmdSuccess("");
    // machinectl status (check if still running) -> error = gone
    mockCmdError("Machine not found");
    // machinectl remove
    mockCmdSuccess("");

    await runtime.destroy(makeHandle());

    // poweroff call
    expect(mockExecFileCustom.mock.calls[0][0]).toBe("machinectl");
    expect(mockExecFileCustom.mock.calls[0][1]).toContain("poweroff");
  });

  it("falls back to terminate if poweroff fails", async () => {
    const runtime = create();

    // machinectl poweroff -> fails
    mockCmdError("poweroff failed");
    // machinectl terminate
    mockCmdSuccess("");
    // machinectl remove
    mockCmdSuccess("");

    await expect(runtime.destroy(makeHandle())).resolves.toBeUndefined();
  });

  it("does not throw if machine is already gone", async () => {
    const runtime = create();

    // machinectl poweroff -> fails
    mockCmdError("not found");
    // machinectl terminate -> fails
    mockCmdError("not found");
    // machinectl remove -> fails
    mockCmdError("not found");

    await expect(runtime.destroy(makeHandle())).resolves.toBeUndefined();
  });
});

describe("runtime.sendMessage()", () => {
  it("executes printf command via machinectl shell", async () => {
    const runtime = create();
    mockCmdSuccess("");

    await runtime.sendMessage(makeHandle(), "hello world");

    expect(mockExecFileCustom).toHaveBeenCalledOnce();
    const args = mockExecFileCustom.mock.calls[0][1] as string[];
    expect(args[0]).toBe("shell");
    expect(args[1]).toBe("ao-test-session");
    expect(args).toContain("/bin/sh");
    const cmdArg = args[args.length - 1];
    expect(cmdArg).toContain("printf");
    expect(cmdArg).toContain("'hello world'");
    expect(cmdArg).not.toMatch(/echo\s+/);
  });

  it("wraps message in single quotes to prevent shell injection", async () => {
    const runtime = create();
    mockCmdSuccess("");

    await runtime.sendMessage(makeHandle(), "$(rm -rf /)");

    const args = mockExecFileCustom.mock.calls[0][1] as string[];
    const cmdArg = args[args.length - 1];
    // shellEscape wraps in single quotes — $(rm -rf /) becomes '$(rm -rf /)'
    expect(cmdArg).toContain("'$(rm -rf /)'");
    expect(cmdArg).toContain("printf");
  });
});

describe("runtime.getOutput()", () => {
  it("gets output via machinectl shell tail", async () => {
    const runtime = create();
    mockCmdSuccess("line1\nline2");

    const output = await runtime.getOutput(makeHandle());
    expect(output).toBe("line1\nline2");
  });

  it("passes default 50 lines", async () => {
    const runtime = create();
    mockCmdSuccess("output");

    await runtime.getOutput(makeHandle());

    const args = mockExecFileCustom.mock.calls[0][1] as string[];
    const cmdArg = args[args.length - 1] as string;
    expect(cmdArg).toContain("50");
  });

  it("passes custom line count", async () => {
    const runtime = create();
    mockCmdSuccess("output");

    await runtime.getOutput(makeHandle(), 200);

    const args = mockExecFileCustom.mock.calls[0][1] as string[];
    const cmdArg = args[args.length - 1] as string;
    expect(cmdArg).toContain("200");
  });

  it("returns empty string on error", async () => {
    const runtime = create();
    mockCmdError("exec failed");

    const output = await runtime.getOutput(makeHandle());
    expect(output).toBe("");
  });
});

describe("runtime.isAlive()", () => {
  it("returns true when machine state is running", async () => {
    const runtime = create();
    mockCmdSuccess("State=running");

    const alive = await runtime.isAlive(makeHandle());
    expect(alive).toBe(true);

    const args = mockExecFileCustom.mock.calls[0][1] as string[];
    expect(args).toContain("show");
    expect(args).toContain("--property=State");
  });

  it("returns false when machine state is not running", async () => {
    const runtime = create();
    mockCmdSuccess("State=exited");

    const alive = await runtime.isAlive(makeHandle());
    expect(alive).toBe(false);
  });

  it("returns false when machinectl fails", async () => {
    const runtime = create();
    mockCmdError("not found");

    const alive = await runtime.isAlive(makeHandle());
    expect(alive).toBe(false);
  });
});

describe("runtime.getMetrics()", () => {
  it("returns uptimeMs and parses memory from machinectl status", async () => {
    const runtime = create();
    const now = Date.now();
    const handle = makeHandle("ao-test", now - 5000);

    mockCmdSuccess("Memory: 256.5M");

    const metrics = await runtime.getMetrics!(handle);
    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(5000);
    expect(metrics.uptimeMs).toBeLessThan(6000);
    expect(metrics.memoryMb).toBeCloseTo(256.5, 1);
  });

  it("returns only uptimeMs when machinectl status fails", async () => {
    const runtime = create();
    const now = Date.now();
    const handle = makeHandle("ao-test", now - 3000);

    mockCmdError("status failed");

    const metrics = await runtime.getMetrics!(handle);
    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(3000);
    expect(metrics.memoryMb).toBeUndefined();
  });

  it("handles missing createdAt gracefully", async () => {
    const runtime = create();
    const handle: RuntimeHandle = {
      id: "ao-test",
      runtimeName: "nspawn",
      data: {},
    };

    mockCmdError("no status");

    const metrics = await runtime.getMetrics!(handle);
    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(metrics.uptimeMs).toBeLessThan(1000);
  });
});

describe("runtime.getAttachInfo()", () => {
  it("returns nspawn type with machinectl shell command", async () => {
    const runtime = create();
    const handle = makeHandle("ao-attach");

    const info = await runtime.getAttachInfo!(handle);
    expect(info).toEqual({
      type: "nspawn",
      target: "ao-attach",
      command: "machinectl shell ao-attach",
    });
  });
});
