import { describe, it, expect, vi, beforeEach } from "vitest";
import * as childProcess from "node:child_process";
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

// Mock node:os for tmpdir
vi.mock("node:os", () => ({
  tmpdir: () => "/tmp",
}));

// Mock node:path for join
vi.mock("node:path", () => ({
  join: (...args: string[]) => args.join("/"),
}));

// Get reference to the promisify-custom mock
const mockExecFileCustom = (childProcess.execFile as any)[
  Symbol.for("nodejs.util.promisify.custom")
] as ReturnType<typeof vi.fn>;

/** Queue a successful kubectl command */
function mockKubectlSuccess(stdout = "") {
  mockExecFileCustom.mockResolvedValueOnce({ stdout: stdout + "\n", stderr: "" });
}

/** Queue a failed kubectl command */
function mockKubectlError(message: string) {
  mockExecFileCustom.mockRejectedValueOnce(new Error(message));
}

function makeHandle(
  id = "ao-test-session",
  namespace = "ao-sandboxes",
  createdAt?: number,
  useWarmPool = false,
): RuntimeHandle {
  return {
    id,
    runtimeName: "k8s-sandbox",
    data: {
      namespace,
      createdAt: createdAt ?? 1000,
      workspacePath: "/tmp/workspace",
      useWarmPool,
    },
  };
}

import pluginDefault, { manifest, create } from "./index.js";

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env["K8S_SANDBOX_NAMESPACE"];
  delete process.env["K8S_SANDBOX_IMAGE"];
  delete process.env["K8S_SANDBOX_RUNTIME_CLASS"];
  delete process.env["K8S_SANDBOX_WARM_POOL"];
});

describe("manifest", () => {
  it("has name 'k8s-sandbox' and slot 'runtime'", () => {
    expect(manifest.name).toBe("k8s-sandbox");
    expect(manifest.slot).toBe("runtime");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.description).toBe(
      "Runtime plugin: Kubernetes CRD sandboxes (warm pools, gVisor/Kata)",
    );
  });

  it("default export includes manifest and create", () => {
    expect(pluginDefault.manifest).toBe(manifest);
    expect(pluginDefault.create).toBe(create);
  });
});

describe("create()", () => {
  it("returns a Runtime with name 'k8s-sandbox'", () => {
    const runtime = create();
    expect(runtime.name).toBe("k8s-sandbox");
  });
});

describe("runtime.create()", () => {
  it("creates a pod and waits for it to be ready", async () => {
    const runtime = create();

    // kubectl apply (pod spec)
    mockKubectlSuccess("pod/ao-test-session created");
    // kubectl wait
    mockKubectlSuccess("pod/ao-test-session condition met");

    const handle = await runtime.create({
      sessionId: "test-session",
      workspacePath: "/tmp/workspace",
      launchCommand: "node app.js",
      environment: { FOO: "bar" },
    });

    expect(handle.id).toBe("ao-test-session");
    expect(handle.runtimeName).toBe("k8s-sandbox");
    expect(handle.data["namespace"]).toBe("ao-sandboxes");

    // First call: kubectl apply
    expect(mockExecFileCustom.mock.calls[0][0]).toBe("kubectl");
    expect(mockExecFileCustom.mock.calls[0][1]).toContain("apply");

    // Second call: kubectl wait
    expect(mockExecFileCustom.mock.calls[1][0]).toBe("kubectl");
    expect(mockExecFileCustom.mock.calls[1][1]).toContain("wait");
    expect(mockExecFileCustom.mock.calls[1][1]).toContain("--for=condition=Ready");
  });

  it("uses warm pool CRD when K8S_SANDBOX_WARM_POOL=true", async () => {
    process.env["K8S_SANDBOX_WARM_POOL"] = "true";
    const runtime = create();

    // kubectl apply -f tmpPath
    mockKubectlSuccess("sandboxclaim/ao-test-session created");
    // kubectl wait
    mockKubectlSuccess("condition met");

    const handle = await runtime.create({
      sessionId: "test-session",
      workspacePath: "/tmp/workspace",
      launchCommand: "node app.js",
      environment: {},
    });

    expect(handle.data["useWarmPool"]).toBe(true);
  });

  it("uses custom namespace from environment", async () => {
    process.env["K8S_SANDBOX_NAMESPACE"] = "custom-ns";
    const runtime = create();

    mockKubectlSuccess("created");
    mockKubectlSuccess("condition met");

    const handle = await runtime.create({
      sessionId: "test-session",
      workspacePath: "/tmp/workspace",
      launchCommand: "echo",
      environment: {},
    });

    expect(handle.data["namespace"]).toBe("custom-ns");
    const applyArgs = mockExecFileCustom.mock.calls[0][1] as string[];
    expect(applyArgs).toContain("custom-ns");
  });

  it("rejects invalid session IDs that produce bad K8s names", async () => {
    const runtime = create();

    // "ao--" after sanitization starts with "ao" but ends with "-", which fails the regex
    await expect(
      runtime.create({
        sessionId: "-",
        workspacePath: "/tmp",
        launchCommand: "echo",
        environment: {},
      }),
    ).rejects.toThrow("Cannot create valid K8s name");
  });
});

