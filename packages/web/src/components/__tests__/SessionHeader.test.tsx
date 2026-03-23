import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SessionHeader } from "@/components/SessionHeader";
import type { DashboardSession } from "@/lib/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

function makeSession(overrides: Partial<DashboardSession> = {}): DashboardSession {
  return {
    id: "session-1",
    projectId: "my-project",
    status: "running",
    activity: "active",
    branch: "feat/test",
    issueId: null,
    issueUrl: null,
    issueLabel: null,
    issueTitle: null,
    summary: "Test summary",
    summaryIsFallback: false,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    pr: null,
    metadata: {},
    ...overrides,
  };
}

describe("SessionHeader", () => {
  it("renders session id", () => {
    render(<SessionHeader session={makeSession()} />);
    expect(screen.getByText("session-1")).toBeInTheDocument();
  });

  it("renders summary text", () => {
    render(<SessionHeader session={makeSession({ summary: "Implementing feature X" })} />);
    expect(screen.getByText("Implementing feature X")).toBeInTheDocument();
  });

  it("renders project id chip", () => {
    render(<SessionHeader session={makeSession({ projectId: "cool-project" })} />);
    expect(screen.getByText("cool-project")).toBeInTheDocument();
  });

  it("renders activity badge", () => {
    render(<SessionHeader session={makeSession({ activity: "active" })} />);
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("renders branch chip", () => {
    render(<SessionHeader session={makeSession({ branch: "fix/bug-123" })} />);
    expect(screen.getByText("fix/bug-123")).toBeInTheDocument();
  });

  it("renders issue link when issueUrl is set", () => {
    render(
      <SessionHeader
        session={makeSession({
          issueUrl: "https://github.com/org/repo/issues/42",
          issueLabel: "#42",
        })}
      />,
    );
    expect(screen.getByText("#42")).toBeInTheDocument();
  });

  it("renders status chip with humanized text", () => {
    render(<SessionHeader session={makeSession({ status: "ci_failed" })} />);
    expect(screen.getByText("CI Failed")).toBeInTheDocument();
  });

  it("renders without summary when null", () => {
    render(<SessionHeader session={makeSession({ summary: null })} />);
    expect(screen.getByText("session-1")).toBeInTheDocument();
  });
});
