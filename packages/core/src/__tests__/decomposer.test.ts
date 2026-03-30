/**
 * Unit tests for decomposer.ts — task decomposition, tree operations, formatting.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TaskNode, DecomposerConfig } from "../decomposer.js";
import {
  formatLineage,
  formatSiblings,
  getLeaves,
  getSiblings,
  formatPlanTree,
  propagateStatus,
  decompose,
  DEFAULT_DECOMPOSER_CONFIG,
} from "../decomposer.js";

// =============================================================================
// HELPERS
// =============================================================================

/** Create a minimal TaskNode for testing tree operations. */
function makeNode(
  overrides: Partial<TaskNode> & { id: string; description: string },
): TaskNode {
  return {
    depth: 0,
    status: "pending",
    lineage: [],
    children: [],
    ...overrides,
  };
}

// =============================================================================
// formatLineage
// =============================================================================

describe("formatLineage", () => {
  it("formats empty lineage with only the current task", () => {
    const result = formatLineage([], "Implement login");
    expect(result).toBe("0. Implement login  <-- (this task)");
  });

  it("formats single-level lineage", () => {
    const result = formatLineage(["Build auth system"], "Implement login");
    expect(result).toContain("0. Build auth system");
    expect(result).toContain("  1. Implement login  <-- (this task)");
  });

  it("formats multi-level lineage with correct indentation", () => {
    const result = formatLineage(
      ["Root task", "Subtask A", "Subtask A.1"],
      "Leaf task",
    );
    const lines = result.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("0. Root task");
    expect(lines[1]).toBe("  1. Subtask A");
    expect(lines[2]).toBe("    2. Subtask A.1");
    expect(lines[3]).toBe("      3. Leaf task  <-- (this task)");
  });

  it("marks the current task with an arrow", () => {
    const result = formatLineage(["Parent"], "Current");
    expect(result).toContain("<-- (this task)");
    // Only the current task should have the marker
    const lines = result.split("\n");
    expect(lines[0]).not.toContain("<-- (this task)");
    expect(lines[1]).toContain("<-- (this task)");
  });
});

// =============================================================================
// formatSiblings
// =============================================================================

describe("formatSiblings", () => {
  it("returns empty string when no siblings", () => {
    const result = formatSiblings([], "Current task");
    expect(result).toBe("");
  });

  it("formats siblings with the current task marked", () => {
    const result = formatSiblings(
      ["Task A", "Current task", "Task C"],
      "Current task",
    );
    expect(result).toContain("Sibling tasks being worked on in parallel:");
    expect(result).toContain("  - Task A");
    expect(result).toContain("  - Current task  <-- (you)");
    expect(result).toContain("  - Task C");
  });

  it("does not mark non-matching tasks", () => {
    const result = formatSiblings(["Task A", "Task B"], "Task C");
    expect(result).not.toContain("<-- (you)");
    expect(result).toContain("  - Task A");
    expect(result).toContain("  - Task B");
  });

  it("handles single sibling", () => {
    const result = formatSiblings(["Only sibling"], "me");
    expect(result).toContain("  - Only sibling");
    expect(result).not.toContain("<-- (you)");
  });
});

// =============================================================================
// getLeaves
// =============================================================================

