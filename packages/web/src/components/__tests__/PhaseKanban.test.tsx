import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PhaseKanban } from "../PhaseKanban";
import { makeSession } from "../../__tests__/helpers";

let currentParams = new URLSearchParams();
const replaceMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: replaceMock, refresh: vi.fn() }),
  usePathname: () => "/phases",
  useSearchParams: () => currentParams,
}));

beforeEach(() => {
  currentParams = new URLSearchParams();
  replaceMock.mockClear();
  const eventSourceMock = {
    onmessage: null,
    onerror: null,
    close: vi.fn(),
  };
  const eventSourceConstructor = vi.fn(() => eventSourceMock as unknown as EventSource);
  global.EventSource = Object.assign(eventSourceConstructor, {
    CONNECTING: 0,
    OPEN: 1,
    CLOSED: 2,
  }) as unknown as typeof EventSource;
  global.fetch = vi.fn();
});

describe("PhaseKanban", () => {
  it("renders the Kanban heading and all 4 lanes collapsed by default", () => {
    render(<PhaseKanban initialSessions={[]} />);
    expect(screen.getByRole("heading", { name: "Kanban" })).toBeInTheDocument();
    expect(screen.getByText("Pre-PR")).toBeInTheDocument();
    expect(screen.getByText("PR Review")).toBeInTheDocument();
    expect(screen.getByText("Merge")).toBeInTheDocument();
    expect(screen.getByText("Attention")).toBeInTheDocument();
  });

  it("groups a ci_failed session into the PR Review lane", () => {
    const session = makeSession({ id: "s1", status: "ci_failed" });
    const { container } = render(<PhaseKanban initialSessions={[session]} />);
    const laneEl = container.querySelector('[data-lane="prReview"]');
    expect(laneEl).not.toBeNull();
    expect(laneEl?.textContent).toContain("1");
  });

  it("groups merged sessions into the Done bar, not any lane", () => {
    const merged = makeSession({ id: "m1", status: "merged" });
    const { container } = render(<PhaseKanban initialSessions={[merged]} />);
    expect(screen.getByText("Done / Terminated")).toBeInTheDocument();
    const prePr = container.querySelector('[data-lane="prePr"]');
    const attention = container.querySelector('[data-lane="attention"]');
    // Lanes render a zero count, not the session.
    expect(prePr?.querySelector(".kanban-column__count")?.textContent).toBe("0");
    expect(attention?.querySelector(".kanban-column__count")?.textContent).toBe("0");
  });

  it("PR Review lane count aggregates multiple statuses when collapsed", () => {
    const sessions = [
      makeSession({ id: "a", status: "pr_open" }),
      makeSession({ id: "b", status: "ci_failed" }),
      makeSession({ id: "c", status: "changes_requested" }),
    ];
    const { container } = render(<PhaseKanban initialSessions={sessions} />);
    const lane = container.querySelector('[data-lane="prReview"]');
    expect(lane?.querySelector(".kanban-column__count")?.textContent).toBe("3");
  });

  it("renders per-status sub-columns when subphases=1", () => {
    currentParams = new URLSearchParams("subphases=1");
    const sessions = [
      makeSession({ id: "a", status: "pr_open" }),
      makeSession({ id: "b", status: "ci_failed" }),
    ];
    const { container } = render(<PhaseKanban initialSessions={sessions} />);
    const lane = container.querySelector('[data-lane="prReview"]');
    expect(lane?.classList.contains("phase-lane--expanded")).toBe(true);
    const ciFailedCol = lane?.querySelector('[data-status="ci_failed"]');
    const prOpenCol = lane?.querySelector('[data-status="pr_open"]');
    expect(ciFailedCol).not.toBeNull();
    expect(prOpenCol).not.toBeNull();
    expect(ciFailedCol?.querySelector(".kanban-column__count")?.textContent).toBe("1");
    expect(prOpenCol?.querySelector(".kanban-column__count")?.textContent).toBe("1");
  });

  it("toggle button calls router.replace with subphases param", () => {
    render(<PhaseKanban initialSessions={[]} />);
    const button = screen.getByRole("button", { name: /show sub-phases/i });
    fireEvent.click(button);
    expect(replaceMock).toHaveBeenCalledWith("/phases?subphases=1");
  });
});
