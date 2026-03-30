import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionDetail } from "../SessionDetail";
import { makePR, makeSession } from "../../__tests__/helpers";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../DirectTerminal", () => ({
  DirectTerminal: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="direct-terminal">{sessionId}</div>
  ),
}));

vi.mock("../MobileBottomNav", () => ({
  MobileBottomNav: () => null,
}));

describe("SessionDetail — desktop rendering", () => {
  beforeEach(() => {
    // Desktop viewport (matchMedia returns false for mobile)
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      } as Response),
    );
  });

  it("renders the session headline from issue title", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "detail-1",
          issueTitle: "Fix auth flow",
          summary: "Working on auth",
        })}
      />,
    );

    expect(screen.getAllByText("Fix auth flow").length).toBeGreaterThan(0);
  });

  it("falls back to summary when no issue title", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "detail-2",
          issueTitle: null,
          summary: "Working on something",
        })}
      />,
    );

    expect(screen.getAllByText("Working on something").length).toBeGreaterThan(0);
  });

  it("falls back to session ID when no summary or issue title", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "detail-3",
          issueTitle: null,
          summary: null,
        })}
      />,
    );

    expect(screen.getAllByText("detail-3").length).toBeGreaterThan(0);
  });

  it("shows the terminal section", () => {
    render(
      <SessionDetail
        session={makeSession({ id: "detail-term" })}
      />,
    );

    expect(screen.getByText("Live Terminal")).toBeInTheDocument();
    expect(screen.getByTestId("direct-terminal")).toHaveTextContent("detail-term");
  });

  it("shows activity status pill for active session", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "detail-active",
          activity: "active",
        })}
      />,
    );

    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("shows activity status pill for waiting input", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "detail-wait",
          activity: "waiting_input",
        })}
      />,
    );

    expect(screen.getByText("Waiting for input")).toBeInTheDocument();
  });

  it("shows activity status pill for exited", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "detail-exited",
          activity: "exited",
        })}
      />,
    );

    expect(screen.getByText("Exited")).toBeInTheDocument();
  });

  it("shows unknown activity when activity is not in meta", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "detail-unknown",
          activity: null,
        })}
      />,
    );

    expect(screen.getByText("unknown")).toBeInTheDocument();
  });

  it("shows branch chip when branch is set", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "detail-branch",
          branch: "feat/my-branch",
        })}
      />,
    );

    expect(screen.getByText("feat/my-branch")).toBeInTheDocument();
  });

  it("links branch to GitHub when PR is present", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "detail-gh-branch",
          branch: "feat/linked-branch",
          pr: makePR({ owner: "acme", repo: "app", branch: "feat/linked-branch" }),
        })}
      />,
    );

    const branchLink = screen.getByText("feat/linked-branch").closest("a");
    expect(branchLink).toHaveAttribute("href", "https://github.com/acme/app/tree/feat/linked-branch");
  });

  it("shows PR chip with link", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "detail-pr-chip",
          pr: makePR({ number: 77, url: "https://github.com/acme/app/pull/77" }),
        })}
      />,
    );

    const prLink = screen.getByText("PR #77");
    expect(prLink.closest("a")).toHaveAttribute("href", "https://github.com/acme/app/pull/77");
  });

  it("shows dashboard breadcrumb", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "detail-crumb",
          projectId: "my-project",
        })}
      />,
    );

    const crumb = screen.getByText("Dashboard");
    expect(crumb.closest("a")).toHaveAttribute("href", "/?project=my-project");
  });

  it("shows 'Orchestrator' breadcrumb label for orchestrator sessions", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "orch-1",
          metadata: { role: "orchestrator" },
        })}
        isOrchestrator
        orchestratorZones={{ merge: 0, respond: 0, review: 0, pending: 0, working: 0, done: 0 }}
      />,
    );

    expect(screen.getByText("Orchestrator")).toBeInTheDocument();
  });
});

