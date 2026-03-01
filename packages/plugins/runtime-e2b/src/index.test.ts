import { describe, it, expect } from "vitest";
import type { RuntimeCreateConfig, RuntimeHandle } from "@composio/ao-core";
import pluginDefault, { manifest, create } from "./index.js";

function makeConfig(): RuntimeCreateConfig {
  return {
    sessionId: "test-session",
    workspacePath: "/tmp/workspace",
    launchCommand: "node app.js",
    environment: {},
  };
}

function makeHandle(): RuntimeHandle {
  return {
    id: "sbx-123",
    runtimeName: "e2b",
    data: { createdAt: Date.now() },
  };
}

describe("manifest", () => {
  it("has name 'e2b' and slot 'runtime'", () => {
    expect(manifest.name).toBe("e2b");
    expect(manifest.slot).toBe("runtime");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.description).toBe("Runtime plugin: E2B cloud sandboxes");
  });

  it("default export includes manifest and create", () => {
    expect(pluginDefault.manifest).toBe(manifest);
    expect(pluginDefault.create).toBe(create);
  });
});

describe("create()", () => {
  it("returns a Runtime with name 'e2b'", () => {
    const runtime = create();
    expect(runtime.name).toBe("e2b");
  });

  it("runtime object has all required methods", () => {
    const runtime = create();
    expect(typeof runtime.create).toBe("function");
    expect(typeof runtime.destroy).toBe("function");
    expect(typeof runtime.sendMessage).toBe("function");
    expect(typeof runtime.getOutput).toBe("function");
    expect(typeof runtime.isAlive).toBe("function");
    expect(typeof runtime.getMetrics).toBe("function");
    expect(typeof runtime.getAttachInfo).toBe("function");
  });
});

describe("runtime.create()", () => {
  it("throws not-configured error with setup instructions", async () => {
    const runtime = create();
    await expect(runtime.create(makeConfig())).rejects.toThrow(
      "[runtime-e2b] create() failed:",
    );
  });

  it("error message mentions E2B_API_KEY", async () => {
    const runtime = create();
    await expect(runtime.create(makeConfig())).rejects.toThrow("E2B_API_KEY");
  });

  it("error message includes SDK install instructions", async () => {
    const runtime = create();
    await expect(runtime.create(makeConfig())).rejects.toThrow("pnpm add e2b");
  });
});

describe("runtime.destroy()", () => {
  it("throws not-configured error", async () => {
    const runtime = create();
    await expect(runtime.destroy(makeHandle())).rejects.toThrow(
      "[runtime-e2b] destroy() failed:",
    );
  });
});

describe("runtime.sendMessage()", () => {
  it("throws not-configured error", async () => {
    const runtime = create();
    await expect(
      runtime.sendMessage(makeHandle(), "hello"),
    ).rejects.toThrow("[runtime-e2b] sendMessage() failed:");
  });
});

describe("runtime.getOutput()", () => {
  it("throws not-configured error with default lines", async () => {
    const runtime = create();
    await expect(runtime.getOutput(makeHandle())).rejects.toThrow(
      "[runtime-e2b] getOutput() failed:",
    );
  });

  it("throws not-configured error with custom lines", async () => {
    const runtime = create();
    await expect(runtime.getOutput(makeHandle(), 100)).rejects.toThrow(
      "[runtime-e2b] getOutput() failed:",
    );
  });
});

describe("runtime.isAlive()", () => {
  it("throws not-configured error", async () => {
    const runtime = create();
    await expect(runtime.isAlive(makeHandle())).rejects.toThrow(
      "[runtime-e2b] isAlive() failed:",
    );
  });
});

describe("runtime.getMetrics()", () => {
  it("throws not-configured error", async () => {
    const runtime = create();
    await expect(runtime.getMetrics!(makeHandle())).rejects.toThrow(
      "[runtime-e2b] getMetrics() failed:",
    );
  });
});

describe("runtime.getAttachInfo()", () => {
  it("throws not-configured error", async () => {
    const runtime = create();
    await expect(runtime.getAttachInfo!(makeHandle())).rejects.toThrow(
      "[runtime-e2b] getAttachInfo() failed:",
    );
  });
});

describe("error message content", () => {
  it("includes link to documentation", async () => {
    const runtime = create();
    await expect(runtime.create(makeConfig())).rejects.toThrow(
      "https://e2b.dev/docs",
    );
  });

  it("includes sign up URL", async () => {
    const runtime = create();
    await expect(runtime.create(makeConfig())).rejects.toThrow(
      "https://e2b.dev",
    );
  });
});
