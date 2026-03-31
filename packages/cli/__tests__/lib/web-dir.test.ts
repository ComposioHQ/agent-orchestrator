import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockSpawn, mockExistsSync, mockSocket, mockRequireResolve } = vi.hoisted(() => {
  const mockRequireResolve = vi.fn();
  return {
    mockSpawn: vi.fn(),
    mockExistsSync: vi.fn(),
    mockSocket: vi.fn(),
    mockRequireResolve,
  };
});

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

vi.mock("node:net", () => ({
  Socket: mockSocket,
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
}));

vi.mock("node:module", () => ({
  createRequire: () => {
    const fn = Object.assign(() => {}, { resolve: mockRequireResolve });
    return fn;
  },
}));

import {
  isPortAvailable,
  findFreePort,
  MAX_PORT_SCAN,
  waitForPortAndOpen,
  buildDashboardEnv,
  findWebDir,
} from "../../src/lib/web-dir.js";

/** Helper: create a mock Socket that fires the given event after a microtask. */
function makeSocketMock(eventToFire: "connect" | "error" | "timeout") {
  const inst = {
    setTimeout: vi.fn(),
    once: vi.fn((event: string, cb: () => void) => {
      if (event === eventToFire) {
        // Use queueMicrotask for fast async resolution
        queueMicrotask(() => cb());
      }
      return inst;
    }),
    connect: vi.fn(),
    destroy: vi.fn(),
  };
  return inst;
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockExistsSync.mockReturnValue(false);
  // Default: require.resolve throws (package not found)
  mockRequireResolve.mockImplementation(() => {
    throw new Error("MODULE_NOT_FOUND");
  });
});

describe("isPortAvailable", () => {
  it("returns false when port is in use (connect succeeds)", async () => {
    const inst = makeSocketMock("connect");
    mockSocket.mockReturnValue(inst);

    const result = await isPortAvailable(3000);
    expect(result).toBe(false);
    expect(inst.connect).toHaveBeenCalledWith(3000, "127.0.0.1");
    expect(inst.destroy).toHaveBeenCalled();
  });

  it("returns true when port is free (ECONNREFUSED)", async () => {
    const inst = makeSocketMock("error");
    mockSocket.mockReturnValue(inst);

    const result = await isPortAvailable(3000);
    expect(result).toBe(true);
    expect(inst.destroy).toHaveBeenCalled();
  });

  it("returns true on timeout", async () => {
    const inst = makeSocketMock("timeout");
    mockSocket.mockReturnValue(inst);

    const result = await isPortAvailable(3000);
    expect(result).toBe(true);
    expect(inst.destroy).toHaveBeenCalled();
  });

  it("sets socket timeout to 300ms", async () => {
    const inst = makeSocketMock("error");
    mockSocket.mockReturnValue(inst);

    await isPortAvailable(8080);
    expect(inst.setTimeout).toHaveBeenCalledWith(300);
  });

  it("connects to 127.0.0.1 on the given port", async () => {
    const inst = makeSocketMock("error");
    mockSocket.mockReturnValue(inst);

    await isPortAvailable(9999);
    expect(inst.connect).toHaveBeenCalledWith(9999, "127.0.0.1");
  });
});

describe("findFreePort", () => {
  it("returns the first available port", async () => {
    let callIndex = 0;
    mockSocket.mockImplementation(() => {
      const idx = callIndex++;
      // First two ports in use, third free
      return makeSocketMock(idx < 2 ? "connect" : "error");
    });

    const port = await findFreePort(3000);
    expect(port).toBe(3002);
  });

  it("returns null if no free port found within maxScan", async () => {
    // All ports in use
    mockSocket.mockImplementation(() => makeSocketMock("connect"));

    const port = await findFreePort(3000, 3);
    expect(port).toBe(null);
  });

  it("returns the start port if it is available", async () => {
    mockSocket.mockImplementation(() => makeSocketMock("error"));

    const port = await findFreePort(5000);
    expect(port).toBe(5000);
  });

  it("uses MAX_PORT_SCAN as default maxScan", () => {
    expect(MAX_PORT_SCAN).toBe(100);
  });
});

