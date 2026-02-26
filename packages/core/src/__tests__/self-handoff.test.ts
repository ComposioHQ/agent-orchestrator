import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createSelfHandoff } from "../self-handoff.js";
import type { HandoffDocument, CreateHandoffParams } from "../self-handoff.js";

let workspacePath: string;

beforeEach(() => {
  workspacePath = join(tmpdir(), `ao-test-handoff-${randomUUID()}`);
  mkdirSync(workspacePath, { recursive: true });
});

afterEach(() => {
  rmSync(workspacePath, { recursive: true, force: true });
});

// =============================================================================
// detectContextLimit
// =============================================================================

describe("detectContextLimit", () => {
  const handoff = createSelfHandoff();

  it("detects 'context window' pattern", () => {
    const result = handoff.detectContextLimit(
      "Error: The context window has been exceeded.",
    );
    expect(result.detected).toBe(true);
    expect(result.pattern).toBe("context window");
    expect(result.extractedContext).toBeDefined();
  });

  it("detects 'context limit' pattern", () => {
    const result = handoff.detectContextLimit(
      "You have reached the context limit for this conversation.",
    );
    expect(result.detected).toBe(true);
    expect(result.pattern).toBe("context limit");
  });

  it("detects 'maximum context length' pattern", () => {
    const result = handoff.detectContextLimit(
      "This request exceeds the maximum context length allowed.",
    );
    expect(result.detected).toBe(true);
    expect(result.pattern).toBe("maximum context length");
  });

  it("detects 'token limit' pattern", () => {
    const result = handoff.detectContextLimit(
      "Warning: token limit reached, truncating input.",
    );
    expect(result.detected).toBe(true);
    expect(result.pattern).toBe("token limit");
  });

  it("detects 'token budget' pattern", () => {
    const result = handoff.detectContextLimit(
      "The token budget has been exhausted for this session.",
    );
    expect(result.detected).toBe(true);
    expect(result.pattern).toBe("token budget");
  });

  it("detects 'conversation too long' pattern", () => {
    const result = handoff.detectContextLimit(
      "This conversation too long to continue processing.",
    );
    expect(result.detected).toBe(true);
    expect(result.pattern).toBe("conversation too long");
  });

  it("detects 'context exceeded' pattern", () => {
    const result = handoff.detectContextLimit(
      "Error: context exceeded. Please start a new session.",
    );
    expect(result.detected).toBe(true);
    expect(result.pattern).toBe("context exceeded");
  });

  it("detects 'running out of context' pattern", () => {
    const result = handoff.detectContextLimit(
      "I'm running out of context space. Let me wrap up.",
    );
    expect(result.detected).toBe(true);
    expect(result.pattern).toBe("running out of context");
  });

  it("detects Claude Code 'Conversation is too long' pattern", () => {
    const result = handoff.detectContextLimit(
      "Conversation is too long. Please start a new conversation.",
    );
    expect(result.detected).toBe(true);
    expect(result.pattern).toBe("Conversation is too long");
  });

  it("detects 'context window is full' pattern", () => {
    const result = handoff.detectContextLimit(
      "The context window is full. Cannot process further.",
    );
    expect(result.detected).toBe(true);
    expect(result.pattern).toBe("context window is full");
  });

  it("is case-insensitive", () => {
    const result = handoff.detectContextLimit(
      "THE CONTEXT WINDOW HAS BEEN EXCEEDED",
    );
    expect(result.detected).toBe(true);
    expect(result.pattern).toBe("context window");
  });

  it("returns detected=false for normal output", () => {
    const result = handoff.detectContextLimit(
      "Successfully compiled 42 files. All tests passing.",
    );
    expect(result.detected).toBe(false);
    expect(result.pattern).toBeUndefined();
    expect(result.extractedContext).toBeUndefined();
  });

  it("returns detected=false for empty output", () => {
    const result = handoff.detectContextLimit("");
    expect(result.detected).toBe(false);
  });

  it("extracts surrounding context from the matched output", () => {
    const output = "Some prefix text. The context window is full and cannot accept more tokens. Some suffix text.";
    const result = handoff.detectContextLimit(output);
    expect(result.detected).toBe(true);
    expect(result.extractedContext).toContain("context window is full");
  });

  it("matches first applicable pattern when multiple are present", () => {
    const result = handoff.detectContextLimit(
      "context window exceeded, running out of context, token limit reached",
    );
    expect(result.detected).toBe(true);
    // "running out of context" is more specific and comes before "context window" in the list
    expect(result.pattern).toBe("running out of context");
  });
});