describe("getLeaves", () => {
  it("returns single node when it has no children", () => {
    const node = makeNode({ id: "1", description: "Leaf" });
    const leaves = getLeaves(node);
    expect(leaves).toHaveLength(1);
    expect(leaves[0].id).toBe("1");
  });

  it("returns all leaves from a wide tree", () => {
    const root = makeNode({
      id: "1",
      description: "Root",
      children: [
        makeNode({ id: "1.1", description: "Child A", depth: 1 }),
        makeNode({ id: "1.2", description: "Child B", depth: 1 }),
        makeNode({ id: "1.3", description: "Child C", depth: 1 }),
      ],
    });

    const leaves = getLeaves(root);
    expect(leaves).toHaveLength(3);
    expect(leaves.map((l) => l.id)).toEqual(["1.1", "1.2", "1.3"]);
  });

  it("returns only leaves from a deep tree", () => {
    const root = makeNode({
      id: "1",
      description: "Root",
      children: [
        makeNode({
          id: "1.1",
          description: "Middle",
          depth: 1,
          children: [
            makeNode({ id: "1.1.1", description: "Deep leaf", depth: 2 }),
          ],
        }),
      ],
    });

    const leaves = getLeaves(root);
    expect(leaves).toHaveLength(1);
    expect(leaves[0].id).toBe("1.1.1");
  });

  it("returns leaves from a mixed tree", () => {
    const root = makeNode({
      id: "1",
      description: "Root",
      children: [
        makeNode({ id: "1.1", description: "Leaf A", depth: 1 }),
        makeNode({
          id: "1.2",
          description: "Branch",
          depth: 1,
          children: [
            makeNode({ id: "1.2.1", description: "Leaf B", depth: 2 }),
            makeNode({ id: "1.2.2", description: "Leaf C", depth: 2 }),
          ],
        }),
      ],
    });

    const leaves = getLeaves(root);
    expect(leaves).toHaveLength(3);
    expect(leaves.map((l) => l.id)).toEqual(["1.1", "1.2.1", "1.2.2"]);
  });

  it("handles deeply nested tree (depth 4)", () => {
    const root = makeNode({
      id: "1",
      description: "L0",
      children: [
        makeNode({
          id: "1.1",
          description: "L1",
          depth: 1,
          children: [
            makeNode({
              id: "1.1.1",
              description: "L2",
              depth: 2,
              children: [
                makeNode({
                  id: "1.1.1.1",
                  description: "L3",
                  depth: 3,
                  children: [
                    makeNode({ id: "1.1.1.1.1", description: "Deep leaf", depth: 4 }),
                  ],
                }),
              ],
            }),
          ],
        }),
      ],
    });

    const leaves = getLeaves(root);
    expect(leaves).toHaveLength(1);
    expect(leaves[0].id).toBe("1.1.1.1.1");
  });
});

// =============================================================================
// getSiblings
// =============================================================================

describe("getSiblings", () => {
  it("returns empty array when task is the root", () => {
    const root = makeNode({ id: "1", description: "Root" });
    const siblings = getSiblings(root, "1");
    expect(siblings).toEqual([]);
  });

  it("returns sibling descriptions for a child task", () => {
    const root = makeNode({
      id: "1",
      description: "Root",
      children: [
        makeNode({ id: "1.1", description: "Child A", depth: 1 }),
        makeNode({ id: "1.2", description: "Child B", depth: 1 }),
        makeNode({ id: "1.3", description: "Child C", depth: 1 }),
      ],
    });

    const siblings = getSiblings(root, "1.2");
    expect(siblings).toEqual(["Child A", "Child C"]);
  });

  it("returns empty array when task is only child", () => {
    const root = makeNode({
      id: "1",
      description: "Root",
      children: [
        makeNode({ id: "1.1", description: "Only child", depth: 1 }),
      ],
    });

    const siblings = getSiblings(root, "1.1");
    expect(siblings).toEqual([]);
  });

  it("returns empty array when task is not found", () => {
    const root = makeNode({
      id: "1",
      description: "Root",
      children: [
        makeNode({ id: "1.1", description: "Child A", depth: 1 }),
      ],
    });

    const siblings = getSiblings(root, "999");
    expect(siblings).toEqual([]);
  });

  it("finds siblings in a nested tree", () => {
    const root = makeNode({
      id: "1",
      description: "Root",
      children: [
        makeNode({
          id: "1.1",
          description: "Branch",
          depth: 1,
          children: [
            makeNode({ id: "1.1.1", description: "Nested A", depth: 2 }),
            makeNode({ id: "1.1.2", description: "Nested B", depth: 2 }),
          ],
        }),
        makeNode({ id: "1.2", description: "Sibling of branch", depth: 1 }),
      ],
    });

    // Siblings of 1.1.1 should be ["Nested B"]
    const siblings = getSiblings(root, "1.1.1");
    expect(siblings).toEqual(["Nested B"]);

    // Siblings of 1.1 should be ["Sibling of branch"]
    const branchSiblings = getSiblings(root, "1.1");
    expect(branchSiblings).toEqual(["Sibling of branch"]);
  });
});

