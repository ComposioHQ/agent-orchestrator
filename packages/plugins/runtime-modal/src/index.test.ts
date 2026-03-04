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
    id: "modal-123",
    runtimeName: "modal",
    data: { createdAt: Date.now() },
  };
}

describe("manifest", () => {
  it("has name 'modal' and slot 'runtime'", () => {
    expect(manifest.name).toBe("modal");
    expect(manifest.slot).toBe("runtime");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.description).toBe("Runtime plugin: Modal cloud compute");
  });

  it("default export includes manifest and create", () => {
    expect(pluginDefault.manifest).toBe(manifest);
    expect(pluginDefault.create).toBe(create);
  });
});

describe("create()", () => {
  it("returns a Runtime with name 'modal'", () => {
    const runtime = create();
    expect(runtime.name).toBe("modal");
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
      "[runtime-modal] create() failed:",
    );
  });

  it("error message mentions MODAL_TOKEN_ID and MODAL_TOKEN_SECRET", async () => {
    const runtime = create();
    await expect(runtime.create(makeConfig())).rejects.toThrow(
      "MODAL_TOKEN_ID",
    );
  });

  it("error message includes pip install instruction", async () => {
    const runtime = create();
    await expect(runtime.create(makeConfig())).rejects.toThrow(
      "pip install modal",
    );
  });
});

describe("runtime.destroy()", () => {
  it("throws not-configured error", async () => {
    const runtime = create();
    await expect(runtime.destroy(makeHandle())).rejects.toThrow(
      "[runtime-modal] destroy() failed:",
    );
  });
});

describe("runtime.sendMessage()", () => {
  it("throws not-configured error", async () => {
    const runtime = create();
    await expect(
      runtime.sendMessage(makeHandle(), "hello"),
    ).rejects.toThrow("[runtime-modal] sendMessage() failed:");
  });
});

describe("runtime.getOutput()", () => {
  it("throws not-configured error with default lines", async () => {
    const runtime = create();
    await expect(runtime.getOutput(makeHandle())).rejects.toThrow(
      "[runtime-modal] getOutput() failed:",
    );
  });

  it("throws not-configured error with custom lines", async () => {
    const runtime = create();
    await expect(runtime.getOutput(makeHandle(), 100)).rejects.toThrow(
      "[runtime-modal] getOutput() failed:",
    );
  });
});

describe("runtime.isAlive()", () => {
  it("throws not-configured error", async () => {
    const runtime = create();
    await expect(runtime.isAlive(makeHandle())).rejects.toThrow(
      "[runtime-modal] isAlive() failed:",
    );
  });
});

describe("runtime.getMetrics()", () => {
  it("throws not-configured error", async () => {
    const runtime = create();
    await expect(runtime.getMetrics!(makeHandle())).rejects.toThrow(
      "[runtime-modal] getMetrics() failed:",
    );
  });
});

describe("runtime.getAttachInfo()", () => {
  it("throws not-configured error", async () => {
    const runtime = create();
    await expect(runtime.getAttachInfo!(makeHandle())).rejects.toThrow(
      "[runtime-modal] getAttachInfo() failed:",
    );
  });
});

describe("error message content", () => {
  it("includes link to documentation", async () => {
    const runtime = create();
    await expect(runtime.create(makeConfig())).rejects.toThrow(
      "https://modal.com/docs",
    );
  });

  it("mentions modal token new for authentication", async () => {
    const runtime = create();
    await expect(runtime.create(makeConfig())).rejects.toThrow(
      "modal token new",
    );
  });
});
