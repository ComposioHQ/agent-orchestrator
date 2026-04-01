import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

const mockArtifactService = {
  name: "mock",
  init: vi.fn().mockResolvedValue(undefined),
  isInitialized: vi.fn().mockResolvedValue(true),
  publish: vi.fn(),
  publishReference: vi.fn(),
  list: vi.fn().mockResolvedValue([]),
  get: vi.fn().mockResolvedValue(null),
  readContent: vi.fn().mockResolvedValue(null),
  grep: vi.fn().mockResolvedValue([]),
  updateStatus: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  rebuildManifest: vi.fn(),
};

const mockCreateArtifactService = vi.hoisted(() => vi.fn());
const mockLoadConfig = vi.hoisted(() => vi.fn());

vi.mock("@composio/ao-core", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
  };
});

vi.mock("@composio/ao-plugin-artifact-file/artifact-service", () => ({
  createArtifactService: (...args: unknown[]) => mockCreateArtifactService(...args),
}));

import { registerArtifact } from "../../src/commands/artifact.js";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerArtifact(program);
  return program;
}

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateArtifactService.mockReturnValue(mockArtifactService);
  mockLoadConfig.mockReturnValue({
    configPath: "/tmp/ao.yaml",
    projects: {
      "my-app": {
        name: "My App",
        repo: "org/my-app",
        path: "/tmp/my-app",
        defaultBranch: "main",
        sessionPrefix: "app",
      },
    },
  });
  // Set env vars so resolveArtifactsDir uses the env path
  process.env.AO_ARTIFACTS_DIR = "/tmp/test-artifacts";
  process.env.AO_DATA_DIR = "/tmp/test-data";
  process.env.AO_PROJECT_ID = "my-app";
  process.env.AO_SESSION = "test-session-1";
  process.env.AO_ISSUE_ID = "INT-42";
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("artifact list", () => {
  it("shows 'No artifacts yet' when not initialized", async () => {
    mockArtifactService.isInitialized.mockResolvedValueOnce(false);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "ao", "artifact", "list"]);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("No artifacts yet"));
    log.mockRestore();
  });

  it("outputs JSON when --format json", async () => {
    const entries = [
      {
        id: "abc12345-full-id",
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
    ];
    mockArtifactService.list.mockResolvedValueOnce(entries);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "ao", "artifact", "list", "--format", "json"]);

    expect(log).toHaveBeenCalledWith(JSON.stringify(entries, null, 2));
    log.mockRestore();
  });

  it("outputs paths when --format paths", async () => {
    const entries = [
      {
        id: "abc12345",
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
    ];
    mockArtifactService.list.mockResolvedValueOnce(entries);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "ao", "artifact", "list", "--format", "paths"]);

    expect(log).toHaveBeenCalledWith("ses-1/doc.md");
    log.mockRestore();
  });

  it("shows reference URL for references in paths format", async () => {
    const entries = [
      {
        id: "ref12345",
        sessionId: "ses-1",
        filename: "pr-ref",
        path: "ses-1/pr-ref",
        mimeType: "application/x-reference",
        category: "pr",
        status: "published",
        size: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isReference: true,
        referenceUrl: "https://github.com/org/repo/pull/42",
      },
    ];
    mockArtifactService.list.mockResolvedValueOnce(entries);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "ao", "artifact", "list", "--format", "paths"]);

    expect(log).toHaveBeenCalledWith("https://github.com/org/repo/pull/42");
    log.mockRestore();
  });

  it("shows 'No matching artifacts' for empty table results", async () => {
    mockArtifactService.list.mockResolvedValueOnce([]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "ao", "artifact", "list"]);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("No matching artifacts"));
    log.mockRestore();
  });

  it("renders table with entries", async () => {
    const entries = [
      {
        id: "abc12345-full-id",
        sessionId: "ses-1",
        filename: "doc.md",
        path: "ses-1/doc.md",
        mimeType: "text/markdown",
        category: "document",
        status: "published",
        size: 1500,
        createdAt: new Date(Date.now() - 30 * 60000).toISOString(),
        updatedAt: new Date().toISOString(),
        description: "Test doc",
      },
    ];
    mockArtifactService.list.mockResolvedValueOnce(entries);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "ao", "artifact", "list"]);

    // Should have called log with header and at least one entry
    expect(log).toHaveBeenCalledTimes(3); // header + entry + count
    log.mockRestore();
  });

  it("passes filter options correctly", async () => {
    mockArtifactService.list.mockResolvedValueOnce([]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync([
      "node", "ao", "artifact", "list",
      "--session", "ses-1",
      "--category", "document",
      "--status", "published",
      "--last", "3",
    ]);

    expect(mockArtifactService.list).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "ses-1",
        category: "document",
        status: "published",
        lastN: 3,
      }),
    );
    log.mockRestore();
  });
});