// =============================================================================
// formatPlanTree
// =============================================================================

describe("formatPlanTree", () => {
  it("formats a single atomic node", () => {
    const node = makeNode({
      id: "1",
      description: "Simple task",
      kind: "atomic",
      status: "ready",
    });

    const result = formatPlanTree(node);
    expect(result).toBe("1. [ATOMIC] Simple task");
  });

  it("formats a single composite node", () => {
    const node = makeNode({
      id: "1",
      description: "Complex task",
      kind: "composite",
      status: "ready",
    });

    const result = formatPlanTree(node);
    expect(result).toBe("1. [COMPOSITE] Complex task");
  });

  it("shows status for non-ready nodes", () => {
    const node = makeNode({
      id: "1",
      description: "Pending task",
      status: "pending",
    });

    const result = formatPlanTree(node);
    expect(result).toContain("(pending)");
  });

  it("omits status tag for ready nodes", () => {
    const node = makeNode({
      id: "1",
      description: "Ready task",
      kind: "atomic",
      status: "ready",
    });

    const result = formatPlanTree(node);
    expect(result).not.toContain("(ready)");
  });

  it("formats a tree with children and indentation", () => {
    const root = makeNode({
      id: "1",
      description: "Root task",
      kind: "composite",
      status: "ready",
      children: [
        makeNode({
          id: "1.1",
          description: "Sub A",
          kind: "atomic",
          status: "ready",
          depth: 1,
        }),
        makeNode({
          id: "1.2",
          description: "Sub B",
          kind: "atomic",
          status: "running",
          depth: 1,
        }),
      ],
    });

    const result = formatPlanTree(root);
    expect(result).toContain("1. [COMPOSITE] Root task");
    expect(result).toContain("  1.1. [ATOMIC] Sub A");
    expect(result).toContain("  1.2. [ATOMIC] Sub B (running)");
  });

  it("formats a deeply nested tree", () => {
    const root = makeNode({
      id: "1",
      description: "Root",
      kind: "composite",
      status: "ready",
      children: [
        makeNode({
          id: "1.1",
          description: "Branch",
          kind: "composite",
          status: "ready",
          depth: 1,
          children: [
            makeNode({
              id: "1.1.1",
              description: "Leaf",
              kind: "atomic",
              status: "done",
              depth: 2,
            }),
          ],
        }),
      ],
    });

    const result = formatPlanTree(root);
    const lines = result.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("    1.1.1. [ATOMIC] Leaf (done)");
  });

  it("handles node without kind set", () => {
    const node = makeNode({
      id: "1",
      description: "Unknown kind",
      status: "ready",
    });

    const result = formatPlanTree(node);
    // kind is undefined, so kindTag should be ""
    expect(result).toBe("1.  Unknown kind");
  });

  it("shows failed status", () => {
    const node = makeNode({
      id: "1",
      description: "Failed task",
      kind: "atomic",
      status: "failed",
    });

    const result = formatPlanTree(node);
    expect(result).toContain("(failed)");
  });

  it("shows decomposing status", () => {
    const node = makeNode({
      id: "1",
      description: "Decomposing task",
      kind: "composite",
      status: "decomposing",
    });

    const result = formatPlanTree(node);
    expect(result).toContain("(decomposing)");
  });
});

// =============================================================================
// propagateStatus
// =============================================================================

