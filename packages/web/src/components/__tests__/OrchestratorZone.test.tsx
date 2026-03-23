import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { OrchestratorZone, type OrchestratorZones } from "@/components/OrchestratorZone";

function makeZones(overrides: Partial<OrchestratorZones> = {}): OrchestratorZones {
  return {
    merge: 0,
    respond: 0,
    review: 0,
    pending: 0,
    working: 0,
    done: 0,
    ...overrides,
  };
}

describe("OrchestratorZone", () => {
  it("renders total agent count", () => {
    render(
      <OrchestratorZone zones={makeZones({ working: 3, done: 2 })} createdAt={new Date().toISOString()} />,
    );
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("agents")).toBeInTheDocument();
  });

  it("renders zone pills for non-zero zones", () => {
    render(
      <OrchestratorZone
        zones={makeZones({ merge: 1, working: 2 })}
        createdAt={new Date().toISOString()}
      />,
    );
    expect(screen.getByText("merge-ready")).toBeInTheDocument();
    expect(screen.getByText("working")).toBeInTheDocument();
  });

  it("does not render pills for zero-value zones", () => {
    render(
      <OrchestratorZone zones={makeZones({ working: 1 })} createdAt={new Date().toISOString()} />,
    );
    expect(screen.queryByText("merge-ready")).not.toBeInTheDocument();
    expect(screen.queryByText("done")).not.toBeInTheDocument();
  });

  it("shows 'no active agents' when all zones are zero", () => {
    render(<OrchestratorZone zones={makeZones()} createdAt={new Date().toISOString()} />);
    expect(screen.getByText("no active agents")).toBeInTheDocument();
  });

  it("renders uptime", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    render(<OrchestratorZone zones={makeZones({ working: 1 })} createdAt={twoHoursAgo} />);
    expect(screen.getByText(/up 2h/)).toBeInTheDocument();
  });
});