describe("artifact publish", () => {
  it("requires session ID", async () => {
    delete process.env.AO_SESSION;
    const errLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });

    const program = createProgram();
    await expect(
      program.parseAsync(["node", "ao", "artifact", "publish", "/tmp/file.md"]),
    ).rejects.toThrow("exit");

    expect(errLog).toHaveBeenCalledWith(expect.stringContaining("No session ID"));
    errLog.mockRestore();
    mockExit.mockRestore();
  });

  it("publishes a file with correct metadata", async () => {
    const now = new Date().toISOString();
    mockArtifactService.publish.mockResolvedValueOnce({
      id: "new-artifact-id",
      sessionId: "test-session-1",
      filename: "file.md",
      path: "test-session-1/file.md",
      mimeType: "text/markdown",
      category: "document",
      status: "published",
      size: 100,
      createdAt: now,
      updatedAt: now,
    });

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync([
      "node", "ao", "artifact", "publish", "/tmp/file.md",
      "--category", "document",
      "--description", "Test document",
      "--tags", "test,doc",
    ]);

    expect(mockArtifactService.init).toHaveBeenCalled();
    expect(mockArtifactService.publish).toHaveBeenCalledWith(
      "test-session-1",
      expect.stringContaining("file.md"),
      expect.objectContaining({
        category: "document",
        description: "Test document",
        tags: ["test", "doc"],
        issueId: "INT-42",
      }),
    );
    log.mockRestore();
  });
});

describe("artifact publish-ref", () => {
  it("requires session ID", async () => {
    delete process.env.AO_SESSION;
    const errLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });

    const program = createProgram();
    await expect(
      program.parseAsync([
        "node", "ao", "artifact", "publish-ref",
        "--type", "pr",
        "--url", "https://github.com/org/repo/pull/1",
      ]),
    ).rejects.toThrow("exit");

    expect(errLog).toHaveBeenCalledWith(expect.stringContaining("No session ID"));
    errLog.mockRestore();
    mockExit.mockRestore();
  });

  it("publishes a reference artifact", async () => {
    const now = new Date().toISOString();
    mockArtifactService.publishReference.mockResolvedValueOnce({
      id: "ref-id",
      sessionId: "test-session-1",
      filename: "pr-ref-id",
      path: "test-session-1/pr-ref-id",
      mimeType: "application/x-reference",
      category: "pr",
      status: "published",
      size: 0,
      createdAt: now,
      updatedAt: now,
      isReference: true,
      referenceType: "pr",
      referenceUrl: "https://github.com/org/repo/pull/1",
    });

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync([
      "node", "ao", "artifact", "publish-ref",
      "--type", "pr",
      "--url", "https://github.com/org/repo/pull/1",
    ]);

    expect(mockArtifactService.publishReference).toHaveBeenCalledWith(
      "test-session-1",
      expect.objectContaining({
        referenceType: "pr",
        referenceUrl: "https://github.com/org/repo/pull/1",
        category: "pr",
      }),
    );
    log.mockRestore();
  });
});

describe("artifact show", () => {
  it("shows artifact metadata", async () => {
    const now = new Date().toISOString();
    mockArtifactService.get.mockResolvedValueOnce({
      entry: {
        id: "abc12345",
        sessionId: "ses-1",
        filename: "doc.md",
        path: "ses-1/doc.md",
        mimeType: "text/markdown",
        category: "document",
        status: "published",
        size: 100,
        createdAt: now,
        updatedAt: now,
        description: "A test doc",
        tags: ["test"],
      },
      absolutePath: "/tmp/artifacts/ses-1/doc.md",
    });
    mockArtifactService.readContent.mockResolvedValueOnce("# Hello\nWorld\n");

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "ao", "artifact", "show", "abc12345"]);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("Artifact Details"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("abc12345"));
    log.mockRestore();
  });

  it("exits with error for missing artifact", async () => {
    mockArtifactService.get.mockResolvedValueOnce(null);
    const errLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });

    const program = createProgram();
    await expect(
      program.parseAsync(["node", "ao", "artifact", "show", "nonexistent"]),
    ).rejects.toThrow("exit");

    expect(errLog).toHaveBeenCalledWith(expect.stringContaining("Artifact not found"));
    errLog.mockRestore();
    mockExit.mockRestore();
  });
});

describe("artifact read", () => {
  it("writes content to stdout", async () => {
    mockArtifactService.readContent.mockResolvedValueOnce("file contents here");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const program = createProgram();
    await program.parseAsync(["node", "ao", "artifact", "read", "abc12345"]);

    expect(write).toHaveBeenCalledWith("file contents here");
    write.mockRestore();
  });

  it("exits with error when content is null", async () => {
    mockArtifactService.readContent.mockResolvedValueOnce(null);
    const errLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });

    const program = createProgram();
    await expect(
      program.parseAsync(["node", "ao", "artifact", "read", "abc12345"]),
    ).rejects.toThrow("exit");

    expect(errLog).toHaveBeenCalledWith(expect.stringContaining("Cannot read artifact"));
    errLog.mockRestore();
    mockExit.mockRestore();
  });
});