// =============================================================================
// createHandoffDocument
// =============================================================================

describe("createHandoffDocument", () => {
  it("creates a handoff document and writes to disk", () => {
    const handoff = createSelfHandoff();
    const params: CreateHandoffParams = {
      sessionId: "app-1",
      projectId: "my-project",
      branch: "feat/login",
      issueId: "GH-42",
      workspacePath,
      workSummary: "Implemented login form with validation.",
      remainingWork: "Add OAuth integration and write tests.",
      currentState: "Login form is rendering, PR not yet opened.",
    };

    const doc = handoff.createHandoffDocument(params);

    expect(doc.fromSessionId).toBe("app-1");
    expect(doc.projectId).toBe("my-project");
    expect(doc.branch).toBe("feat/login");
    expect(doc.issueId).toBe("GH-42");
    expect(doc.workSummary).toBe("Implemented login form with validation.");
    expect(doc.remainingWork).toBe("Add OAuth integration and write tests.");
    expect(doc.currentState).toBe("Login form is rendering, PR not yet opened.");
    expect(doc.createdAt).toBeInstanceOf(Date);
    expect(doc.filePath).toContain(".ao/handoffs/");
    expect(doc.filePath).toContain("app-1-");
    expect(doc.filePath.endsWith(".json")).toBe(true);

    // Verify file exists on disk
    expect(existsSync(doc.filePath)).toBe(true);

    // Verify file content is valid JSON
    const raw = readFileSync(doc.filePath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.fromSessionId).toBe("app-1");
    expect(parsed.projectId).toBe("my-project");
    expect(parsed.branch).toBe("feat/login");
    expect(parsed.issueId).toBe("GH-42");
  });

  it("creates handoff document with null issueId", () => {
    const handoff = createSelfHandoff();
    const doc = handoff.createHandoffDocument({
      sessionId: "app-2",
      projectId: "proj",
      branch: "main",
      issueId: null,
      workspacePath,
      workSummary: "summary",
      remainingWork: "remaining",
      currentState: "state",
    });

    expect(doc.issueId).toBeNull();

    const raw = readFileSync(doc.filePath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.issueId).toBeNull();
  });

  it("creates the handoff directory if it does not exist", () => {
    const handoff = createSelfHandoff();
    const handoffDir = join(workspacePath, ".ao", "handoffs");

    expect(existsSync(handoffDir)).toBe(false);

    handoff.createHandoffDocument({
      sessionId: "app-3",
      projectId: "proj",
      branch: "main",
      issueId: null,
      workspacePath,
      workSummary: "s",
      remainingWork: "r",
      currentState: "c",
    });

    expect(existsSync(handoffDir)).toBe(true);
  });

  it("uses custom handoffDir when configured", () => {
    const customDir = join(workspacePath, "custom-handoffs");
    const handoff = createSelfHandoff({ handoffDir: customDir });

    const doc = handoff.createHandoffDocument({
      sessionId: "app-4",
      projectId: "proj",
      branch: "main",
      issueId: null,
      workspacePath,
      workSummary: "s",
      remainingWork: "r",
      currentState: "c",
    });

    expect(doc.filePath.startsWith(customDir)).toBe(true);
    expect(existsSync(doc.filePath)).toBe(true);
  });

  it("writes pretty-printed JSON", () => {
    const handoff = createSelfHandoff();
    const doc = handoff.createHandoffDocument({
      sessionId: "pretty-1",
      projectId: "proj",
      branch: "main",
      issueId: null,
      workspacePath,
      workSummary: "s",
      remainingWork: "r",
      currentState: "c",
    });

    const raw = readFileSync(doc.filePath, "utf-8");
    // Pretty-printed JSON has newlines
    expect(raw).toContain("\n");
    expect(raw.startsWith("{")).toBe(true);
  });
});

