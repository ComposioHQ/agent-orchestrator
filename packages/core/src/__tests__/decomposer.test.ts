import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  formatLineage,
  formatSiblings,
  getLeaves,
  getSiblings,
  formatPlanTree,
  propagateStatus,
  decompose,
  type TaskNode,
  type DecomposerConfig,
} from "../decomposer.js";

// =============================================================================
// Pure function tests
// =============================================================================

describe("formatLineage", () => {
  it("formats a single root task with no lineage", () => {
    const result = formatLineage([], "Build auth");
    expect(result).toBe("0. Build auth  <-- (this task)");
  });

  it("indents ancestors and marks the current task", () => {
    const result = formatLineage(["Root task", "Parent task"], "Child task");
    expect(result).toBe(
      "0. Root task\n  1. Parent task\n    2. Child task  <-- (this task)",
    );
  });
});

describe("formatSiblings", () => {
  it("returns empty string when there are no siblings", () => {
    expect(formatSiblings([], "my task")).toBe("");
  });

  it("marks the current task among siblings", () => {
    const result = formatSiblings(["task A", "task B", "task C"], "task B");
    expect(result).toContain("task B  <-- (you)");
    expect(result).toContain("- task A");
    expect(result).toContain("- task C");
  });
});

describe("getLeaves", () => {
  it("returns the node itself when it has no children", () => {
    const node: TaskNode = {
      id: "1",
      depth: 0,
      description: "atomic task",
      status: "ready",
      lineage: [],
      children: [],
    };
    expect(getLeaves(node)).toEqual([node]);
  });

  it("returns all leaf nodes from a nested tree", () => {
    const leaf1: TaskNode = { id: "1.1", depth: 1, description: "leaf 1", status: "ready", lineage: [], children: [] };
    const leaf2: TaskNode = { id: "1.2", depth: 1, description: "leaf 2", status: "ready", lineage: [], children: [] };
    const root: TaskNode = {
      id: "1",
      depth: 0,
      description: "composite",
      status: "ready",
      lineage: [],
      children: [leaf1, leaf2],
    };
    expect(getLeaves(root)).toEqual([leaf1, leaf2]);
  });
});

describe("getSiblings", () => {
  it("returns empty array when the task has no parent", () => {
    const root: TaskNode = { id: "1", depth: 0, description: "root", status: "ready", lineage: [], children: [] };
    expect(getSiblings(root, "1")).toEqual([]);
  });

  it("returns descriptions of sibling nodes", () => {
    const child1: TaskNode = { id: "1.1", depth: 1, description: "task A", status: "ready", lineage: [], children: [] };
    const child2: TaskNode = { id: "1.2", depth: 1, description: "task B", status: "ready", lineage: [], children: [] };
    const root: TaskNode = { id: "1", depth: 0, description: "root", status: "ready", lineage: [], children: [child1, child2] };
    expect(getSiblings(root, "1.1")).toEqual(["task B"]);
  });
});

describe("formatPlanTree", () => {
  it("renders a flat atomic node", () => {
    const node: TaskNode = {
      id: "1",
      depth: 0,
      description: "write tests",
      kind: "atomic",
      status: "ready",
      lineage: [],
      children: [],
    };
    const result = formatPlanTree(node);
    expect(result).toContain("[ATOMIC]");
    expect(result).toContain("write tests");
  });

  it("indents child nodes", () => {
    const child: TaskNode = { id: "1.1", depth: 1, description: "child", kind: "atomic", status: "ready", lineage: [], children: [] };
    const root: TaskNode = { id: "1", depth: 0, description: "root", kind: "composite", status: "ready", lineage: [], children: [child] };
    const result = formatPlanTree(root);
    const lines = result.split("\n");
    expect(lines[0]).not.toMatch(/^ /);
    expect(lines[1]).toMatch(/^ {2}/);
  });
});

