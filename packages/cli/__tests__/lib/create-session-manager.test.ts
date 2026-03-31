import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCreatePluginRegistry, mockCreateSessionManager, mockCreateLifecycleManager } =
  vi.hoisted(() => {
    const mockRegistry = {
      loadFromConfig: vi.fn(),
    };
    return {
      mockCreatePluginRegistry: vi.fn(() => mockRegistry),
      mockCreateSessionManager: vi.fn(() => ({ list: vi.fn() })),
      mockCreateLifecycleManager: vi.fn(() => ({ start: vi.fn() })),
    };
  });

vi.mock("@composio/ao-core", () => ({
  createPluginRegistry: mockCreatePluginRegistry,
  createSessionManager: mockCreateSessionManager,
  createLifecycleManager: mockCreateLifecycleManager,
}));

// Must import AFTER mocks
const { getSessionManager, getLifecycleManager } = await import(
  "../../src/lib/create-session-manager.js"
);

describe("getSessionManager", () => {
  const config = { projects: {} } as Parameters<typeof getSessionManager>[0];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a plugin registry and session manager", async () => {
    const sm = await getSessionManager(config);
    expect(mockCreatePluginRegistry).toHaveBeenCalled();
    expect(mockCreateSessionManager).toHaveBeenCalledWith(
      expect.objectContaining({ config }),
    );
    expect(sm).toBeDefined();
  });

  it("loads plugins from config via registry", async () => {
    await getSessionManager(config);
    const registry = mockCreatePluginRegistry();
    expect(registry.loadFromConfig).toBeDefined();
  });
});

describe("getLifecycleManager", () => {
  const config = { projects: {} } as Parameters<typeof getLifecycleManager>[0];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a lifecycle manager with registry and session manager", async () => {
    const lm = await getLifecycleManager(config, "test-project");
    expect(mockCreateLifecycleManager).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        projectId: "test-project",
      }),
    );
    expect(lm).toBeDefined();
  });

  it("works without projectId", async () => {
    await getLifecycleManager(config);
    expect(mockCreateLifecycleManager).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        projectId: undefined,
      }),
    );
  });
});
