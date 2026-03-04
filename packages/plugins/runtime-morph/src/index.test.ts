import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RuntimeHandle } from "@composio/ao-core";

/** Build a mock fetch that returns a successful Morph API response */
function mockMorphOk(jsonBody: unknown = {}) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(jsonBody),
    text: () => Promise.resolve(""),
  });
}

/** Build a mock fetch that returns an error response */
function mockMorphError(status: number, body = "error") {
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
    runtimeName: "morph",
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
  process.env["MORPH_API_KEY"] = "test-morph-key";
  delete process.env["MORPH_API_URL"];
  delete process.env["MORPH_SNAPSHOT_ID"];
});

describe("manifest", () => {
  it("has name 'morph' and slot 'runtime'", () => {
    expect(manifest.name).toBe("morph");
    expect(manifest.slot).toBe("runtime");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.description).toBe(
      "Runtime plugin: Morph snapshot/branch sandboxes",
    );
  });

  it("default export includes manifest and create", () => {
    expect(pluginDefault.manifest).toBe(manifest);
    expect(pluginDefault.create).toBe(create);
  });
});

describe("create()", () => {
  it("returns a Runtime with name 'morph'", () => {
    const runtime = create();
    expect(runtime.name).toBe("morph");
  });
});

describe("runtime.create()", () => {
  it("POSTs to sandboxes API and executes launch command", async () => {
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
      // exec call
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
    expect(handle.runtimeName).toBe("morph");
    expect(handle.data["workspacePath"]).toBe("/tmp/ws");

    // First call: create sandbox
    const [createUrl, createOpts] = fetchMock.mock.calls[0];
    expect(createUrl).toBe("https://api.morph.so/v1/sandboxes");
    expect(createOpts.method).toBe("POST");
    expect(createOpts.headers["Authorization"]).toBe(
      "Bearer test-morph-key",
    );

    const createBody = JSON.parse(createOpts.body);
    expect(createBody.name).toBe("ao-test-session");
    expect(createBody.environment.FOO).toBe("bar");
    expect(createBody.environment.AO_SESSION_ID).toBe("test-session");

    // Second call: exec launch command
    const [execUrl, execOpts] = fetchMock.mock.calls[1];
    expect(execUrl).toContain("/sandboxes/sbx-new/exec");
    expect(execOpts.method).toBe("POST");
    const execBody = JSON.parse(execOpts.body);
    expect(execBody.command).toBe("node app.js");
    expect(execBody.background).toBe(true);
  });

  it("includes snapshot_id when MORPH_SNAPSHOT_ID is set", async () => {
    process.env["MORPH_SNAPSHOT_ID"] = "snap-123";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "sbx-snap", status: "running" }),
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

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.snapshot_id).toBe("snap-123");
  });

  it("uses custom API URL from MORPH_API_URL", async () => {
    process.env["MORPH_API_URL"] = "https://custom-morph.example.com/v2";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "sbx-c", status: "running" }),
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

    expect(fetchMock.mock.calls[0][0]).toContain(
      "https://custom-morph.example.com/v2/sandboxes",
    );
  });

  it("throws when MORPH_API_KEY is missing", async () => {
    delete process.env["MORPH_API_KEY"];
    const runtime = create();

    await expect(
      runtime.create({
        sessionId: "s1",
        workspacePath: "/tmp",
        launchCommand: "echo",
        environment: {},
      }),
    ).rejects.toThrow("MORPH_API_KEY environment variable is required");
  });

  it("throws on API HTTP error", async () => {
    const fetchMock = mockMorphError(500, "server error");
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    await expect(
      runtime.create({
        sessionId: "s1",
        workspacePath: "/tmp",
        launchCommand: "echo",
        environment: {},
      }),
    ).rejects.toThrow("Morph API error 500");
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
});

describe("runtime.destroy()", () => {
  it("sends DELETE to the sandbox endpoint", async () => {
    const fetchMock = mockMorphOk();
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    await runtime.destroy(makeHandle("sbx-del"));

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/sandboxes/sbx-del");
    expect(opts.method).toBe("DELETE");
  });

  it("does not throw if sandbox is already destroyed", async () => {
    const fetchMock = mockMorphError(404, "not found");
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    await expect(runtime.destroy(makeHandle("gone"))).resolves.toBeUndefined();
  });
});

describe("runtime.sendMessage()", () => {
  it("POSTs exec command with the message", async () => {
    const fetchMock = mockMorphOk();
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    await runtime.sendMessage(makeHandle("sbx-msg"), "hello world");

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/sandboxes/sbx-msg/exec");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body.command).toContain("hello world");
    expect(body.workdir).toBe("/");
  });
});

describe("runtime.getOutput()", () => {
  it("executes tail command and returns output", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ output: "line1\nline2" }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    const output = await runtime.getOutput(makeHandle());
    expect(output).toBe("line1\nline2");
  });

  it("uses default 50 lines", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ output: "out" }),
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
      json: () => Promise.resolve({ output: "out" }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    await runtime.getOutput(makeHandle(), 200);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.command).toContain("200");
  });

  it("returns empty string on error", async () => {
    const fetchMock = mockMorphError(500);
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    const output = await runtime.getOutput(makeHandle());
    expect(output).toBe("");
  });

  it("returns empty string when output is missing from response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(""),
    });
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
      json: () => Promise.resolve({ status: "stopped" }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    expect(await runtime.isAlive(makeHandle())).toBe(false);
  });

  it("returns false on API error", async () => {
    const fetchMock = mockMorphError(404);
    vi.stubGlobal("fetch", fetchMock);

    const runtime = create();
    expect(await runtime.isAlive(makeHandle())).toBe(false);
  });
});

describe("runtime.getMetrics()", () => {
  it("returns uptimeMs based on createdAt", async () => {
    const runtime = create();
    const now = Date.now();
    const handle = makeHandle("m1", now - 5000);

    const metrics = await runtime.getMetrics!(handle);
    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(5000);
    expect(metrics.uptimeMs).toBeLessThan(6000);
  });

  it("handles missing createdAt gracefully", async () => {
    const runtime = create();
    const handle: RuntimeHandle = {
      id: "m2",
      runtimeName: "morph",
      data: {},
    };

    const metrics = await runtime.getMetrics!(handle);
    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(metrics.uptimeMs).toBeLessThan(1000);
  });
});

describe("runtime.getAttachInfo()", () => {
  it("returns web type with morph connect command", async () => {
    const runtime = create();
    const handle = makeHandle("sbx-attach");

    const info = await runtime.getAttachInfo!(handle);
    expect(info).toEqual({
      type: "web",
      target: "sbx-attach",
      command: "morph connect sbx-attach",
    });
  });
});
