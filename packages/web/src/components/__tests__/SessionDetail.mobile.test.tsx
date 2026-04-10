import { render, screen, within } from "@testing-library/react";
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

function mockMobileViewport() {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: query.includes("max-width: 767px"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

describe("SessionDetail mobile navbar", () => {
  beforeEach(() => {
    mockMobileViewport();
  });

  it("shows dashboard, PRs, and orchestrator nav on orchestrator pages", () => {
    const session = makeSession({
      id: "my-app-orchestrator",
      projectId: "my-app",
      metadata: { role: "orchestrator" },
      summary: "Orchestrator session title",
      branch: null,
    });

    render(
      <SessionDetail
        session={session}
        isOrchestrator
        orchestratorZones={{ merge: 1, respond: 0, review: 0, pending: 0, working: 2, done: 0 }}
        projectOrchestratorId="my-app-orchestrator"
      />,
    );

    const nav = screen.getByRole("navigation", { name: /session navigation/i });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", "/?project=my-app");
    expect(screen.getByRole("link", { name: "PRs" })).toHaveAttribute("href", "/prs?project=my-app");
    expect(screen.getAllByRole("link", { name: "Orchestrator" }).at(-1)).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getAllByText("Orchestrator session title")).toHaveLength(1);
    expect(screen.queryByText("agents")).not.toBeInTheDocument();
    expect(screen.queryByText("responding")).not.toBeInTheDocument();
  });

  it("routes PRs to the dedicated page from worker session pages", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "worker-1",
          projectId: "my-app",
          pr: makePR({ number: 55, title: "Fix mobile navbar" }),
        })}
        projectOrchestratorId="my-app-orchestrator"
      />,
    );

    expect(screen.getByRole("link", { name: "PRs" })).toHaveAttribute("href", "/prs?project=my-app");
    expect(screen.getAllByRole("link", { name: "Orchestrator" }).at(-1)).toHaveAttribute(
      "href",
      "/sessions/my-app-orchestrator",
    );
  });

  it("hides the orchestrator nav item when no orchestrator destination exists", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "worker-4",
          projectId: "my-app",
          pr: makePR({ number: 56, title: "No orchestrator yet" }),
        })}
        projectOrchestratorId={null}
      />,
    );

    const nav = screen.getByRole("navigation", { name: /session navigation/i });

    expect(within(nav).getByRole("link", { name: "Dashboard" })).toHaveAttribute(
      "href",
      "/?project=my-app",
    );
    expect(within(nav).getByRole("link", { name: "PRs" })).toHaveAttribute(
      "href",
      "/prs?project=my-app",
    );
    expect(within(nav).queryByRole("link", { name: "Orchestrator" })).not.toBeInTheDocument();
    expect(within(nav).queryByRole("button", { name: "Orchestrator" })).not.toBeInTheDocument();
  });

  it("keeps branch and PR chips in the compact mobile header", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "worker-2",
          projectId: "my-app",
          summary: "Compact mobile header",
          branch: "feat/compact-header",
          pr: makePR({ number: 77, title: "Compact header polish" }),
        })}
        projectOrchestratorId="my-app-orchestrator"
      />,
    );

    expect(screen.getByText("Compact header polish")).toBeInTheDocument();
    expect(screen.getByText("feat/compact-header")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "PR #77" })).toHaveClass(
      "session-detail-link-pill--link",
    );
    expect(screen.getByRole("link", { name: "feat/compact-header" })).toHaveClass(
      "session-detail-link-pill--link",
    );
  });

  it("prefers issue title over changing summary text", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "worker-stable-title",
          projectId: "my-app",
          issueTitle: "Fix stable session titles",
          summary: "Responding to latest review comment",
          branch: "fix/stable-session-titles",
        })}
        projectOrchestratorId="my-app-orchestrator"
      />,
    );

    expect(screen.getByText("Fix stable session titles")).toBeInTheDocument();
    expect(screen.queryByText("Responding to latest review comment")).not.toBeInTheDocument();
  });

  it("preserves CI and unresolved review comment detail on mobile session pages", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "worker-3",
          projectId: "my-app",
          summary: "Review heavy session",
          pr: makePR({
            number: 88,
            title: "Keep PR detail intact",
            ciStatus: "failing",
            ciChecks: [
              { name: "build", status: "failed", url: "https://ci.example/build" },
              { name: "lint", status: "passed", url: "https://ci.example/lint" },
            ],
            reviewDecision: "changes_requested",
            mergeability: {
              mergeable: false,
              ciPassing: false,
              approved: false,
              noConflicts: true,
              blockers: ["CI failing", "Changes requested"],
            },
            unresolvedThreads: 2,
            unresolvedComments: [
              {
                url: "https://github.com/acme/app/pull/88#discussion_r1",
                path: "src/app.ts",
                author: "bugbot",
                body: "### Fix null handling\n<!-- DESCRIPTION START -->Handle missing data safely<!-- DESCRIPTION END -->",
              },
            ],
          }),
        })}
        projectOrchestratorId="my-app-orchestrator"
      />,
    );

    expect(screen.getByText(/CI failing/i)).toBeInTheDocument();
    expect(screen.getByText(/Changes requested/i)).toBeInTheDocument();
    expect(screen.getByText(/2 unresolved comments/i)).toBeInTheDocument();
    expect(screen.getByText("Unresolved Comments")).toBeInTheDocument();
    expect(screen.getByText("Fix null handling")).toBeInTheDocument();
    expect(screen.getByText("build")).toBeInTheDocument();
    expect(screen.getByText("lint")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ask Agent to Fix" })).toBeInTheDocument();
  });

  it("shows the merged badge styling for merged PR sessions", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "worker-merged",
          projectId: "my-app",
          summary: "Merged session",
          pr: makePR({
            number: 89,
            state: "merged",
            title: "Preserve merged badge styling",
          }),
        })}
        projectOrchestratorId="my-app-orchestrator"
      />,
    );

    const mergedBadge = screen.getByText("Merged");
    expect(mergedBadge).toBeInTheDocument();
    expect(mergedBadge).toHaveStyle({
      color: "var(--color-text-secondary)",
      background: "var(--color-chip-bg)",
    });
  });
});