describe("artifact update", () => {
  it("updates artifact metadata", async () => {
    const now = new Date().toISOString();
    mockArtifactService.update.mockResolvedValueOnce({
      id: "abc12345",
      sessionId: "ses-1",
      filename: "doc.md",
      path: "ses-1/doc.md",
      mimeType: "text/markdown",
      category: "document",
      status: "archived",
      size: 100,
      createdAt: now,
      updatedAt: now,
    });

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync([
      "node", "ao", "artifact", "update", "abc12345",
      "--status", "archived",
      "--description", "Updated description",
      "--tags", "new,tags",
    ]);

    expect(mockArtifactService.update).toHaveBeenCalledWith("abc12345", {
      status: "archived",
      description: "Updated description",
      tags: ["new", "tags"],
    });
    log.mockRestore();
  });
});

describe("artifact summary", () => {
  it("shows 'No artifacts yet' when not initialized", async () => {
    mockArtifactService.isInitialized.mockResolvedValueOnce(false);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "ao", "artifact", "summary"]);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("No artifacts yet"));
    log.mockRestore();
  });

  it("shows summary with artifact counts", async () => {
    const entries = [
      {
        id: "a1",
        sessionId: "ses-1",
        category: "document",
        status: "published",
        createdAt: new Date().toISOString(),
      },
      {
        id: "a2",
        sessionId: "ses-2",
        category: "pr",
        status: "published",
        createdAt: new Date().toISOString(),
      },
    ];
    mockArtifactService.list.mockResolvedValueOnce(entries);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "ao", "artifact", "summary"]);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("2 artifacts"));
    log.mockRestore();
  });

  it("shows 'No artifacts' when list is empty", async () => {
    mockArtifactService.list.mockResolvedValueOnce([]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "ao", "artifact", "summary"]);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("No artifacts"));
    log.mockRestore();
  });
});

describe("artifact grep", () => {
  it("shows 'No artifacts to search' when not initialized", async () => {
    mockArtifactService.isInitialized.mockResolvedValueOnce(false);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "ao", "artifact", "grep", "TODO"]);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("No artifacts to search"));
    log.mockRestore();
  });

  it("shows 'No matches' when grep returns empty", async () => {
    mockArtifactService.grep.mockResolvedValueOnce([]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "ao", "artifact", "grep", "nonexistent"]);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('No matches for "nonexistent"'));
    log.mockRestore();
  });

  it("shows matches when grep returns results", async () => {
    mockArtifactService.grep.mockResolvedValueOnce([
      {
        artifact: {
          id: "a1",
          sessionId: "ses-1",
          filename: "doc.md",
          path: "ses-1/doc.md",
          category: "document",
        },
        matches: [
          { line: 5, content: "TODO: fix this", context: "some context" },
        ],
      },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "ao", "artifact", "grep", "TODO"]);

    // Should show the match
    expect(log).toHaveBeenCalledWith(expect.stringContaining("1 match"));
    log.mockRestore();
  });
});

describe("artifact stats", () => {
  it("shows 'No artifacts yet' when not initialized", async () => {
    mockArtifactService.isInitialized.mockResolvedValueOnce(false);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "ao", "artifact", "stats"]);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("No artifacts yet"));
    log.mockRestore();
  });

  it("shows artifact statistics", async () => {
    const entries = [
      {
        id: "a1",
        sessionId: "ses-1",
        category: "document",
        status: "published",
        size: 1024,
        createdAt: new Date().toISOString(),
      },
      {
        id: "a2",
        sessionId: "ses-1",
        category: "document",
        status: "deleted",
        size: 512,
        createdAt: new Date().toISOString(),
      },
    ];
    mockArtifactService.list.mockResolvedValueOnce(entries);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "ao", "artifact", "stats"]);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("Artifact Stats"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("1 artifacts"));
    log.mockRestore();
  });
});

describe("artifact delete", () => {
  it("tombstones an artifact by default", async () => {
    mockArtifactService.delete.mockResolvedValueOnce(undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "ao", "artifact", "delete", "abc12345"]);

    expect(mockArtifactService.delete).toHaveBeenCalledWith("abc12345", {
      purge: undefined,
      deletedBy: "test-session-1",
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("tombstoned"));
    log.mockRestore();
  });

  it("purges when --purge is passed", async () => {
    mockArtifactService.delete.mockResolvedValueOnce(undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "ao", "artifact", "delete", "abc12345", "--purge"]);

    expect(mockArtifactService.delete).toHaveBeenCalledWith("abc12345", {
      purge: true,
      deletedBy: "test-session-1",
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("purged"));
    log.mockRestore();
  });
});

describe("resolveArtifactsDir", () => {
  it("uses AO_ARTIFACTS_DIR when set", async () => {
    process.env.AO_ARTIFACTS_DIR = "/custom/artifacts";
    mockArtifactService.list.mockResolvedValueOnce([]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "ao", "artifact", "list"]);

    expect(mockCreateArtifactService).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactsDir: "/custom/artifacts",
      }),
    );
    log.mockRestore();
  });
});