describe("runtime.destroy()", () => {
  it("deletes pod for non-warm-pool handle", async () => {
    const runtime = create();
    mockKubectlSuccess("pod deleted");

    await runtime.destroy(makeHandle("ao-test", "ao-sandboxes", 1000, false));

    expect(mockExecFileCustom).toHaveBeenCalledOnce();
    const args = mockExecFileCustom.mock.calls[0][1] as string[];
    expect(args).toContain("delete");
    expect(args).toContain("pod");
    expect(args).toContain("ao-test");
    expect(args).toContain("--ignore-not-found");
  });

  it("deletes sandboxclaim for warm-pool handle", async () => {
    const runtime = create();
    mockKubectlSuccess("sandboxclaim deleted");

    await runtime.destroy(makeHandle("ao-test", "ao-sandboxes", 1000, true));

    const args = mockExecFileCustom.mock.calls[0][1] as string[];
    expect(args).toContain("delete");
    expect(args).toContain("sandboxclaim");
    expect(args).toContain("ao-test");
  });

  it("does not throw if resource is already deleted", async () => {
    const runtime = create();
    mockKubectlError("not found");

    await expect(
      runtime.destroy(makeHandle()),
    ).resolves.toBeUndefined();
  });
});

describe("runtime.sendMessage()", () => {
  it("executes echo command inside the pod", async () => {
    const runtime = create();
    mockKubectlSuccess("");

    await runtime.sendMessage(makeHandle(), "hello world");

    expect(mockExecFileCustom).toHaveBeenCalledOnce();
    const args = mockExecFileCustom.mock.calls[0][1] as string[];
    expect(args).toContain("exec");
    expect(args).toContain("ao-test-session");
    expect(args).toContain("-c");
    expect(args).toContain("sandbox");
    expect(args).toContain("--");
  });
});

describe("runtime.getOutput()", () => {
  it("gets output via kubectl exec tail", async () => {
    const runtime = create();
    mockKubectlSuccess("line1\nline2");

    const output = await runtime.getOutput(makeHandle());
    expect(output).toBe("line1\nline2");
  });

  it("falls back to kubectl logs when exec fails", async () => {
    const runtime = create();
    mockKubectlError("exec failed");
    mockKubectlSuccess("log line 1");

    const output = await runtime.getOutput(makeHandle());
    expect(output).toBe("log line 1");
  });

  it("passes default 50 lines to tail", async () => {
    const runtime = create();
    mockKubectlSuccess("output");

    await runtime.getOutput(makeHandle());

    const args = mockExecFileCustom.mock.calls[0][1] as string[];
    expect(args).toContain("50");
  });

  it("passes custom line count", async () => {
    const runtime = create();
    mockKubectlSuccess("output");

    await runtime.getOutput(makeHandle(), 200);

    const args = mockExecFileCustom.mock.calls[0][1] as string[];
    expect(args).toContain("200");
  });

  it("returns empty string when both exec and logs fail", async () => {
    const runtime = create();
    mockKubectlError("exec failed");
    mockKubectlError("logs failed");

    const output = await runtime.getOutput(makeHandle());
    expect(output).toBe("");
  });
});

describe("runtime.isAlive()", () => {
  it("returns true when pod phase is 'Running'", async () => {
    const runtime = create();
    mockKubectlSuccess("Running");

    const alive = await runtime.isAlive(makeHandle());
    expect(alive).toBe(true);

    const args = mockExecFileCustom.mock.calls[0][1] as string[];
    expect(args).toContain("get");
    expect(args).toContain("pod");
    expect(args).toContain("-o");
    expect(args).toContain("jsonpath={.status.phase}");
  });

  it("returns false when pod phase is not 'Running'", async () => {
    const runtime = create();
    mockKubectlSuccess("Succeeded");

    const alive = await runtime.isAlive(makeHandle());
    expect(alive).toBe(false);
  });

  it("returns false when kubectl fails", async () => {
    const runtime = create();
    mockKubectlError("not found");

    const alive = await runtime.isAlive(makeHandle());
    expect(alive).toBe(false);
  });
});

describe("runtime.getMetrics()", () => {
  it("returns uptimeMs and parses kubectl top output", async () => {
    const runtime = create();
    const now = Date.now();
    const handle = makeHandle("ao-test", "ao-sandboxes", now - 5000);

    // kubectl top pod output
    mockKubectlSuccess("ao-test   250m   128Mi");

    const metrics = await runtime.getMetrics!(handle);
    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(5000);
    expect(metrics.uptimeMs).toBeLessThan(6000);
    expect(metrics.memoryMb).toBe(128);
    expect(metrics.cpuPercent).toBe(25); // 250m / 10
  });

  it("returns only uptimeMs when kubectl top fails", async () => {
    const runtime = create();
    const now = Date.now();
    const handle = makeHandle("ao-test", "ao-sandboxes", now - 3000);

    mockKubectlError("metrics not available");

    const metrics = await runtime.getMetrics!(handle);
    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(3000);
    expect(metrics.memoryMb).toBeUndefined();
    expect(metrics.cpuPercent).toBeUndefined();
  });

  it("handles missing createdAt gracefully", async () => {
    const runtime = create();
    const handle: RuntimeHandle = {
      id: "ao-test",
      runtimeName: "k8s-sandbox",
      data: {},
    };

    mockKubectlError("no metrics");

    const metrics = await runtime.getMetrics!(handle);
    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(metrics.uptimeMs).toBeLessThan(1000);
  });
});

describe("runtime.getAttachInfo()", () => {
  it("returns docker type with kubectl exec command", async () => {
    const runtime = create();
    const handle = makeHandle("ao-attach", "my-ns");

    const info = await runtime.getAttachInfo!(handle);
    expect(info).toEqual({
      type: "docker",
      target: "ao-attach",
      command:
        "kubectl exec -it ao-attach --namespace my-ns -c sandbox -- /bin/bash",
    });
  });

  it("uses default namespace when not specified in handle", async () => {
    const runtime = create();
    const handle: RuntimeHandle = {
      id: "ao-test",
      runtimeName: "k8s-sandbox",
      data: {},
    };

    const info = await runtime.getAttachInfo!(handle);
    expect(info.command).toContain("ao-sandboxes");
  });
});