describe("propagateStatus", () => {
  function makeNode(id: string, status: TaskNode["status"], children: TaskNode[] = []): TaskNode {
    return { id, depth: 0, description: id, status, lineage: [], children };
  }

  it("marks parent done when all children are done", () => {
    const parent = makeNode("1", "running", [makeNode("1.1", "done"), makeNode("1.2", "done")]);
    propagateStatus(parent);
    expect(parent.status).toBe("done");
  });

  it("marks parent failed when any child is failed", () => {
    const parent = makeNode("1", "running", [makeNode("1.1", "done"), makeNode("1.2", "failed")]);
    propagateStatus(parent);
    expect(parent.status).toBe("failed");
  });

  it("marks parent running when some children are running", () => {
    const parent = makeNode("1", "ready", [makeNode("1.1", "running"), makeNode("1.2", "pending")]);
    propagateStatus(parent);
    expect(parent.status).toBe("running");
  });

  it("does not change leaf node status", () => {
    const leaf = makeNode("1", "pending");
    propagateStatus(leaf);
    expect(leaf.status).toBe("pending");
  });
});

// =============================================================================
// LLM-calling function tests (Anthropic mocked)
// =============================================================================

vi.mock("@anthropic-ai/sdk", () => {
  const MockAnthropic = vi.fn();
  MockAnthropic.prototype.messages = {
    create: vi.fn(),
  };
  return { default: MockAnthropic };
});

import Anthropic from "@anthropic-ai/sdk";

function getCreateMock() {
  return (Anthropic as unknown as { prototype: { messages: { create: ReturnType<typeof vi.fn> } } }).prototype.messages.create;
}

const TEST_CONFIG: DecomposerConfig = {
  enabled: true,
  maxDepth: 3,
  model: "test-model",
  requireApproval: false,
};

beforeEach(() => {
  getCreateMock().mockReset();
});

describe("decompose — empty content array", () => {
  it("classifyTask defaults to atomic when content is empty", async () => {
    // First call: classify → empty content (should default to atomic)
    getCreateMock().mockResolvedValue({ content: [] });

    const plan = await decompose("Build a login page", TEST_CONFIG);
    // With empty content classifyTask returns "atomic", so no decomposition call is made
    expect(plan.tree.kind).toBe("atomic");
    expect(plan.tree.children).toHaveLength(0);
  });
});

describe("decompose — decomposeTask error paths", () => {
  it("throws a clear error when content is empty during decomposition", async () => {
    // First call: classify → "composite"
    getCreateMock()
      .mockResolvedValueOnce({ content: [{ type: "text", text: "composite" }] })
      // Second call: decompose → empty content
      .mockResolvedValueOnce({ content: [] });

    await expect(decompose("Build a login page", { ...TEST_CONFIG, maxDepth: 1 })).rejects.toThrow(
      "no JSON array in response",
    );
  });

  it("throws with context when the JSON in the response is malformed", async () => {
    // First call: classify → "composite"
    getCreateMock()
      .mockResolvedValueOnce({ content: [{ type: "text", text: "composite" }] })
      // Second call: decompose → response with brackets but invalid JSON inside
      .mockResolvedValueOnce({ content: [{ type: "text", text: "[not valid json]" }] });

    await expect(decompose("Build a login page", { ...TEST_CONFIG, maxDepth: 1 })).rejects.toThrow(
      "invalid JSON in response",
    );
  });

  it("succeeds and returns a two-child plan on a valid composite response", async () => {
    getCreateMock()
      // Root: classify as composite
      .mockResolvedValueOnce({ content: [{ type: "text", text: "composite" }] })
      // Root: decompose into two subtasks
      .mockResolvedValueOnce({ content: [{ type: "text", text: '["Build backend API", "Build frontend UI"]' }] })
      // Child 1.1: classify as atomic
      .mockResolvedValueOnce({ content: [{ type: "text", text: "atomic" }] })
      // Child 1.2: classify as atomic
      .mockResolvedValueOnce({ content: [{ type: "text", text: "atomic" }] });

    const plan = await decompose("Build a login page", { ...TEST_CONFIG, maxDepth: 2 });
    expect(plan.tree.kind).toBe("composite");
    expect(plan.tree.children).toHaveLength(2);
    expect(plan.tree.children[0].description).toBe("Build backend API");
    expect(plan.tree.children[1].description).toBe("Build frontend UI");
  });
});