describe("propagateStatus", () => {
  it("does nothing for leaf nodes", () => {
    const leaf = makeNode({ id: "1", description: "Leaf", status: "running" });
    propagateStatus(leaf);
    expect(leaf.status).toBe("running");
  });

  it("sets parent to done when all children are done", () => {
    const root = makeNode({
      id: "1",
      description: "Root",
      status: "running",
      children: [
        makeNode({ id: "1.1", description: "A", status: "done", depth: 1 }),
        makeNode({ id: "1.2", description: "B", status: "done", depth: 1 }),
      ],
    });

    propagateStatus(root);
    expect(root.status).toBe("done");
  });

  it("sets parent to failed when any child fails", () => {
    const root = makeNode({
      id: "1",
      description: "Root",
      status: "running",
      children: [
        makeNode({ id: "1.1", description: "A", status: "done", depth: 1 }),
        makeNode({ id: "1.2", description: "B", status: "failed", depth: 1 }),
      ],
    });

    propagateStatus(root);
    expect(root.status).toBe("failed");
  });

  it("sets parent to running when some children are done", () => {
    const root = makeNode({
      id: "1",
      description: "Root",
      status: "pending",
      children: [
        makeNode({ id: "1.1", description: "A", status: "done", depth: 1 }),
        makeNode({ id: "1.2", description: "B", status: "pending", depth: 1 }),
      ],
    });

    propagateStatus(root);
    expect(root.status).toBe("running");
  });

  it("sets parent to running when some children are running", () => {
    const root = makeNode({
      id: "1",
      description: "Root",
      status: "pending",
      children: [
        makeNode({ id: "1.1", description: "A", status: "running", depth: 1 }),
        makeNode({ id: "1.2", description: "B", status: "pending", depth: 1 }),
      ],
    });

    propagateStatus(root);
    expect(root.status).toBe("running");
  });

  it("keeps parent as-is when all children are pending", () => {
    const root = makeNode({
      id: "1",
      description: "Root",
      status: "ready",
      children: [
        makeNode({ id: "1.1", description: "A", status: "pending", depth: 1 }),
        makeNode({ id: "1.2", description: "B", status: "pending", depth: 1 }),
      ],
    });

    propagateStatus(root);
    // None of the conditions (all done, any failed, any running/done) match
    // so status stays as-is
    expect(root.status).toBe("ready");
  });

  it("propagates status up through multiple levels", () => {
    const root = makeNode({
      id: "1",
      description: "Root",
      status: "pending",
      children: [
        makeNode({
          id: "1.1",
          description: "Branch",
          status: "pending",
          depth: 1,
          children: [
            makeNode({ id: "1.1.1", description: "Leaf A", status: "done", depth: 2 }),
            makeNode({ id: "1.1.2", description: "Leaf B", status: "done", depth: 2 }),
          ],
        }),
        makeNode({ id: "1.2", description: "Leaf C", status: "done", depth: 1 }),
      ],
    });

    propagateStatus(root);
    // 1.1.1 and 1.1.2 both done -> 1.1 becomes done
    // 1.1 done and 1.2 done -> root becomes done
    expect(root.children[0].status).toBe("done");
    expect(root.status).toBe("done");
  });

  it("failed child propagates up through levels", () => {
    const root = makeNode({
      id: "1",
      description: "Root",
      status: "pending",
      children: [
        makeNode({
          id: "1.1",
          description: "Branch",
          status: "pending",
          depth: 1,
          children: [
            makeNode({ id: "1.1.1", description: "Leaf A", status: "done", depth: 2 }),
            makeNode({ id: "1.1.2", description: "Leaf B", status: "failed", depth: 2 }),
          ],
        }),
        makeNode({ id: "1.2", description: "Leaf C", status: "done", depth: 1 }),
      ],
    });

    propagateStatus(root);
    // 1.1.2 failed -> 1.1 becomes failed
    expect(root.children[0].status).toBe("failed");
    // 1.1 failed -> root becomes failed (failed takes priority over done)
    expect(root.status).toBe("failed");
  });

  it("failed takes priority over running", () => {
    const root = makeNode({
      id: "1",
      description: "Root",
      status: "pending",
      children: [
        makeNode({ id: "1.1", description: "A", status: "running", depth: 1 }),
        makeNode({ id: "1.2", description: "B", status: "failed", depth: 1 }),
        makeNode({ id: "1.3", description: "C", status: "done", depth: 1 }),
      ],
    });

    propagateStatus(root);
    expect(root.status).toBe("failed");
  });
});

