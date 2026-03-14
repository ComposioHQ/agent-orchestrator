import { describe, expect, it } from "vitest";
import { makePR, makeSession } from "@/__tests__/helpers";
import {
  reconcileSelectedSessionId,
  resolveSelectedSceneEntity,
} from "../selection";
import { buildPixelWorldModel } from "../scene-model";

const projects = [{ id: "alpha", name: "Alpha" }];

describe("selection helpers", () => {
  it("preserves selection by session id across refreshes that replace objects", () => {
    const selectedId = "alpha-merge";
    const initialSessions = [
      makeSession({
        id: selectedId,
        projectId: "alpha",
        issueLabel: "INT-201",
        pr: makePR(),
      }),
    ];
    const refreshedSessions = [
      makeSession({
        id: selectedId,
        projectId: "alpha",
        issueLabel: "INT-201",
        pr: makePR({ number: 201 }),
        summary: "Refreshed object",
      }),
    ];

    expect(reconcileSelectedSessionId(selectedId, refreshedSessions)).toBe(selectedId);

    const world = buildPixelWorldModel({
      allProjectsView: false,
      projectName: "Alpha",
      projects,
      sessions: refreshedSessions,
    });
    const resolved = resolveSelectedSceneEntity(selectedId, refreshedSessions, world.entities);

    expect(resolved.session).toMatchObject({ id: selectedId, summary: "Refreshed object" });
    expect(resolved.entity?.sessionId).toBe(selectedId);
  });

  it("clears selection when the selected session leaves the membership set", () => {
    const sessions = [makeSession({ id: "alpha-working", projectId: "alpha" })];

    expect(reconcileSelectedSessionId("missing-session", sessions)).toBeNull();
    expect(resolveSelectedSceneEntity("missing-session", sessions, [])).toEqual({
      entity: null,
      session: null,
    });
  });
});
