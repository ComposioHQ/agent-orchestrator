import type { ComponentProps } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makePR, makeSession } from "@/__tests__/helpers";
import { PixelDashboardView } from "../PixelDashboardView";

function renderPixelDashboard(
  overrides: Partial<ComponentProps<typeof PixelDashboardView>> = {},
) {
  return render(
    <PixelDashboardView
      allProjectsView={false}
      onKill={vi.fn().mockResolvedValue(undefined)}
      onMerge={vi.fn().mockResolvedValue(undefined)}
      onRestore={vi.fn().mockResolvedValue(undefined)}
      onSend={vi.fn().mockResolvedValue(undefined)}
      onSpawnOrchestrator={vi.fn().mockResolvedValue(undefined)}
      onSelectSession={vi.fn()}
      openPRs={[]}
      projectName="Alpha"
      projectOverviews={[]}
      projects={[{ id: "alpha", name: "Alpha" }]}
      selectedSessionId={null}
      sessions={[]}
      sessionsByProject={new Map()}
      spawnErrors={{}}
      spawningProjectIds={[]}
      {...overrides}
    />,
  );
}

describe("PixelDashboardView", () => {
  it("renders the world scene with district and session labels", () => {
    renderPixelDashboard({
      allProjectsView: true,
      sessions: [
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
      projectOverviews: [
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
      ],
      sessionsByProject: new Map([
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
      ]),
    });

    expect(screen.getByTestId("pixel-world-scene")).toBeInTheDocument();
    expect(screen.getAllByText("Alpha")).toHaveLength(2);
    expect(screen.getByText("INT-101")).toBeInTheDocument();
    expect(screen.getByText("INT-102")).toBeInTheDocument();
  });

  it("encodes urgency cues and archives done sessions in the scene", () => {
    renderPixelDashboard({
      sessions: [
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
      sessionsByProject: new Map([
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
      ]),
    });

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
  });

  it("pins the clicked session and keeps the selected state on the sprite", () => {
    const onSelectSession = vi.fn();

    renderPixelDashboard({
      onSelectSession,
      selectedSessionId: "alpha-merge",
      sessions: [
        makeSession({
          id: "alpha-merge",
          projectId: "alpha",
          summary: "Merge train",
          issueLabel: "INT-101",
          pr: makePR(),
        }),
      ],
      sessionsByProject: new Map([
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
      ]),
    });

    const sprite = screen.getByTestId("session-sprite-alpha-merge");
    fireEvent.click(sprite);

    expect(onSelectSession).toHaveBeenCalledWith("alpha-merge");
    expect(sprite).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Selected: INT-101")).toBeInTheDocument();
  });

  it("renders a persistent drawer with selected-session details and clears selection from the drawer", () => {
    const onSelectSession = vi.fn();
    const session = makeSession({
      id: "alpha-merge",
      projectId: "alpha",
      summary: "Merge train",
      issueLabel: "INT-101",
      pr: makePR(),
    });

    renderPixelDashboard({
      onSelectSession,
      selectedSessionId: session.id,
      sessions: [session],
      sessionsByProject: new Map([["alpha", [session]]]),
    });

    const drawer = screen.getByTestId("pixel-session-drawer");
    expect(within(drawer).getByText("Merge train")).toBeInTheDocument();
    expect(within(drawer).getByRole("link", { name: "Open full session" })).toHaveAttribute(
      "href",
      "/sessions/alpha-merge",
    );

    fireEvent.click(within(drawer).getByRole("button", { name: "Clear" }));
    expect(onSelectSession).toHaveBeenCalledWith(null);
  });

  it("adds project context and a project-scoped pixel link in all-project mode", () => {
    const session = makeSession({
      id: "alpha-merge",
      projectId: "alpha",
      summary: "Merge train",
      issueLabel: "INT-101",
      pr: makePR(),
    });

    renderPixelDashboard({
      allProjectsView: true,
      selectedSessionId: session.id,
      sessions: [session],
      sessionsByProject: new Map([["alpha", [session]]]),
      projectOverviews: [
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
      ],
    });

    expect(screen.getByText("Project context")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open district" })).toHaveAttribute(
      "href",
      "/?project=alpha&view=pixel",
    );
  });

  it("requires a chosen-or-entered message before send and reuses quick prompts", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const session = makeSession({
      id: "alpha-review",
      activity: "idle",
      pr: makePR({
        state: "open",
        ciStatus: "failing",
        ciChecks: [{ name: "build", status: "failed" }],
        mergeability: {
          mergeable: false,
          ciPassing: false,
          approved: true,
          noConflicts: true,
          blockers: ["CI checks failing"],
        },
      }),
    });

    renderPixelDashboard({
      onSend,
      selectedSessionId: session.id,
      sessions: [session],
      sessionsByProject: new Map([["alpha", [session]]]),
    });

    const drawer = screen.getByTestId("pixel-session-drawer");
    const sendButton = within(drawer).getByRole("button", { name: "Send" });
    expect(sendButton).toBeDisabled();

    fireEvent.click(within(drawer).getByRole("button", { name: /ask to fix: 1 ci check failing/i }));
    expect(sendButton).toBeEnabled();

    fireEvent.click(sendButton);

    expect(onSend).toHaveBeenCalledWith(
      session.id,
      `Please fix the failing CI checks on ${session.pr!.url}`,
    );
    expect(await within(drawer).findByRole("status")).toHaveTextContent(
      `Message sent to ${session.id}`,
    );
  });

  it("requires confirmation for merge and shows success feedback", async () => {
    const onMerge = vi.fn().mockResolvedValue(undefined);
    const session = makeSession({
      id: "alpha-merge",
      status: "mergeable",
      activity: "idle",
      pr: makePR({ number: 42 }),
    });

    renderPixelDashboard({
      onMerge,
      selectedSessionId: session.id,
      sessions: [session],
      sessionsByProject: new Map([["alpha", [session]]]),
    });

    const drawer = screen.getByTestId("pixel-session-drawer");
    fireEvent.click(within(drawer).getByRole("button", { name: "Merge" }));
    expect(onMerge).not.toHaveBeenCalled();
    expect(within(drawer).getByText("Confirm merge for the selected PR.")).toBeInTheDocument();

    fireEvent.click(within(drawer).getByRole("button", { name: "Confirm merge" }));
    expect(onMerge).toHaveBeenCalledWith(42);
    expect(await within(drawer).findByRole("status")).toHaveTextContent("PR #42 merged");
  });

  it("keeps merge disabled when PR enrichment is rate-limited", () => {
    const session = makeSession({
      id: "alpha-rate-limited",
      status: "mergeable",
      activity: "idle",
      pr: makePR({
        number: 42,
        mergeability: {
          mergeable: true,
          ciPassing: true,
          approved: true,
          noConflicts: true,
          blockers: ["API rate limited or unavailable"],
        },
      }),
    });

    renderPixelDashboard({
      selectedSessionId: session.id,
      sessions: [session],
      sessionsByProject: new Map([["alpha", [session]]]),
    });

    const drawer = screen.getByTestId("pixel-session-drawer");
    expect(within(drawer).getByRole("button", { name: "Merge" })).toBeDisabled();
    expect(
      within(drawer).getByText(/PR enrichment is rate-limited, so merge stays disabled/i),
    ).toBeInTheDocument();
  });
});