// =============================================================================
// readHandoffDocument
// =============================================================================

describe("readHandoffDocument", () => {
  it("reads a valid handoff document", () => {
    const handoff = createSelfHandoff();
    const created = handoff.createHandoffDocument({
      sessionId: "read-1",
      projectId: "proj",
      branch: "feat/read",
      issueId: "ISSUE-1",
      workspacePath,
      workSummary: "Did things",
      remainingWork: "Do more things",
      currentState: "Halfway done",
    });

    const doc = handoff.readHandoffDocument(created.filePath);
    expect(doc).not.toBeNull();
    expect(doc!.fromSessionId).toBe("read-1");
    expect(doc!.projectId).toBe("proj");
    expect(doc!.branch).toBe("feat/read");
    expect(doc!.issueId).toBe("ISSUE-1");
    expect(doc!.workSummary).toBe("Did things");
    expect(doc!.remainingWork).toBe("Do more things");
    expect(doc!.currentState).toBe("Halfway done");
    expect(doc!.createdAt).toBeInstanceOf(Date);
  });

  it("returns null for nonexistent file", () => {
    const handoff = createSelfHandoff();
    const result = handoff.readHandoffDocument("/nonexistent/path/file.json");
    expect(result).toBeNull();
  });

  it("returns null for corrupt JSON", () => {
    const handoff = createSelfHandoff();
    const filePath = join(workspacePath, "corrupt.json");
    writeFileSync(filePath, "this is not json{{{", "utf-8");

    const result = handoff.readHandoffDocument(filePath);
    expect(result).toBeNull();
  });

  it("returns null for JSON that is an array", () => {
    const handoff = createSelfHandoff();
    const filePath = join(workspacePath, "array.json");
    writeFileSync(filePath, "[1, 2, 3]", "utf-8");

    const result = handoff.readHandoffDocument(filePath);
    expect(result).toBeNull();
  });

  it("returns null for JSON missing required fields", () => {
    const handoff = createSelfHandoff();
    const filePath = join(workspacePath, "incomplete.json");
    writeFileSync(
      filePath,
      JSON.stringify({ fromSessionId: "x", projectId: "y" }),
      "utf-8",
    );

    const result = handoff.readHandoffDocument(filePath);
    expect(result).toBeNull();
  });

  it("returns null for JSON with invalid createdAt date", () => {
    const handoff = createSelfHandoff();
    const filePath = join(workspacePath, "bad-date.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        fromSessionId: "x",
        projectId: "y",
        branch: "main",
        issueId: null,
        workSummary: "s",
        remainingWork: "r",
        currentState: "c",
        createdAt: "not-a-date",
        filePath: "/some/path.json",
      }),
      "utf-8",
    );

    const result = handoff.readHandoffDocument(filePath);
    expect(result).toBeNull();
  });

  it("handles null issueId correctly", () => {
    const handoff = createSelfHandoff();
    const filePath = join(workspacePath, "null-issue.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        fromSessionId: "x",
        projectId: "y",
        branch: "main",
        issueId: null,
        workSummary: "s",
        remainingWork: "r",
        currentState: "c",
        createdAt: new Date().toISOString(),
        filePath: "/some/path.json",
      }),
      "utf-8",
    );

    const result = handoff.readHandoffDocument(filePath);
    expect(result).not.toBeNull();
    expect(result!.issueId).toBeNull();
  });

  it("returns null for empty file", () => {
    const handoff = createSelfHandoff();
    const filePath = join(workspacePath, "empty.json");
    writeFileSync(filePath, "", "utf-8");

    const result = handoff.readHandoffDocument(filePath);
    expect(result).toBeNull();
  });
});

// =============================================================================
// findHandoffs
// =============================================================================

