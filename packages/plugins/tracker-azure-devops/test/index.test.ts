import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock("node:https", () => ({
  request: requestMock,
}));

import { create, manifest } from "../src/index.js";
import type { ProjectConfig } from "@composio/ao-core";

const project: ProjectConfig = {
  name: "test",
  repo: "acme/repo",
  path: "/tmp/repo",
  defaultBranch: "main",
  sessionPrefix: "test",
  tracker: {
    plugin: "azure-devops",
    organizationUrl: "https://dev.azure.com/acme",
    project: "My Project",
  },
};

const sampleWorkItem = {
  id: 123,
  fields: {
    "System.Title": "Fix login bug",
    "System.Description": "Users cannot log in with SSO",
    "System.State": "Active",
    "System.Tags": "bug; high-priority",
    "System.AssignedTo": { displayName: "Alice Smith", uniqueName: "alice@example.com" },
  },
  _links: {
    html: {
      href: "https://dev.azure.com/acme/My%20Project/_workitems/edit/123",
    },
  },
};

function mockAzureDevOpsResponse(responseData: unknown, statusCode = 200): void {
  const body = JSON.stringify(responseData);
  requestMock.mockImplementationOnce(
    (
      _opts: Record<string, unknown>,
      callback: (res: EventEmitter & { statusCode: number }) => void,
    ) => {
      const req = Object.assign(new EventEmitter(), {
        write: vi.fn(),
        end: vi.fn(() => {
          const res = Object.assign(new EventEmitter(), { statusCode });
          callback(res);
          process.nextTick(() => {
            res.emit("data", Buffer.from(body));
            res.emit("end");
          });
        }),
        destroy: vi.fn(),
        setTimeout: vi.fn(),
      });
      return req;
    },
  );
}

describe("tracker-azure-devops plugin", () => {
  let tracker: ReturnType<typeof create>;
  let savedPat: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    savedPat = process.env["AZURE_DEVOPS_PAT"];
    process.env["AZURE_DEVOPS_PAT"] = "test-pat";
    tracker = create();
  });

  afterEach(() => {
    if (savedPat === undefined) {
      delete process.env["AZURE_DEVOPS_PAT"];
    } else {
      process.env["AZURE_DEVOPS_PAT"] = savedPat;
    }
  });

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("azure-devops");
      expect(manifest.slot).toBe("tracker");
      expect(manifest.version).toBe("0.1.0");
    });
  });

  describe("create()", () => {
    it("returns a Tracker with correct name", () => {
      expect(tracker.name).toBe("azure-devops");
    });
  });

  describe("getIssue", () => {
    it("returns Issue with mapped fields", async () => {
      mockAzureDevOpsResponse(sampleWorkItem);
      const issue = await tracker.getIssue("123", project);

      expect(issue).toEqual({
        id: "123",
        title: "Fix login bug",
        description: "Users cannot log in with SSO",
        url: "https://dev.azure.com/acme/My%20Project/_workitems/edit/123",
        state: "in_progress",
        labels: ["bug", "high-priority"],
        assignee: "Alice Smith",
      });
    });

    it("throws when PAT is missing", async () => {
      delete process.env["AZURE_DEVOPS_PAT"];
      await expect(tracker.getIssue("123", project)).rejects.toThrow("AZURE_DEVOPS_PAT");
    });
  });

  describe("isCompleted", () => {
    it("returns true for closed work items", async () => {
      mockAzureDevOpsResponse({
        ...sampleWorkItem,
        fields: { ...sampleWorkItem.fields, "System.State": "Closed" },
      });
      await expect(tracker.isCompleted("123", project)).resolves.toBe(true);
    });

    it("returns false for active work items", async () => {
      mockAzureDevOpsResponse(sampleWorkItem);
      await expect(tracker.isCompleted("123", project)).resolves.toBe(false);
    });
  });

  describe("issueUrl", () => {
    it("builds Azure DevOps work item URL", () => {
      expect(tracker.issueUrl("42", project)).toBe(
        "https://dev.azure.com/acme/My%20Project/_workitems/edit/42",
      );
    });
  });

  describe("issueLabel", () => {
    it("extracts #id from work item URL", () => {
      expect(
        tracker.issueLabel!(
          "https://dev.azure.com/acme/My%20Project/_workitems/edit/42",
          project,
        ),
      ).toBe("#42");
    });
  });

  describe("branchName", () => {
    it("generates feat/workitem-N format", () => {
      expect(tracker.branchName("42", project)).toBe("feat/workitem-42");
    });
  });

  describe("generatePrompt", () => {
    it("includes title, URL, tags, and description", async () => {
      mockAzureDevOpsResponse(sampleWorkItem);
      const prompt = await tracker.generatePrompt("123", project);

      expect(prompt).toContain("Azure DevOps work item #123: Fix login bug");
      expect(prompt).toContain("https://dev.azure.com/acme/My%20Project/_workitems/edit/123");
      expect(prompt).toContain("Tags: bug, high-priority");
      expect(prompt).toContain("Users cannot log in with SSO");
    });
  });
});