// =============================================================================
// decompose (with mocked Anthropic SDK)
// =============================================================================

const mockCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate };
    },
  };
});

describe("decompose", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("decomposes a composite task into subtasks", async () => {
    // First call: classify as composite
    // Second call: decompose into subtasks
    // Third + Fourth calls: classify each subtask as atomic
    mockCreate
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "composite" }],
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: '["Build API", "Build UI"]' }],
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "atomic" }],
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "atomic" }],
      });

    const config: DecomposerConfig = {
      enabled: true,
      maxDepth: 3,
      model: "claude-sonnet-4-20250514",
      requireApproval: true,
    };

    const plan = await decompose("Build auth system", config);

    expect(plan.rootTask).toBe("Build auth system");
    expect(plan.tree.kind).toBe("composite");
    expect(plan.tree.children).toHaveLength(2);
    expect(plan.tree.children[0].description).toBe("Build API");
    expect(plan.tree.children[0].kind).toBe("atomic");
    expect(plan.tree.children[1].description).toBe("Build UI");
    expect(plan.tree.children[1].kind).toBe("atomic");
    expect(plan.phase).toBe("review"); // requireApproval=true
  });

  it("returns atomic task without decomposition", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "atomic" }],
    });

    const config: DecomposerConfig = {
      enabled: true,
      maxDepth: 3,
      model: "claude-sonnet-4-20250514",
      requireApproval: false,
    };

    const plan = await decompose("Fix typo in README", config);

    expect(plan.tree.kind).toBe("atomic");
    expect(plan.tree.children).toHaveLength(0);
    expect(plan.tree.status).toBe("ready");
    expect(plan.phase).toBe("approved"); // requireApproval=false
  });

  it("respects maxDepth by forcing atomic at depth limit", async () => {
    // Root: composite -> decompose -> 2 subtasks
    // Each subtask is at depth 1, with maxDepth=1, so forced atomic
    mockCreate
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "composite" }],
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: '["Sub A", "Sub B"]' }],
      });
    // Children at depth 1 (== maxDepth) are forced atomic, no classify call needed

    const config: DecomposerConfig = {
      enabled: true,
      maxDepth: 1,
      model: "test-model",
      requireApproval: true,
    };

    const plan = await decompose("Build everything", config);

    expect(plan.tree.children).toHaveLength(2);
    expect(plan.tree.children[0].kind).toBe("atomic");
    expect(plan.tree.children[1].kind).toBe("atomic");
  });

  it("uses default config when none provided", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "atomic" }],
    });

    const plan = await decompose("Simple task");
    expect(plan.maxDepth).toBe(DEFAULT_DECOMPOSER_CONFIG.maxDepth);
    expect(plan.phase).toBe("review"); // default requireApproval = true
  });

  it("throws when decomposition returns no JSON array", async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "composite" }],
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "I cannot decompose this task." }],
      });

    const config: DecomposerConfig = {
      enabled: true,
      maxDepth: 3,
      model: "test-model",
      requireApproval: true,
    };

    await expect(decompose("Bad task", config)).rejects.toThrow(
      /no JSON array in response/,
    );
  });

  it("throws when decomposition returns fewer than 2 subtasks", async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "composite" }],
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: '["Only one"]' }],
      });

    const config: DecomposerConfig = {
      enabled: true,
      maxDepth: 3,
      model: "test-model",
      requireApproval: true,
    };

    await expect(decompose("Bad composite", config)).rejects.toThrow(
      /need at least 2/,
    );
  });

  it("handles non-text content blocks gracefully", async () => {
    // If the content block is not type "text", classify defaults to atomic
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "image", source: {} }],
    });

    const config: DecomposerConfig = {
      enabled: true,
      maxDepth: 3,
      model: "test-model",
      requireApproval: false,
    };

    const plan = await decompose("Task with image response", config);
    // Non-text content -> empty string -> not "composite" -> defaults to "atomic"
    expect(plan.tree.kind).toBe("atomic");
  });

  it("sets correct plan metadata", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "atomic" }],
    });

    const plan = await decompose("Test task");

    expect(plan.id).toMatch(/^plan-\d+$/);
    expect(plan.rootTask).toBe("Test task");
    expect(plan.createdAt).toBeDefined();
    // ISO date format
    expect(new Date(plan.createdAt).toISOString()).toBe(plan.createdAt);
  });

  it("recursively decomposes nested composite tasks", async () => {
    // Root: composite
    // Root decomposition: ["Backend", "Frontend"]
    // Backend: composite
    // Backend decomposition: ["DB schema", "API endpoints"]
    // DB schema: atomic
    // API endpoints: atomic
    // Frontend: atomic
    mockCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "composite" }] }) // classify root
      .mockResolvedValueOnce({ content: [{ type: "text", text: '["Backend", "Frontend"]' }] }) // decompose root
      .mockResolvedValueOnce({ content: [{ type: "text", text: "composite" }] }) // classify Backend
      .mockResolvedValueOnce({ content: [{ type: "text", text: "atomic" }] }) // classify Frontend
      .mockResolvedValueOnce({ content: [{ type: "text", text: '["DB schema", "API endpoints"]' }] }) // decompose Backend
      .mockResolvedValueOnce({ content: [{ type: "text", text: "atomic" }] }) // classify DB schema
      .mockResolvedValueOnce({ content: [{ type: "text", text: "atomic" }] }); // classify API endpoints

    const config: DecomposerConfig = {
      enabled: true,
      maxDepth: 3,
      model: "test-model",
      requireApproval: true,
    };

    const plan = await decompose("Build full-stack app", config);

    expect(plan.tree.kind).toBe("composite");
    expect(plan.tree.children).toHaveLength(2);

    const backend = plan.tree.children[0];
    expect(backend.description).toBe("Backend");
    expect(backend.kind).toBe("composite");
    expect(backend.children).toHaveLength(2);
    expect(backend.children[0].description).toBe("DB schema");
    expect(backend.children[1].description).toBe("API endpoints");

    const frontend = plan.tree.children[1];
    expect(frontend.description).toBe("Frontend");
    expect(frontend.kind).toBe("atomic");
    expect(frontend.children).toHaveLength(0);

    // All leaves should be atomic and ready
    const leaves = getLeaves(plan.tree);
    expect(leaves).toHaveLength(3);
    leaves.forEach((leaf) => {
      expect(leaf.kind).toBe("atomic");
      expect(leaf.status).toBe("ready");
    });
  });
});

// =============================================================================
// DEFAULT_DECOMPOSER_CONFIG
// =============================================================================

describe("DEFAULT_DECOMPOSER_CONFIG", () => {
  it("has expected default values", () => {
    expect(DEFAULT_DECOMPOSER_CONFIG.enabled).toBe(false);
    expect(DEFAULT_DECOMPOSER_CONFIG.maxDepth).toBe(3);
    expect(DEFAULT_DECOMPOSER_CONFIG.model).toBe("claude-sonnet-4-20250514");
    expect(DEFAULT_DECOMPOSER_CONFIG.requireApproval).toBe(true);
  });
});