describe("findHandoffs", () => {
  it("finds all handoff documents in workspace", () => {
    const handoff = createSelfHandoff();

    handoff.createHandoffDocument({
      sessionId: "find-1",
      projectId: "proj",
      branch: "feat/a",
      issueId: null,
      workspacePath,
      workSummary: "s1",
      remainingWork: "r1",
      currentState: "c1",
    });

    handoff.createHandoffDocument({
      sessionId: "find-2",
      projectId: "proj",
      branch: "feat/b",
      issueId: null,
      workspacePath,
      workSummary: "s2",
      remainingWork: "r2",
      currentState: "c2",
    });

    const docs = handoff.findHandoffs(workspacePath);
    expect(docs).toHaveLength(2);
  });

  it("filters by branch when specified", () => {
    const handoff = createSelfHandoff();

    handoff.createHandoffDocument({
      sessionId: "br-1",
      projectId: "proj",
      branch: "feat/target",
      issueId: null,
      workspacePath,
      workSummary: "s",
      remainingWork: "r",
      currentState: "c",
    });

    handoff.createHandoffDocument({
      sessionId: "br-2",
      projectId: "proj",
      branch: "feat/other",
      issueId: null,
      workspacePath,
      workSummary: "s",
      remainingWork: "r",
      currentState: "c",
    });

    const docs = handoff.findHandoffs(workspacePath, "feat/target");
    expect(docs).toHaveLength(1);
    expect(docs[0].fromSessionId).toBe("br-1");
  });

  it("returns results sorted by createdAt descending (most recent first)", () => {
    const handoff = createSelfHandoff();

    // Create docs with slight delay between them
    const doc1 = handoff.createHandoffDocument({
      sessionId: "sort-1",
      projectId: "proj",
      branch: "main",
      issueId: null,
      workspacePath,
      workSummary: "first",
      remainingWork: "r",
      currentState: "c",
    });

    // Manually backdate doc1
    const backdated = {
      fromSessionId: doc1.fromSessionId,
      projectId: doc1.projectId,
      branch: doc1.branch,
      issueId: doc1.issueId,
      workSummary: doc1.workSummary,
      remainingWork: doc1.remainingWork,
      currentState: doc1.currentState,
      createdAt: new Date(Date.now() - 60000).toISOString(),
      filePath: doc1.filePath,
    };
    writeFileSync(doc1.filePath, JSON.stringify(backdated, null, 2), "utf-8");

    handoff.createHandoffDocument({
      sessionId: "sort-2",
      projectId: "proj",
      branch: "main",
      issueId: null,
      workspacePath,
      workSummary: "second",
      remainingWork: "r",
      currentState: "c",
    });

    const docs = handoff.findHandoffs(workspacePath, "main");
    expect(docs).toHaveLength(2);
    // Most recent first
    expect(docs[0].fromSessionId).toBe("sort-2");
    expect(docs[1].fromSessionId).toBe("sort-1");
  });

  it("returns empty array when handoff directory does not exist", () => {
    const handoff = createSelfHandoff();
    const docs = handoff.findHandoffs(workspacePath);
    expect(docs).toEqual([]);
  });

  it("skips non-JSON files in handoff directory", () => {
    const handoff = createSelfHandoff();
    const handoffDir = join(workspacePath, ".ao", "handoffs");
    mkdirSync(handoffDir, { recursive: true });

    writeFileSync(join(handoffDir, "readme.txt"), "not a handoff", "utf-8");
    writeFileSync(join(handoffDir, ".gitkeep"), "", "utf-8");

    handoff.createHandoffDocument({
      sessionId: "json-1",
      projectId: "proj",
      branch: "main",
      issueId: null,
      workspacePath,
      workSummary: "s",
      remainingWork: "r",
      currentState: "c",
    });

    const docs = handoff.findHandoffs(workspacePath);
    expect(docs).toHaveLength(1);
    expect(docs[0].fromSessionId).toBe("json-1");
  });

  it("skips corrupt JSON files gracefully", () => {
    const handoff = createSelfHandoff();
    const handoffDir = join(workspacePath, ".ao", "handoffs");
    mkdirSync(handoffDir, { recursive: true });

    writeFileSync(join(handoffDir, "corrupt.json"), "{bad json", "utf-8");

    handoff.createHandoffDocument({
      sessionId: "valid-1",
      projectId: "proj",
      branch: "main",
      issueId: null,
      workspacePath,
      workSummary: "s",
      remainingWork: "r",
      currentState: "c",
    });

    const docs = handoff.findHandoffs(workspacePath);
    expect(docs).toHaveLength(1);
    expect(docs[0].fromSessionId).toBe("valid-1");
  });

  it("returns empty array when branch filter matches nothing", () => {
    const handoff = createSelfHandoff();

    handoff.createHandoffDocument({
      sessionId: "nomatch-1",
      projectId: "proj",
      branch: "feat/something",
      issueId: null,
      workspacePath,
      workSummary: "s",
      remainingWork: "r",
      currentState: "c",
    });

    const docs = handoff.findHandoffs(workspacePath, "feat/other-thing");
    expect(docs).toEqual([]);
  });
});