describe("waitForPortAndOpen", () => {
  it("opens browser when port becomes available", async () => {
    const controller = new AbortController();
    let callIndex = 0;

    mockSocket.mockImplementation(() => {
      const idx = callIndex++;
      // First call: port free (error = ECONNREFUSED). Second call: port occupied (connect succeeds).
      return makeSocketMock(idx < 1 ? "error" : "connect");
    });

    const mockBrowser = { on: vi.fn() };
    mockSpawn.mockReturnValue(mockBrowser);

    await waitForPortAndOpen(3000, "http://localhost:3000", controller.signal, 5_000);

    expect(mockSpawn).toHaveBeenCalled();
    const spawnCall = mockSpawn.mock.calls[0];
    // Platform-dependent open command
    expect(["open", "xdg-open", "cmd.exe"]).toContain(spawnCall[0]);
  });

  it("stops polling when signal is aborted", async () => {
    const controller = new AbortController();

    // Port always free
    mockSocket.mockImplementation(() => makeSocketMock("error"));

    // Abort after 100ms
    setTimeout(() => controller.abort(), 100);

    await waitForPortAndOpen(3000, "http://localhost:3000", controller.signal, 10_000);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("gives up after timeoutMs", async () => {
    const controller = new AbortController();

    // Port always free
    mockSocket.mockImplementation(() => makeSocketMock("error"));

    await waitForPortAndOpen(3000, "http://localhost:3000", controller.signal, 500);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("passes URL as argument to spawn", async () => {
    const controller = new AbortController();

    // Port immediately occupied
    mockSocket.mockImplementation(() => makeSocketMock("connect"));

    const mockBrowser = { on: vi.fn() };
    mockSpawn.mockReturnValue(mockBrowser);

    await waitForPortAndOpen(4000, "http://localhost:4000/dashboard", controller.signal, 5_000);

    expect(mockSpawn).toHaveBeenCalled();
    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toContain("http://localhost:4000/dashboard");
  });
});

describe("buildDashboardEnv", () => {
  /** Helper to make all ports free for auto-detect. */
  function allPortsFree() {
    mockSocket.mockImplementation(() => makeSocketMock("error"));
  }

  it("sets PORT in the returned env", async () => {
    allPortsFree();
    const env = await buildDashboardEnv(3000, null);
    expect(env["PORT"]).toBe("3000");
  });

  it("sets AO_CONFIG_PATH when provided", async () => {
    allPortsFree();
    const env = await buildDashboardEnv(3000, "/path/to/config.yaml");
    expect(env["AO_CONFIG_PATH"]).toBe("/path/to/config.yaml");
  });

  it("does not set AO_CONFIG_PATH when configPath is null", async () => {
    allPortsFree();
    const origConfigPath = process.env["AO_CONFIG_PATH"];
    delete process.env["AO_CONFIG_PATH"];

    const env = await buildDashboardEnv(3000, null);
    expect(env["AO_CONFIG_PATH"]).toBeUndefined();

    if (origConfigPath !== undefined) process.env["AO_CONFIG_PATH"] = origConfigPath;
  });

  it("uses explicit terminal ports when both are provided", async () => {
    const env = await buildDashboardEnv(3000, null, 15000, 15001);
    expect(env["TERMINAL_PORT"]).toBe("15000");
    expect(env["DIRECT_TERMINAL_PORT"]).toBe("15001");
    expect(env["NEXT_PUBLIC_TERMINAL_PORT"]).toBe("15000");
    expect(env["NEXT_PUBLIC_DIRECT_TERMINAL_PORT"]).toBe("15001");
  });

  it("derives direct terminal port from terminal port when only terminal is set", async () => {
    const env = await buildDashboardEnv(3000, null, 16000);
    expect(env["TERMINAL_PORT"]).toBe("16000");
    expect(env["DIRECT_TERMINAL_PORT"]).toBe("16001");
  });

  it("derives terminal port from direct terminal port when only direct is set", async () => {
    const env = await buildDashboardEnv(3000, null, undefined, 16001);
    expect(env["TERMINAL_PORT"]).toBe("16000");
    expect(env["DIRECT_TERMINAL_PORT"]).toBe("16001");
  });

  it("auto-detects ports when neither is explicitly set", async () => {
    allPortsFree();
    const origTerminal = process.env["TERMINAL_PORT"];
    const origDirect = process.env["DIRECT_TERMINAL_PORT"];
    delete process.env["TERMINAL_PORT"];
    delete process.env["DIRECT_TERMINAL_PORT"];

    const env = await buildDashboardEnv(3000, null);
    expect(env["TERMINAL_PORT"]).toBe("14800");
    expect(env["DIRECT_TERMINAL_PORT"]).toBe("14801");

    if (origTerminal !== undefined) process.env["TERMINAL_PORT"] = origTerminal;
    else delete process.env["TERMINAL_PORT"];
    if (origDirect !== undefined) process.env["DIRECT_TERMINAL_PORT"] = origDirect;
    else delete process.env["DIRECT_TERMINAL_PORT"];
  });

  it("respects TERMINAL_PORT env var when no explicit port args given", async () => {
    const origTerminal = process.env["TERMINAL_PORT"];
    const origDirect = process.env["DIRECT_TERMINAL_PORT"];
    process.env["TERMINAL_PORT"] = "20000";
    delete process.env["DIRECT_TERMINAL_PORT"];

    const env = await buildDashboardEnv(3000, null);
    expect(env["TERMINAL_PORT"]).toBe("20000");
    expect(env["DIRECT_TERMINAL_PORT"]).toBe("20001");

    if (origTerminal !== undefined) process.env["TERMINAL_PORT"] = origTerminal;
    else delete process.env["TERMINAL_PORT"];
    if (origDirect !== undefined) process.env["DIRECT_TERMINAL_PORT"] = origDirect;
    else delete process.env["DIRECT_TERMINAL_PORT"];
  });

  it("respects DIRECT_TERMINAL_PORT env var when no explicit port args given", async () => {
    const origTerminal = process.env["TERMINAL_PORT"];
    const origDirect = process.env["DIRECT_TERMINAL_PORT"];
    delete process.env["TERMINAL_PORT"];
    process.env["DIRECT_TERMINAL_PORT"] = "20001";

    const env = await buildDashboardEnv(3000, null);
    expect(env["TERMINAL_PORT"]).toBe("20000");
    expect(env["DIRECT_TERMINAL_PORT"]).toBe("20001");

    if (origTerminal !== undefined) process.env["TERMINAL_PORT"] = origTerminal;
    else delete process.env["TERMINAL_PORT"];
    if (origDirect !== undefined) process.env["DIRECT_TERMINAL_PORT"] = origDirect;
    else delete process.env["DIRECT_TERMINAL_PORT"];
  });

  it("spreads process.env into returned env", async () => {
    allPortsFree();
    const env = await buildDashboardEnv(3000, null, 100, 101);
    // process.env keys should be present
    expect(env["PATH"]).toBeDefined();
  });
});

describe("findWebDir", () => {
  it("returns resolved path from require.resolve when package is installed", () => {
    mockRequireResolve.mockReturnValue("/some/node_modules/@composio/ao-web/package.json");

    const result = findWebDir();
    expect(result).toMatch(/ao-web$/);
    expect(mockRequireResolve).toHaveBeenCalledWith("@composio/ao-web/package.json");
  });

  it("falls back to monorepo sibling when require.resolve fails", () => {
    mockRequireResolve.mockImplementation(() => {
      throw new Error("MODULE_NOT_FOUND");
    });

    // First candidate has package.json
    mockExistsSync.mockReturnValueOnce(true);

    const result = findWebDir();
    expect(typeof result).toBe("string");
  });

  it("tries multiple fallback candidates", () => {
    mockRequireResolve.mockImplementation(() => {
      throw new Error("MODULE_NOT_FOUND");
    });

    // First candidate fails, second succeeds
    mockExistsSync.mockReturnValueOnce(false).mockReturnValueOnce(true);

    const result = findWebDir();
    expect(typeof result).toBe("string");
  });

  it("throws with helpful error when package not found anywhere", () => {
    mockRequireResolve.mockImplementation(() => {
      throw new Error("MODULE_NOT_FOUND");
    });
    mockExistsSync.mockReturnValue(false);

    expect(() => findWebDir()).toThrow("Could not find @composio/ao-web package");
  });

  it("error message includes npm install hint", () => {
    mockRequireResolve.mockImplementation(() => {
      throw new Error("MODULE_NOT_FOUND");
    });
    mockExistsSync.mockReturnValue(false);

    expect(() => findWebDir()).toThrow("npm install -g @composio/ao");
  });

  it("error message includes pnpm build hint", () => {
    mockRequireResolve.mockImplementation(() => {
      throw new Error("MODULE_NOT_FOUND");
    });
    mockExistsSync.mockReturnValue(false);

    expect(() => findWebDir()).toThrow("pnpm install && pnpm build");
  });
});
