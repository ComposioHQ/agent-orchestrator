import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SpawnOrchestratorButton } from "@/components/SpawnOrchestratorButton";
import type { ProjectInfo } from "@/lib/project-name";

describe("SpawnOrchestratorButton", () => {
  const project: ProjectInfo = { id: "my-app", name: "My App" };

  it("renders spawn button when no orchestrator", () => {
    render(
      <SpawnOrchestratorButton
        project={project}
        orchestrator={null}
        onSpawnOrchestrator={vi.fn()}
        isSpawning={false}
      />,
    );

    expect(screen.getByRole("button", { name: "Spawn Orchestrator" })).toBeInTheDocument();
  });

  it("renders orchestrator link when orchestrator exists", () => {
    render(
      <SpawnOrchestratorButton
        project={project}
        orchestrator={{ id: "orch-1", projectId: "my-app", projectName: "My App" }}
        onSpawnOrchestrator={vi.fn()}
        isSpawning={false}
      />,
    );

    const link = screen.getByRole("link", { name: "orchestrator" });
    expect(link).toHaveAttribute("href", "/sessions/orch-1");
  });

  it("shows spawning state", () => {
    render(
      <SpawnOrchestratorButton
        project={project}
        orchestrator={null}
        onSpawnOrchestrator={vi.fn()}
        isSpawning={true}
      />,
    );

    expect(screen.getByRole("button", { name: "Spawning..." })).toBeDisabled();
  });

  it("calls onSpawnOrchestrator when clicked", () => {
    const onSpawn = vi.fn().mockResolvedValue(undefined);

    render(
      <SpawnOrchestratorButton
        project={project}
        orchestrator={null}
        onSpawnOrchestrator={onSpawn}
        isSpawning={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Spawn Orchestrator" }));
    expect(onSpawn).toHaveBeenCalledWith(project);
  });

  it("displays error message when provided", () => {
    render(
      <SpawnOrchestratorButton
        project={project}
        orchestrator={null}
        onSpawnOrchestrator={vi.fn()}
        isSpawning={false}
        error="Project is paused"
      />,
    );

    expect(screen.getByText("Project is paused")).toBeInTheDocument();
  });

  it("renders compact variant with smaller classes", () => {
    render(
      <SpawnOrchestratorButton
        project={project}
        orchestrator={null}
        onSpawnOrchestrator={vi.fn()}
        isSpawning={false}
        variant="compact"
      />,
    );

    const button = screen.getByRole("button", { name: "Spawn Orchestrator" });
    expect(button.className).toContain("text-[11px]");
  });

  it("renders inline variant", () => {
    render(
      <SpawnOrchestratorButton
        project={project}
        orchestrator={null}
        onSpawnOrchestrator={vi.fn()}
        isSpawning={false}
        variant="inline"
      />,
    );

    const button = screen.getByRole("button", { name: "Spawn Orchestrator" });
    expect(button.className).toContain("text-[11px]");
  });

  it("renders sidebar variant with icon-only spawn button", () => {
    render(
      <SpawnOrchestratorButton
        project={project}
        orchestrator={null}
        onSpawnOrchestrator={vi.fn()}
        isSpawning={false}
        variant="sidebar"
      />,
    );

    const button = screen.getByRole("button", { name: `Spawn orchestrator for ${project.name}` });
    expect(button.className).toContain("group-hover:opacity-100");
  });

  it("renders sidebar variant with orchestrator dot link", () => {
    render(
      <SpawnOrchestratorButton
        project={project}
        orchestrator={{ id: "orch-1", projectId: "my-app", projectName: "My App" }}
        onSpawnOrchestrator={vi.fn()}
        isSpawning={false}
        variant="sidebar"
      />,
    );

    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/sessions/orch-1");
  });
});
