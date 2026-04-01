import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSessionManager } from "../../session-manager.js";
import type {
  ArtifactService,
  ArtifactEntry,
} from "../../types.js";
import { setupTestContext, teardownTestContext, type TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeEach(() => {
  ctx = setupTestContext();
});

afterEach(() => {
  teardownTestContext(ctx);
});

function createMockArtifactService(
  entries: ArtifactEntry[] = [],
  initialized = false,
): ArtifactService {
  return {
    name: "mock-artifact",
    init: vi.fn().mockResolvedValue(undefined),
    isInitialized: vi.fn().mockResolvedValue(initialized),
    publish: vi.fn(),
    publishReference: vi.fn(),
    list: vi.fn().mockResolvedValue(entries),
    get: vi.fn().mockResolvedValue(null),
    readContent: vi.fn().mockResolvedValue(null),
    grep: vi.fn().mockResolvedValue([]),
    updateStatus: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    rebuildManifest: vi.fn(),
  };
}

describe("spawn with artifact service", () => {
  it("initializes artifact service during spawn when factory is provided", async () => {
    const mockService = createMockArtifactService([], false);
    const factory = vi.fn().mockReturnValue(mockService);

    const sm = createSessionManager({
      config: ctx.config,
      registry: ctx.mockRegistry,
      createArtifactService: factory,
    });

    await sm.spawn({ projectId: "my-app" });

    // Factory should have been called with paths
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactsDir: expect.stringContaining("artifacts"),
        sessionsDir: expect.stringContaining("sessions"),
      }),
    );

    // Service should have been initialized since isInitialized returned false
    expect(mockService.init).toHaveBeenCalled();
    expect(mockService.list).toHaveBeenCalled();
  });

  it("skips artifact init when no factory is provided", async () => {
    const sm = createSessionManager({
      config: ctx.config,
      registry: ctx.mockRegistry,
    });

    // Should not throw — artifacts are optional
    const session = await sm.spawn({ projectId: "my-app" });
    expect(session.id).toBe("app-1");
  });

  it("does not re-init when artifacts are already initialized", async () => {
    const mockService = createMockArtifactService([], true);
    const factory = vi.fn().mockReturnValue(mockService);

    const sm = createSessionManager({
      config: ctx.config,
      registry: ctx.mockRegistry,
      createArtifactService: factory,
    });

    await sm.spawn({ projectId: "my-app" });

    expect(mockService.isInitialized).toHaveBeenCalled();
    expect(mockService.init).not.toHaveBeenCalled();
    expect(mockService.list).toHaveBeenCalled();
  });

  it("passes AO_ARTIFACTS_DIR env var when artifact context exists", async () => {
    const mockService = createMockArtifactService([], true);
    const factory = vi.fn().mockReturnValue(mockService);

    const sm = createSessionManager({
      config: ctx.config,
      registry: ctx.mockRegistry,
      createArtifactService: factory,
    });

    await sm.spawn({ projectId: "my-app" });

    // Check that the runtime was created with AO_ARTIFACTS_DIR in environment
    expect(ctx.mockRuntime.create).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: expect.objectContaining({
          AO_ARTIFACTS_DIR: expect.stringContaining("artifacts"),
        }),
      }),
    );
  });

  it("passes AO_ISSUE_ID env var from spawn config", async () => {
    const sm = createSessionManager({
      config: ctx.config,
      registry: ctx.mockRegistry,
    });

    await sm.spawn({ projectId: "my-app", issueId: "INT-42" });

    expect(ctx.mockRuntime.create).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: expect.objectContaining({
          AO_ISSUE_ID: "INT-42",
        }),
      }),
    );
  });

  it("passes empty AO_ISSUE_ID when no issue is specified", async () => {
    const sm = createSessionManager({
      config: ctx.config,
      registry: ctx.mockRegistry,
    });

    await sm.spawn({ projectId: "my-app" });

    expect(ctx.mockRuntime.create).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: expect.objectContaining({
          AO_ISSUE_ID: "",
        }),
      }),
    );
  });

  it("continues spawn when artifact service throws", async () => {
    const mockService = createMockArtifactService([], false);
    (mockService.init as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("disk full"),
    );
    const factory = vi.fn().mockReturnValue(mockService);

    const sm = createSessionManager({
      config: ctx.config,
      registry: ctx.mockRegistry,
      createArtifactService: factory,
    });

    // Should not throw — artifact errors are non-fatal
    const session = await sm.spawn({ projectId: "my-app" });
    expect(session.id).toBe("app-1");
  });

  it("continues spawn when artifact factory throws", async () => {
    const factory = vi.fn().mockImplementation(() => {
      throw new Error("bad config");
    });

    const sm = createSessionManager({
      config: ctx.config,
      registry: ctx.mockRegistry,
      createArtifactService: factory,
    });

    // Should not throw — resolveArtifactService catches
    const session = await sm.spawn({ projectId: "my-app" });
    expect(session.id).toBe("app-1");
  });

  it("builds artifact context with correct counts", async () => {
    const entries: ArtifactEntry[] = [
      {
        id: "a1",
        sessionId: "ses-1",
        filename: "doc.md",
        path: "ses-1/doc.md",
        mimeType: "text/markdown",
        category: "document",
        status: "published",
        size: 100,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "a2",
        sessionId: "ses-1",
        filename: "report.md",
        path: "ses-1/report.md",
        mimeType: "text/markdown",
        category: "test-report",
        status: "published",
        size: 200,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "a3",
        sessionId: "ses-2",
        filename: "log.txt",
        path: "ses-2/log.txt",
        mimeType: "text/plain",
        category: "log",
        status: "published",
        size: 50,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    const mockService = createMockArtifactService(entries, true);
    const factory = vi.fn().mockReturnValue(mockService);

    const sm = createSessionManager({
      config: ctx.config,
      registry: ctx.mockRegistry,
      createArtifactService: factory,
    });

    await sm.spawn({ projectId: "my-app" });

    // The prompt should include artifact context with 3 artifacts from 2 sessions
    // We verify indirectly via the agent's launch command getting a prompt with artifact info
    expect(ctx.mockAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("3 artifacts from 2 sessions"),
      }),
    );
  });
});