describe("SessionDetail — PR card rendering", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response),
    );
  });

  it("shows PR card with title and diff stats", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "pr-card-1",
          pr: makePR({ number: 42, title: "Add new feature", additions: 100, deletions: 20 }),
        })}
      />,
    );

    expect(screen.getByText(/PR #42: Add new feature/)).toBeInTheDocument();
    expect(screen.getByText("+100")).toBeInTheDocument();
    expect(screen.getByText("-20")).toBeInTheDocument();
  });

  it("shows Draft badge for draft PRs", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "pr-draft",
          pr: makePR({ isDraft: true }),
        })}
      />,
    );

    expect(screen.getByText("Draft")).toBeInTheDocument();
  });

  it("shows Merged badge for merged PRs", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "pr-merged",
          pr: makePR({ state: "merged" }),
        })}
      />,
    );

    expect(screen.getByText("Merged")).toBeInTheDocument();
  });

  it("shows Ready to merge banner when PR is fully mergeable", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "pr-ready",
          pr: makePR({
            state: "open",
            mergeability: {
              mergeable: true,
              ciPassing: true,
              approved: true,
              noConflicts: true,
              blockers: [],
            },
          }),
        })}
      />,
    );

    expect(screen.getByText("Ready to merge")).toBeInTheDocument();
  });

  it("shows CI failing blocker in issues list", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "pr-ci-fail",
          pr: makePR({
            state: "open",
            ciStatus: "failing",
            ciChecks: [{ name: "build", status: "failed" }, { name: "lint", status: "failed" }],
            mergeability: {
              mergeable: false,
              ciPassing: false,
              approved: true,
              noConflicts: true,
              blockers: [],
            },
          }),
        })}
      />,
    );

    expect(screen.getByText(/CI failing.*2 checks failed/)).toBeInTheDocument();
  });

  it("shows CI pending in issues list", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "pr-ci-pend",
          pr: makePR({
            state: "open",
            ciStatus: "pending",
            mergeability: {
              mergeable: false,
              ciPassing: false,
              approved: true,
              noConflicts: true,
              blockers: [],
            },
          }),
        })}
      />,
    );

    expect(screen.getByText("CI pending")).toBeInTheDocument();
  });

  it("shows changes requested blocker", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "pr-changes",
          pr: makePR({
            state: "open",
            reviewDecision: "changes_requested",
            mergeability: {
              mergeable: false,
              ciPassing: true,
              approved: false,
              noConflicts: true,
              blockers: [],
            },
          }),
        })}
      />,
    );

    expect(screen.getByText("Changes requested")).toBeInTheDocument();
  });

  it("shows not approved blocker when not approved", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "pr-not-approved",
          pr: makePR({
            state: "open",
            reviewDecision: "pending",
            mergeability: {
              mergeable: false,
              ciPassing: true,
              approved: false,
              noConflicts: true,
              blockers: [],
            },
          }),
        })}
      />,
    );

    expect(screen.getByText(/Not approved/)).toBeInTheDocument();
  });

  it("shows merge conflicts blocker", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "pr-conflict",
          pr: makePR({
            state: "open",
            mergeability: {
              mergeable: false,
              ciPassing: true,
              approved: true,
              noConflicts: false,
              blockers: [],
            },
          }),
        })}
      />,
    );

    expect(screen.getByText("Merge conflicts")).toBeInTheDocument();
  });

  it("shows not mergeable fallback when no specific issues", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "pr-not-mergeable",
          pr: makePR({
            state: "open",
            ciStatus: "passing",
            reviewDecision: "approved",
            mergeability: {
              mergeable: false,
              ciPassing: true,
              approved: true,
              noConflicts: true,
              blockers: [],
            },
          }),
        })}
      />,
    );

    expect(screen.getByText("Not mergeable")).toBeInTheDocument();
  });

  it("shows unresolved comments in issues list", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "pr-threads",
          pr: makePR({
            state: "open",
            unresolvedThreads: 3,
            mergeability: {
              mergeable: false,
              ciPassing: true,
              approved: true,
              noConflicts: true,
              blockers: [],
            },
          }),
        })}
      />,
    );

    expect(screen.getByText(/3 unresolved comments/)).toBeInTheDocument();
  });

  it("shows Draft PR in issues list for draft PRs", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "pr-draft-issue",
          pr: makePR({
            isDraft: true,
            state: "open",
            mergeability: {
              mergeable: false,
              ciPassing: true,
              approved: true,
              noConflicts: true,
              blockers: [],
            },
          }),
        })}
      />,
    );

    expect(screen.getByText("Draft PR")).toBeInTheDocument();
  });

  it("shows CI checks list on the PR card", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "pr-checks",
          pr: makePR({
            ciChecks: [
              { name: "build", status: "passed" },
              { name: "test", status: "failed" },
              { name: "lint", status: "pending" },
            ],
          }),
        })}
      />,
    );

    expect(screen.getByText("build")).toBeInTheDocument();
    expect(screen.getByText("test")).toBeInTheDocument();
    expect(screen.getByText("lint")).toBeInTheDocument();
  });

  it("renders unresolved comments detail section", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "pr-comments",
          pr: makePR({
            unresolvedThreads: 1,
            unresolvedComments: [
              {
                url: "https://github.com/acme/app/pull/1#r1",
                path: "src/index.ts",
                author: "reviewer",
                body: "### Fix this bug\n<!-- DESCRIPTION START -->Handle null pointer<!-- DESCRIPTION END -->",
              },
            ],
          }),
        })}
      />,
    );

    expect(screen.getByText("Unresolved Comments")).toBeInTheDocument();
    expect(screen.getByText("Fix this bug")).toBeInTheDocument();
    expect(screen.getByText(/reviewer/)).toBeInTheDocument();
    expect(screen.getByText("src/index.ts")).toBeInTheDocument();
    expect(screen.getByText("Handle null pointer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ask Agent to Fix" })).toBeInTheDocument();
  });

  it("sends fix request when 'Ask Agent to Fix' is clicked", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response),
    );
    global.fetch = fetchMock;

    render(
      <SessionDetail
        session={makeSession({
          id: "pr-ask-fix",
          pr: makePR({
            unresolvedThreads: 1,
            unresolvedComments: [
              {
                url: "https://github.com/acme/app/pull/1#r1",
                path: "src/index.ts",
                author: "reviewer",
                body: "Fix the bug please",
              },
            ],
          }),
        })}
      />,
    );

    const fixBtn = screen.getByRole("button", { name: "Ask Agent to Fix" });
    await act(async () => {
      fireEvent.click(fixBtn);
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/sessions/pr-ask-fix/message"),
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("shows Sent state after successful fix request", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response),
    );

    render(
      <SessionDetail
        session={makeSession({
          id: "pr-sent",
          pr: makePR({
            unresolvedThreads: 1,
            unresolvedComments: [
              {
                url: "https://github.com/acme/app/pull/1#r1",
                path: "src/a.ts",
                author: "bot",
                body: "Fix it",
              },
            ],
          }),
        })}
      />,
    );

    const fixBtn = screen.getByRole("button", { name: "Ask Agent to Fix" });
    await act(async () => {
      fireEvent.click(fixBtn);
    });

    await waitFor(() => {
      expect(screen.queryByText(/Sent/)).toBeInTheDocument();
    });

    vi.useRealTimers();
  });

  it("shows error state on fix request failure", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: false, status: 500 } as Response),
    );

    render(
      <SessionDetail
        session={makeSession({
          id: "pr-fail-fix",
          pr: makePR({
            unresolvedThreads: 1,
            unresolvedComments: [
              {
                url: "https://github.com/acme/app/pull/1#r1",
                path: "src/a.ts",
                author: "bot",
                body: "Fix it",
              },
            ],
          }),
        })}
      />,
    );

    const fixBtn = screen.getByRole("button", { name: "Ask Agent to Fix" });
    await act(async () => {
      fireEvent.click(fixBtn);
    });

    await waitFor(() => {
      expect(screen.getByText("Failed")).toBeInTheDocument();
    });

    vi.useRealTimers();
  });
});

