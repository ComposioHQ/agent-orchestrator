import { describe, expect, it } from "vitest";
import { makePR, makeSession } from "@/__tests__/helpers";
import { buildPixelWorldModel } from "../scene-model";

const projects = [
  { id: "alpha", name: "Alpha" },
  { id: "beta", name: "Beta" },
];

describe("buildPixelWorldModel", () => {
  it("keeps district geometry and session slots stable across ordinary refresh order changes", () => {
    const sessions = [
      makeSession({
        id: "alpha-working",
        projectId: "alpha",
        createdAt: "2026-03-14T10:00:00.000Z",
        summary: "Alpha worker",
      }),
      makeSession({
        id: "alpha-merge",
        projectId: "alpha",
        createdAt: "2026-03-14T10:01:00.000Z",
        summary: "Alpha merge",
        pr: makePR(),
      }),
      makeSession({
        id: "beta-pending",
        projectId: "beta",
        status: "review_pending",
        createdAt: "2026-03-14T10:02:00.000Z",
        summary: "Beta pending",
      }),
    ];

    const baseline = buildPixelWorldModel({
      allProjectsView: true,
      projects,
      sessions,
    });
    const refreshed = buildPixelWorldModel({
      allProjectsView: true,
      projects,
      sessions: [sessions[2], sessions[0], sessions[1]],
    });

    expect(refreshed.districts).toEqual(baseline.districts);
    expect(refreshed.entities).toEqual(baseline.entities);
  });

  it("reuses the same district schema in single-project mode", () => {
    const sessions = [
      makeSession({
        id: "alpha-working",
        projectId: "alpha",
        createdAt: "2026-03-14T10:00:00.000Z",
      }),
      makeSession({
        id: "alpha-done",
        projectId: "alpha",
        status: "done",
        activity: "exited",
        createdAt: "2026-03-14T10:03:00.000Z",
      }),
    ];

    const world = buildPixelWorldModel({
      allProjectsView: false,
      projectName: "Alpha",
      projects,
      sessions,
    });

    expect(world.districts).toHaveLength(1);
    expect(Object.keys(world.districts[0].neighborhoods).sort()).toEqual([
      "done",
      "merge",
      "pending",
      "respond",
      "review",
      "working",
    ]);
  });

  it("moves terminal sessions into the quieter archive neighborhood", () => {
    const archivedSession = makeSession({
      id: "alpha-done",
      projectId: "alpha",
      status: "done",
      activity: "exited",
      createdAt: "2026-03-14T10:03:00.000Z",
    });

    const world = buildPixelWorldModel({
      allProjectsView: false,
      projectName: "Alpha",
      projects,
      sessions: [archivedSession],
    });

    const entity = world.entities[0];
    const archive = world.districts[0].neighborhoods.done.bounds;

    expect(entity.isArchived).toBe(true);
    expect(entity.attentionLevel).toBe("done");
    expect(entity.position.x).toBeGreaterThanOrEqual(archive.x);
    expect(entity.position.x).toBeLessThanOrEqual(archive.x + archive.width);
    expect(entity.position.y).toBeGreaterThanOrEqual(archive.y);
    expect(entity.position.y).toBeLessThanOrEqual(archive.y + archive.height);
  });
});
