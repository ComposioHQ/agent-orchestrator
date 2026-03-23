import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CIChecksPanel } from "@/components/CIChecksPanel";
import type { DashboardCICheck } from "@/lib/types";

describe("CIChecksPanel", () => {
  it("renders nothing when checks array is empty", () => {
    const { container } = render(<CIChecksPanel checks={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders CI checks when provided", () => {
    const checks: DashboardCICheck[] = [
      { name: "lint", status: "passed" },
      { name: "test", status: "failed" },
    ];
    render(<CIChecksPanel checks={checks} />);
    expect(screen.getByText("lint")).toBeInTheDocument();
    expect(screen.getByText("test")).toBeInTheDocument();
  });

  it("renders a single passing check", () => {
    const checks: DashboardCICheck[] = [{ name: "build", status: "passed" }];
    render(<CIChecksPanel checks={checks} />);
    expect(screen.getByText("build")).toBeInTheDocument();
  });
});