describe("SessionDetail — orchestrator mode", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response),
    );
  });

  it("shows orchestrator status strip with zone counts", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "orch-detail",
          metadata: { role: "orchestrator" },
          summary: "Orchestrator overview",
        })}
        isOrchestrator
        orchestratorZones={{
          merge: 2,
          respond: 1,
          review: 3,
          pending: 0,
          working: 5,
          done: 4,
        }}
      />,
    );

    // Total agents = 2+1+3+0+5+4 = 15
    expect(screen.getByText("15")).toBeInTheDocument();
    expect(screen.getByText("agents")).toBeInTheDocument();

    // Zone labels
    expect(screen.getByText("merge-ready")).toBeInTheDocument();
    expect(screen.getByText("responding")).toBeInTheDocument();
    expect(screen.getByText("review")).toBeInTheDocument();
    expect(screen.getByText("working")).toBeInTheDocument();
    expect(screen.getByText("done")).toBeInTheDocument();
  });

  it("shows 'no active agents' when all zones are zero", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "orch-empty",
          metadata: { role: "orchestrator" },
        })}
        isOrchestrator
        orchestratorZones={{
          merge: 0,
          respond: 0,
          review: 0,
          pending: 0,
          working: 0,
          done: 0,
        }}
      />,
    );

    expect(screen.getByText("no active agents")).toBeInTheDocument();
  });

  it("renders orchestrator variant terminal", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "orch-term",
          metadata: { role: "orchestrator" },
        })}
        isOrchestrator
        orchestratorZones={{ merge: 0, respond: 0, review: 0, pending: 0, working: 1, done: 0 }}
      />,
    );

    expect(screen.getByTestId("direct-terminal")).toHaveTextContent("orch-term");
  });

  it("sets orchestrator badge in header", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "orch-badge",
          metadata: { role: "orchestrator" },
        })}
        isOrchestrator
        orchestratorZones={{ merge: 0, respond: 0, review: 0, pending: 0, working: 0, done: 0 }}
      />,
    );

    expect(screen.getByText("orchestrator")).toBeInTheDocument();
  });
});

describe("SessionDetail — OpenCode session handling", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response),
    );
  });

  it("renders without PR section when no PR", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "no-pr",
          pr: null,
        })}
      />,
    );

    expect(screen.queryByText(/PR #/)).not.toBeInTheDocument();
  });
});
