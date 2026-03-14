import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makePR, makeSession } from "@/__tests__/helpers";
import { PixelDashboardView } from "../PixelDashboardView";

describe("PixelDashboardView", () => {
  it("renders the world scene with district and session labels", () => {
    render(
      <PixelDashboardView
        allProjectsView={true}
        onSpawnOrchestrator={vi.fn().mockResolvedValue(undefined)}
        onSelectSession={vi.fn()}
        openPRs={[]}
        projectOverviews={[
          {
            project: { id: "alpha", name: "Alpha" },
            orchestrator: null,
            sessionCount: 2,
            openPRCount: 1,
            counts: {
              merge: 1,
              respond: 0,
              review: 0,
              pending: 0,
              working: 1,
              done: 0,
            },
          },
        ]}
        projects={[{ id: "alpha", name: "Alpha" }]}
        selectedSessionId={null}
        sessions={[
          makeSession({
            id: "alpha-merge",
            projectId: "alpha",
            summary: "Merge train",
            issueLabel: "INT-101",
            pr: makePR(),
          }),
          makeSession({
            id: "alpha-working",
            projectId: "alpha",
            summary: "Working lane",
            issueLabel: "INT-102",
          }),
        ]}
        sessionsByProject={
          new Map([
            [
              "alpha",
              [
                makeSession({
                  id: "alpha-merge",
                  projectId: "alpha",
                  summary: "Merge train",
                  issueLabel: "INT-101",
                  pr: makePR(),
                }),
                makeSession({
                  id: "alpha-working",
                  projectId: "alpha",
                  summary: "Working lane",
                  issueLabel: "INT-102",
                }),
              ],
            ],
          ])
        }
        spawnErrors={{}}
        spawningProjectIds={[]}
      />,
    );

    expect(screen.getByTestId("pixel-world-scene")).toBeInTheDocument();
    expect(screen.getAllByText("Alpha")).toHaveLength(2);
    expect(screen.getByText("INT-101")).toBeInTheDocument();
    expect(screen.getByText("INT-102")).toBeInTheDocument();
  });

  it("encodes urgency cues and archives done sessions in the scene", () => {
    render(
      <PixelDashboardView
        allProjectsView={false}
        onSpawnOrchestrator={vi.fn().mockResolvedValue(undefined)}
        onSelectSession={vi.fn()}
        openPRs={[]}
        projectName="Alpha"
        projectOverviews={[]}
        projects={[{ id: "alpha", name: "Alpha" }]}
        selectedSessionId={null}
        sessions={[
          makeSession({
            id: "merge-agent",
            projectId: "alpha",
            issueLabel: "INT-201",
            pr: makePR(),
          }),
          makeSession({
            id: "done-agent",
            projectId: "alpha",
            issueLabel: "INT-202",
            status: "done",
            activity: "exited",
          }),
        ]}
        sessionsByProject={
          new Map([
            [
              "alpha",
              [
                makeSession({
                  id: "merge-agent",
                  projectId: "alpha",
                  issueLabel: "INT-201",
                  pr: makePR(),
                }),
                makeSession({
                  id: "done-agent",
                  projectId: "alpha",
                  issueLabel: "INT-202",
                  status: "done",
                  activity: "exited",
                }),
              ],
            ],
          ])
        }
        spawnErrors={{}}
        spawningProjectIds={[]}
      />,
    );

    const mergeSprite = screen.getByTestId("session-sprite-merge-agent");
    const doneSprite = screen.getByTestId("session-sprite-done-agent");
    const district = screen.getByTestId("pixel-district-alpha");
    const archive = screen.getByTestId("pixel-neighborhood-alpha-done");

    expect(mergeSprite).toHaveAttribute("data-attention-level", "merge");
    expect(doneSprite).toHaveAttribute("data-attention-level", "done");
    expect(doneSprite).toHaveAttribute("data-archived", "true");
    expect(mergeSprite).toHaveAttribute("aria-label", expect.stringContaining("merge session"));
    expect(archive).toHaveAttribute("data-attention-level", "done");
    expect(within(district).getByText("Archive grove")).toBeInTheDocument();
    expect(within(district).getByText("archive")).toBeInTheDocument();
    expect(screen.getByText("Archived")).toBeInTheDocument();
    expect(archive).toBeInTheDocument();
  });

  it("pins the clicked session and keeps the selected state on the sprite", () => {
    const onSelectSession = vi.fn();

    render(
      <PixelDashboardView
        allProjectsView={false}
        onSpawnOrchestrator={vi.fn().mockResolvedValue(undefined)}
        onSelectSession={onSelectSession}
        openPRs={[]}
        projectName="Alpha"
        projectOverviews={[]}
        projects={[{ id: "alpha", name: "Alpha" }]}
        selectedSessionId="alpha-merge"
        sessions={[
          makeSession({
            id: "alpha-merge",
            projectId: "alpha",
            summary: "Merge train",
            issueLabel: "INT-101",
            pr: makePR(),
          }),
        ]}
        sessionsByProject={
          new Map([
            [
              "alpha",
              [
                makeSession({
                  id: "alpha-merge",
                  projectId: "alpha",
                  summary: "Merge train",
                  issueLabel: "INT-101",
                  pr: makePR(),
                }),
              ],
            ],
          ])
        }
        spawnErrors={{}}
        spawningProjectIds={[]}
      />,
    );

    const sprite = screen.getByTestId("session-sprite-alpha-merge");
    fireEvent.click(sprite);

    expect(onSelectSession).toHaveBeenCalledWith("alpha-merge");
    expect(sprite).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Selected: INT-101")).toBeInTheDocument();
  });

  it("renders a persistent drawer with selected-session details and clears selection from the drawer", () => {
    const onSelectSession = vi.fn();

    render(
      <PixelDashboardView
        allProjectsView={false}
        onSpawnOrchestrator={vi.fn().mockResolvedValue(undefined)}
        onSelectSession={onSelectSession}
        openPRs={[]}
        projectName="Alpha"
        projectOverviews={[]}
        projects={[{ id: "alpha", name: "Alpha" }]}
        selectedSessionId="alpha-merge"
        sessions={[
          makeSession({
            id: "alpha-merge",
            projectId: "alpha",
            summary: "Merge train",
            issueLabel: "INT-101",
            pr: makePR(),
          }),
        ]}
        sessionsByProject={new Map([["alpha", [makeSession({ id: "alpha-merge", projectId: "alpha", summary: "Merge train", issueLabel: "INT-101", pr: makePR() })]]])}
        spawnErrors={{}}
        spawningProjectIds={[]}
      />,
    );

    const drawer = screen.getByTestId("pixel-session-drawer");
    expect(drawer).toBeInTheDocument();
    expect(within(drawer).getByText("Merge train")).toBeInTheDocument();
    expect(within(drawer).getByRole("link", { name: "Open full session" })).toHaveAttribute(
      "href",
      "/sessions/alpha-merge",
    );

    fireEvent.click(within(drawer).getByRole("button", { name: "Clear" }));
    expect(onSelectSession).toHaveBeenCalledWith(null);
  });

  it("adds project context and a project-scoped pixel link in all-project mode", () => {
    render(
      <PixelDashboardView
        allProjectsView={true}
        onSpawnOrchestrator={vi.fn().mockResolvedValue(undefined)}
        onSelectSession={vi.fn()}
        openPRs={[]}
        projectOverviews={[
          {
            project: { id: "alpha", name: "Alpha" },
            orchestrator: { id: "orch-1", projectId: "alpha", projectName: "Alpha" },
            sessionCount: 2,
            openPRCount: 1,
            counts: {
              merge: 1,
              respond: 0,
              review: 0,
              pending: 0,
              working: 1,
              done: 0,
            },
          },
        ]}
        projects={[{ id: "alpha", name: "Alpha" }]}
        selectedSessionId="alpha-merge"
        sessions={[
          makeSession({
            id: "alpha-merge",
            projectId: "alpha",
            summary: "Merge train",
            issueLabel: "INT-101",
            pr: makePR(),
          }),
        ]}
        sessionsByProject={new Map([["alpha", [makeSession({ id: "alpha-merge", projectId: "alpha", summary: "Merge train", issueLabel: "INT-101", pr: makePR() })]]])}
        spawnErrors={{}}
        spawningProjectIds={[]}
      />,
    );

    const drawer = screen.getByTestId("pixel-session-drawer");
    expect(within(drawer).getByText("Project context")).toBeInTheDocument();
    expect(within(drawer).getByRole("link", { name: "Open district" })).toHaveAttribute(
      "href",
      "/?project=alpha&view=pixel",
    );
    expect(within(drawer).getByText("District orchestrator online")).toBeInTheDocument();
  });
});
