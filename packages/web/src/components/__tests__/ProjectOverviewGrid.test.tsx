import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ProjectOverviewGrid, type ProjectOverview } from "@/components/ProjectOverviewGrid";

describe("ProjectOverviewGrid", () => {
  const makeOverview = (overrides: Partial<ProjectOverview> = {}): ProjectOverview => ({
    project: { id: "my-app", name: "My App" },
    orchestrator: null,
    sessionCount: 3,
    openPRCount: 1,
    counts: { merge: 0, respond: 1, review: 0, pending: 1, working: 1, done: 0 },
    ...overrides,
  });

  it("renders project name and session count", () => {
    render(
      <ProjectOverviewGrid
        overviews={[makeOverview()]}
        onSpawnOrchestrator={vi.fn()}
        spawningProjectIds={[]}
        spawnErrors={{}}
      />,
    );

    expect(screen.getByText("My App")).toBeInTheDocument();
    expect(screen.getByText(/3 active sessions/)).toBeInTheDocument();
  });

  it("renders metric pills", () => {
    render(
      <ProjectOverviewGrid
        overviews={[makeOverview({ counts: { merge: 2, respond: 0, review: 1, pending: 0, working: 3, done: 0 } })]}
        onSpawnOrchestrator={vi.fn()}
        spawningProjectIds={[]}
        spawnErrors={{}}
      />,
    );

    expect(screen.getByText("Merge")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("Review")).toBeInTheDocument();
  });

  it("renders spawn button when no orchestrator", () => {
    render(
      <ProjectOverviewGrid
        overviews={[makeOverview()]}
        onSpawnOrchestrator={vi.fn()}
        spawningProjectIds={[]}
        spawnErrors={{}}
      />,
    );

    expect(screen.getByRole("button", { name: "Spawn Orchestrator" })).toBeInTheDocument();
    expect(screen.getByText("No running orchestrator")).toBeInTheDocument();
  });

  it("renders orchestrator link when orchestrator exists", () => {
    render(
      <ProjectOverviewGrid
        overviews={[makeOverview({ orchestrator: { id: "orch-1", projectId: "my-app", projectName: "My App" } })]}
        onSpawnOrchestrator={vi.fn()}
        spawningProjectIds={[]}
        spawnErrors={{}}
      />,
    );

    expect(screen.getByRole("link", { name: "orchestrator" })).toHaveAttribute(
      "href",
      "/sessions/orch-1",
    );
  });

  it("shows spawn error", () => {
    render(
      <ProjectOverviewGrid
        overviews={[makeOverview()]}
        onSpawnOrchestrator={vi.fn()}
        spawningProjectIds={[]}
        spawnErrors={{ "my-app": "Project is paused" }}
      />,
    );

    expect(screen.getByText("Project is paused")).toBeInTheDocument();
  });

  it("calls onSpawnOrchestrator when spawn button clicked", () => {
    const onSpawn = vi.fn().mockResolvedValue(undefined);

    render(
      <ProjectOverviewGrid
        overviews={[makeOverview()]}
        onSpawnOrchestrator={onSpawn}
        spawningProjectIds={[]}
        spawnErrors={{}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Spawn Orchestrator" }));
    expect(onSpawn).toHaveBeenCalledWith({ id: "my-app", name: "My App" });
  });
});