// =============================================================================
// generateHandoffPrompt
// =============================================================================

describe("generateHandoffPrompt", () => {
  it("generates a prompt with all handoff info", () => {
    const handoff = createSelfHandoff();
    const doc: HandoffDocument = {
      fromSessionId: "gen-1",
      projectId: "my-project",
      branch: "feat/auth",
      issueId: "GH-99",
      workSummary: "Built the authentication middleware.",
      remainingWork: "Add rate limiting and write integration tests.",
      currentState: "Middleware is working, tests not started.",
      createdAt: new Date("2025-06-15T12:00:00Z"),
      filePath: "/tmp/handoff.json",
    };

    const prompt = handoff.generateHandoffPrompt(doc);

    expect(prompt).toContain("## Session Handoff");
    expect(prompt).toContain("`gen-1`");
    expect(prompt).toContain("**Project:** my-project");
    expect(prompt).toContain("**Branch:** feat/auth");
    expect(prompt).toContain("**Issue:** GH-99");
    expect(prompt).toContain("### Work Completed So Far");
    expect(prompt).toContain("Built the authentication middleware.");
    expect(prompt).toContain("### Remaining Work");
    expect(prompt).toContain("Add rate limiting and write integration tests.");
    expect(prompt).toContain("### Current State");
    expect(prompt).toContain("Middleware is working, tests not started.");
    expect(prompt).toContain("Please continue the work described above.");
  });

  it("omits issue line when issueId is null", () => {
    const handoff = createSelfHandoff();
    const doc: HandoffDocument = {
      fromSessionId: "gen-2",
      projectId: "proj",
      branch: "main",
      issueId: null,
      workSummary: "summary",
      remainingWork: "remaining",
      currentState: "state",
      createdAt: new Date(),
      filePath: "/tmp/handoff.json",
    };

    const prompt = handoff.generateHandoffPrompt(doc);

    expect(prompt).not.toContain("**Issue:**");
    expect(prompt).toContain("**Branch:** main");
  });

  it("includes continuation instruction at the end", () => {
    const handoff = createSelfHandoff();
    const doc: HandoffDocument = {
      fromSessionId: "gen-3",
      projectId: "proj",
      branch: "main",
      issueId: null,
      workSummary: "s",
      remainingWork: "r",
      currentState: "c",
      createdAt: new Date(),
      filePath: "/tmp/handoff.json",
    };

    const prompt = handoff.generateHandoffPrompt(doc);
    expect(prompt).toContain(
      "Please continue the work described above. The branch already has the previous changes committed.",
    );
  });
});

// =============================================================================
// cleanupHandoffs
// =============================================================================

