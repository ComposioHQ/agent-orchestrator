import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusLine } from "@/components/StatusLine";
import type { DashboardStats } from "@/lib/types";

describe("StatusLine", () => {
  it("renders 'no sessions' when totalSessions is 0", () => {
    const stats: DashboardStats = {
      totalSessions: 0,
      workingSessions: 0,
      openPRs: 0,
      needsReview: 0,
    };

    render(<StatusLine stats={stats} />);

    expect(screen.getByText("no sessions")).toBeInTheDocument();
  });

  it("renders session count", () => {
    const stats: DashboardStats = {
      totalSessions: 5,
      workingSessions: 0,
      openPRs: 0,
      needsReview: 0,
    };

    render(<StatusLine stats={stats} />);

    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("sessions")).toBeInTheDocument();
  });

  it("renders working count when non-zero", () => {
    const stats: DashboardStats = {
      totalSessions: 5,
      workingSessions: 3,
      openPRs: 0,
      needsReview: 0,
    };

    render(<StatusLine stats={stats} />);

    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("working")).toBeInTheDocument();
  });

  it("renders open PRs count when non-zero", () => {
    const stats: DashboardStats = {
      totalSessions: 5,
      workingSessions: 0,
      openPRs: 2,
      needsReview: 0,
    };

    render(<StatusLine stats={stats} />);

    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("PRs")).toBeInTheDocument();
  });

  it("renders needs review count when non-zero", () => {
    const stats: DashboardStats = {
      totalSessions: 5,
      workingSessions: 0,
      openPRs: 0,
      needsReview: 4,
    };

    render(<StatusLine stats={stats} />);

    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("need review")).toBeInTheDocument();
  });

  it("omits zero-value optional parts", () => {
    const stats: DashboardStats = {
      totalSessions: 3,
      workingSessions: 0,
      openPRs: 0,
      needsReview: 0,
    };

    render(<StatusLine stats={stats} />);

    expect(screen.queryByText("working")).not.toBeInTheDocument();
    expect(screen.queryByText("PRs")).not.toBeInTheDocument();
    expect(screen.queryByText("need review")).not.toBeInTheDocument();
  });
});
