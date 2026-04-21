import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
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

function mockDesktopViewport() {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: !query.includes("max-width: 767px"),
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

describe("SessionDetail merge conflict actions", () => {
  beforeEach(() => {
    mockDesktopViewport();
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(""),
      } as Response),
    );
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText: vi.fn(() => Promise.resolve()) },
      configurable: true,
    });
  });

  it("renders compare and copy actions when the PR has merge conflicts", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "worker-conflict",
          projectId: "my-app",
          pr: makePR({
            number: 99,
            title: "Conflict PR",
            branch: "feat/has-conflict",
            mergeability: {
              mergeable: false,
              ciPassing: true,
              approved: true,
              noConflicts: false,
              blockers: ["Merge conflicts"],
            },
          }),
        })}
        projectOrchestratorId="orch-1"
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: "PR #99" }));

    const compare = screen.getByRole("link", { name: /Compare with base branch/i });
    expect(compare).toHaveAttribute(
      "href",
      "https://github.com/acme/app/compare/main...feat%2Fhas-conflict",
    );
    expect(screen.getByRole("button", { name: /Copy head branch name/i })).toBeInTheDocument();
  });

  it("hides conflict actions when mergeability data is not reliable", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "worker-unenriched",
          projectId: "my-app",
          pr: makePR({
            number: 100,
            enriched: false,
            mergeability: {
              mergeable: false,
              ciPassing: true,
              approved: true,
              noConflicts: false,
              blockers: ["API rate limited or unavailable"],
            },
          }),
        })}
        projectOrchestratorId="orch-1"
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: "PR #100" }));
    expect(screen.queryByRole("link", { name: /Compare with base branch/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Copy head branch name/i })).not.toBeInTheDocument();
  });
});