describe("cleanupHandoffs", () => {
  it("removes handoff documents older than maxAge", () => {
    const handoff = createSelfHandoff();
    const handoffDir = join(workspacePath, ".ao", "handoffs");
    mkdirSync(handoffDir, { recursive: true });

    // Create an old file (manually set mtime in the past)
    const oldFile = join(handoffDir, "old-session-2020-01-01.json");
    writeFileSync(
      oldFile,
      JSON.stringify({
        fromSessionId: "old",
        projectId: "p",
        branch: "main",
        issueId: null,
        workSummary: "s",
        remainingWork: "r",
        currentState: "c",
        createdAt: "2020-01-01T00:00:00.000Z",
        filePath: oldFile,
      }),
      "utf-8",
    );

    // Backdate the file's mtime
    const oldTime = new Date("2020-01-01T00:00:00Z");
    utimesSync(oldFile, oldTime, oldTime);

    // Create a recent file
    const recentDoc = handoff.createHandoffDocument({
      sessionId: "recent",
      projectId: "p",
      branch: "main",
      issueId: null,
      workspacePath,
      workSummary: "s",
      remainingWork: "r",
      currentState: "c",
    });

    // Cleanup with default maxAge (7 days) should remove the old one
    const removed = handoff.cleanupHandoffs(workspacePath);
    expect(removed).toBe(1);

    // Old file should be gone, recent should remain
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(recentDoc.filePath)).toBe(true);
  });

  it("respects custom maxAge parameter", () => {
    const handoff = createSelfHandoff();
    const handoffDir = join(workspacePath, ".ao", "handoffs");
    mkdirSync(handoffDir, { recursive: true });

    // Create a file and backdate it to 2 hours ago
    const file = join(handoffDir, "medium-age.json");
    writeFileSync(
      file,
      JSON.stringify({
        fromSessionId: "med",
        projectId: "p",
        branch: "main",
        issueId: null,
        workSummary: "s",
        remainingWork: "r",
        currentState: "c",
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        filePath: file,
      }),
      "utf-8",
    );

    // Backdate mtime to 2 hours ago
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(file, twoHoursAgo, twoHoursAgo);

    // maxAge of 1 hour: should remove
    const removed = handoff.cleanupHandoffs(workspacePath, 60 * 60 * 1000);
    expect(removed).toBe(1);
    expect(existsSync(file)).toBe(false);
  });

  it("does not remove files newer than maxAge", () => {
    const handoff = createSelfHandoff();

    const doc = handoff.createHandoffDocument({
      sessionId: "fresh",
      projectId: "p",
      branch: "main",
      issueId: null,
      workspacePath,
      workSummary: "s",
      remainingWork: "r",
      currentState: "c",
    });

    // Cleanup with 7 day maxAge: fresh file should survive
    const removed = handoff.cleanupHandoffs(workspacePath);
    expect(removed).toBe(0);
    expect(existsSync(doc.filePath)).toBe(true);
  });

  it("returns 0 when handoff directory does not exist", () => {
    const handoff = createSelfHandoff();
    const removed = handoff.cleanupHandoffs(workspacePath);
    expect(removed).toBe(0);
  });

  it("skips non-JSON files", () => {
    const handoff = createSelfHandoff();
    const handoffDir = join(workspacePath, ".ao", "handoffs");
    mkdirSync(handoffDir, { recursive: true });

    // Create a non-JSON file backdated to long ago
    const txtFile = join(handoffDir, "notes.txt");
    writeFileSync(txtFile, "some notes", "utf-8");

    const oldTime = new Date("2020-01-01T00:00:00Z");
    utimesSync(txtFile, oldTime, oldTime);

    const removed = handoff.cleanupHandoffs(workspacePath);
    expect(removed).toBe(0);
    expect(existsSync(txtFile)).toBe(true);
  });

  it("returns 0 when directory is empty", () => {
    const handoff = createSelfHandoff();
    const handoffDir = join(workspacePath, ".ao", "handoffs");
    mkdirSync(handoffDir, { recursive: true });

    const removed = handoff.cleanupHandoffs(workspacePath);
    expect(removed).toBe(0);
  });
});

// =============================================================================
// Edge cases and integration
// =============================================================================

