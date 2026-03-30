import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BottomSheet } from "../BottomSheet";
import type { DashboardSession } from "@/lib/types";

function makeSession(overrides: Partial<DashboardSession> = {}): DashboardSession {
  return {
    id: "ses-1",
    projectId: "proj",
    status: "working",
    activity: "active",
    branch: "feat/thing",
    issueId: null,
    issueUrl: null,
    issueLabel: null,
    issueTitle: null,
    summary: "Implementing feature",
    summaryIsFallback: false,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    pr: null,
    metadata: {},
    ...overrides,
  };
}

function makePR() {
  return {
    number: 42,
    url: "https://github.com/acme/app/pull/42",
    title: "feat: add health check",
    owner: "acme",
    repo: "app",
    branch: "feat/health",
    baseBranch: "main",
    isDraft: false,
    state: "open" as const,
    additions: 10,
    deletions: 2,
    ciStatus: "passing" as const,
    ciChecks: [],
    reviewDecision: "approved" as const,
    mergeability: {
      mergeable: true,
      ciPassing: true,
      approved: true,
      noConflicts: true,
      blockers: [],
    },
    unresolvedThreads: 0,
    unresolvedComments: [],
  };
}

describe("BottomSheet", () => {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  const onRequestKill = vi.fn();
  const onMerge = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when session is null", () => {
    const { container } = render(
      <BottomSheet
        session={null}
        mode="preview"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders session info in preview mode", () => {
    const session = makeSession();
    render(
      <BottomSheet
        session={session}
        mode="preview"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    // Title derived from summary appears in sheet
    expect(screen.getAllByText("Implementing feature").length).toBeGreaterThanOrEqual(1);
    // Open session link
    expect(screen.getByText("Open session")).toBeInTheDocument();
  });

  it("renders confirm-kill mode", () => {
    const session = makeSession();
    render(
      <BottomSheet
        session={session}
        mode="confirm-kill"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByText("Terminate session?")).toBeInTheDocument();
    expect(screen.getByText("This action cannot be undone.")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
    expect(screen.getByText("Terminate")).toBeInTheDocument();
  });

  it("calls onCancel when Cancel button is clicked in confirm-kill mode", () => {
    const session = makeSession();
    render(
      <BottomSheet
        session={session}
        mode="confirm-kill"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("calls onConfirm when Terminate button is clicked in confirm-kill mode", () => {
    const session = makeSession();
    render(
      <BottomSheet
        session={session}
        mode="confirm-kill"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByText("Terminate"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel on Escape key press", () => {
    const session = makeSession();
    render(
      <BottomSheet
        session={session}
        mode="preview"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel on backdrop click", () => {
    const session = makeSession();
    render(
      <BottomSheet
        session={session}
        mode="preview"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    const backdrop = document.querySelector(".bottom-sheet-backdrop");
    expect(backdrop).toBeTruthy();
    if (backdrop) {
      fireEvent.click(backdrop);
    }
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows terminate button for live sessions", () => {
    const session = makeSession({ status: "working", activity: "active" });
    render(
      <BottomSheet
        session={session}
        mode="preview"
        onCancel={onCancel}
        onConfirm={onConfirm}
        onRequestKill={onRequestKill}
      />,
    );

    const terminateBtn = screen.getByText("Terminate");
    expect(terminateBtn).toBeInTheDocument();
  });

  it("calls onRequestKill when Terminate button clicked in preview", () => {
    const session = makeSession({ status: "working", activity: "active" });
    render(
      <BottomSheet
        session={session}
        mode="preview"
        onCancel={onCancel}
        onConfirm={onConfirm}
        onRequestKill={onRequestKill}
      />,
    );

    fireEvent.click(screen.getByText("Terminate"));
    expect(onRequestKill).toHaveBeenCalledTimes(1);
  });

  it("does not show terminate button for terminal sessions", () => {
    const session = makeSession({ status: "killed", activity: "exited" });
    render(
      <BottomSheet
        session={session}
        mode="preview"
        onCancel={onCancel}
        onConfirm={onConfirm}
        onRequestKill={onRequestKill}
      />,
    );

    expect(screen.queryByText("Terminate")).not.toBeInTheDocument();
  });

  it("shows Merge button when merge-ready", () => {
    const session = makeSession({
      status: "mergeable",
      pr: makePR(),
    });
    render(
      <BottomSheet
        session={session}
        mode="preview"
        onCancel={onCancel}
        onConfirm={onConfirm}
        onMerge={onMerge}
        isMergeReady={true}
      />,
    );

    const mergeBtn = screen.getByText("Merge");
    expect(mergeBtn).toBeInTheDocument();

    fireEvent.click(mergeBtn);
    expect(onMerge).toHaveBeenCalledWith(42);
  });

  it("displays tags for session metadata", () => {
    const session = makeSession({
      branch: "feat/auth",
      pr: makePR(),
      issueLabel: "INT-42",
    });
    render(
      <BottomSheet
        session={session}
        mode="preview"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByText("feat/auth")).toBeInTheDocument();
    expect(screen.getByText("PR #42")).toBeInTheDocument();
    expect(screen.getByText("INT-42")).toBeInTheDocument();
  });

  it("shows summary when not a fallback", () => {
    // Use a different summary from title so we can check the summary paragraph specifically
    const session = makeSession({
      summary: "Working on auth module",
      summaryIsFallback: false,
      pr: { ...makePR(), title: "feat: auth" },
    });
    const { container } = render(
      <BottomSheet
        session={session}
        mode="preview"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    // The summary paragraph should be present
    expect(container.querySelector(".bottom-sheet__summary")).toBeInTheDocument();
    expect(container.querySelector(".bottom-sheet__summary")?.textContent).toBe(
      "Working on auth module",
    );
  });

  it("does not show summary paragraph when summary is a fallback", () => {
    const session = makeSession({ summary: "Fallback summary", summaryIsFallback: true });
    const { container } = render(
      <BottomSheet
        session={session}
        mode="preview"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    expect(container.querySelector(".bottom-sheet__summary")).not.toBeInTheDocument();
  });

  it("handles swipe down gesture to close", () => {
    const session = makeSession();
    render(
      <BottomSheet
        session={session}
        mode="preview"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    const sheet = document.querySelector(".bottom-sheet");
    expect(sheet).toBeTruthy();

    if (sheet) {
      fireEvent.touchStart(sheet, {
        touches: [{ clientY: 100 }],
      });
      fireEvent.touchEnd(sheet, {
        changedTouches: [{ clientY: 200 }],
      });
    }
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("does not close on small swipe", () => {
    const session = makeSession();
    render(
      <BottomSheet
        session={session}
        mode="preview"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    const sheet = document.querySelector(".bottom-sheet");
    if (sheet) {
      fireEvent.touchStart(sheet, {
        touches: [{ clientY: 100 }],
      });
      fireEvent.touchEnd(sheet, {
        changedTouches: [{ clientY: 130 }],
      });
    }
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("traps Tab focus within the sheet", () => {
    const session = makeSession({ status: "working", activity: "active" });
    render(
      <BottomSheet
        session={session}
        mode="confirm-kill"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    const sheet = document.querySelector(".bottom-sheet");
    expect(sheet).toBeTruthy();

    const cancelBtn = screen.getByText("Cancel");
    const terminateBtn = screen.getByText("Terminate");

    // Focus the last element and Tab forward -> should wrap to first
    terminateBtn.focus();
    expect(document.activeElement).toBe(terminateBtn);

    if (sheet) {
      fireEvent.keyDown(sheet, { key: "Tab", shiftKey: false });
    }
    expect(document.activeElement).toBe(cancelBtn);

    // Focus first element and Shift+Tab -> should wrap to last
    cancelBtn.focus();
    if (sheet) {
      fireEvent.keyDown(sheet, { key: "Tab", shiftKey: true });
    }
    expect(document.activeElement).toBe(terminateBtn);
  });

  it("renders Open session link with correct href", () => {
    const session = makeSession({ id: "test-session" });
    render(
      <BottomSheet
        session={session}
        mode="preview"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    const link = screen.getByText("Open session");
    expect(link).toHaveAttribute("href", "/sessions/test-session");
  });

  it("encodes special characters in session id href", () => {
    const session = makeSession({ id: "test/session" });
    render(
      <BottomSheet
        session={session}
        mode="preview"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    const link = screen.getByText("Open session");
    expect(link).toHaveAttribute("href", "/sessions/test%2Fsession");
  });

  it("does not show terminate when session is terminated status", () => {
    const session = makeSession({ status: "terminated" });
    render(
      <BottomSheet
        session={session}
        mode="preview"
        onCancel={onCancel}
        onConfirm={onConfirm}
        onRequestKill={onRequestKill}
      />,
    );

    expect(screen.queryByText("Terminate")).not.toBeInTheDocument();
  });

  it("renders confirm-kill session name", () => {
    const session = makeSession({
      summary: "Auth feature work",
      summaryIsFallback: false,
    });
    render(
      <BottomSheet
        session={session}
        mode="confirm-kill"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    // In confirm-kill, the session name is shown in the session-info section
    const nameElement = document.querySelector(".bottom-sheet__session-name");
    expect(nameElement).toBeInTheDocument();
  });

  it("renders dialog with correct aria attributes", () => {
    const session = makeSession();
    render(
      <BottomSheet
        session={session}
        mode="preview"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", "bottom-sheet-title");
  });
});