describe("edge cases", () => {
  it("round-trips a handoff document through create and read", () => {
    const handoff = createSelfHandoff();

    const created = handoff.createHandoffDocument({
      sessionId: "roundtrip-1",
      projectId: "my-proj",
      branch: "feat/roundtrip",
      issueId: "LIN-42",
      workspacePath,
      workSummary: "Completed the API layer with full CRUD.",
      remainingWork: "Frontend integration remains.",
      currentState: "API tests pass, no UI yet.",
    });

    const read = handoff.readHandoffDocument(created.filePath);
    expect(read).not.toBeNull();
    expect(read!.fromSessionId).toBe(created.fromSessionId);
    expect(read!.projectId).toBe(created.projectId);
    expect(read!.branch).toBe(created.branch);
    expect(read!.issueId).toBe(created.issueId);
    expect(read!.workSummary).toBe(created.workSummary);
    expect(read!.remainingWork).toBe(created.remainingWork);
    expect(read!.currentState).toBe(created.currentState);
  });

  it("find -> generate prompt end-to-end", () => {
    const handoff = createSelfHandoff();

    handoff.createHandoffDocument({
      sessionId: "e2e-1",
      projectId: "proj",
      branch: "feat/e2e",
      issueId: "JIRA-100",
      workspacePath,
      workSummary: "Built the widget.",
      remainingWork: "Test the widget.",
      currentState: "Widget renders.",
    });

    const docs = handoff.findHandoffs(workspacePath, "feat/e2e");
    expect(docs).toHaveLength(1);

    const prompt = handoff.generateHandoffPrompt(docs[0]);
    expect(prompt).toContain("Built the widget.");
    expect(prompt).toContain("Test the widget.");
    expect(prompt).toContain("JIRA-100");
  });

  it("multiple handoffs for the same branch are all found", () => {
    const handoff = createSelfHandoff();
    const handoffDir = join(workspacePath, ".ao", "handoffs");

    // Simulate multiple handoffs on same branch (multi-hop handoff)
    // Manually backdate earlier ones to ensure deterministic ordering
    const doc1 = handoff.createHandoffDocument({
      sessionId: "hop-1",
      projectId: "proj",
      branch: "feat/multi",
      issueId: null,
      workspacePath,
      workSummary: "First pass",
      remainingWork: "Lots left",
      currentState: "Starting",
    });

    // Backdate doc1 to 2 minutes ago
    const backdated1 = {
      fromSessionId: "hop-1",
      projectId: "proj",
      branch: "feat/multi",
      issueId: null,
      workSummary: "First pass",
      remainingWork: "Lots left",
      currentState: "Starting",
      createdAt: new Date(Date.now() - 120000).toISOString(),
      filePath: doc1.filePath,
    };
    writeFileSync(doc1.filePath, JSON.stringify(backdated1, null, 2), "utf-8");

    const doc2 = handoff.createHandoffDocument({
      sessionId: "hop-2",
      projectId: "proj",
      branch: "feat/multi",
      issueId: null,
      workspacePath,
      workSummary: "Second pass",
      remainingWork: "Some left",
      currentState: "Halfway",
    });

    // Backdate doc2 to 1 minute ago
    const backdated2 = {
      fromSessionId: "hop-2",
      projectId: "proj",
      branch: "feat/multi",
      issueId: null,
      workSummary: "Second pass",
      remainingWork: "Some left",
      currentState: "Halfway",
      createdAt: new Date(Date.now() - 60000).toISOString(),
      filePath: doc2.filePath,
    };
    writeFileSync(doc2.filePath, JSON.stringify(backdated2, null, 2), "utf-8");

    handoff.createHandoffDocument({
      sessionId: "hop-3",
      projectId: "proj",
      branch: "feat/multi",
      issueId: null,
      workspacePath,
      workSummary: "Third pass",
      remainingWork: "Almost done",
      currentState: "Near finish",
    });

    const docs = handoff.findHandoffs(workspacePath, "feat/multi");
    expect(docs).toHaveLength(3);
    // Most recent first
    expect(docs[0].fromSessionId).toBe("hop-3");
    expect(docs[1].fromSessionId).toBe("hop-2");
    expect(docs[2].fromSessionId).toBe("hop-1");
  });

  it("works with custom handoffDir for all operations", () => {
    const customDir = join(workspacePath, "my-custom-dir");
    const handoff = createSelfHandoff({ handoffDir: customDir });

    const doc = handoff.createHandoffDocument({
      sessionId: "custom-1",
      projectId: "proj",
      branch: "main",
      issueId: null,
      workspacePath,
      workSummary: "s",
      remainingWork: "r",
      currentState: "c",
    });

    // find should work via custom dir
    const found = handoff.findHandoffs(workspacePath);
    expect(found).toHaveLength(1);

    // read should work
    const read = handoff.readHandoffDocument(doc.filePath);
    expect(read).not.toBeNull();

    // cleanup should work
    const removed = handoff.cleanupHandoffs(workspacePath);
    expect(removed).toBe(0); // Fresh file, nothing to clean
  });
});
