import { describe, expect, it } from "vitest";
import {
  buildDashboardHref,
  parseDashboardRouteState,
  parseDashboardView,
  updateDashboardHref,
} from "@/lib/dashboard-route-state";

describe("dashboard-route-state", () => {
  it("defaults to legacy view when no query param is present", () => {
    expect(parseDashboardView(undefined)).toBe("legacy");
    expect(parseDashboardRouteState(new URLSearchParams())).toEqual({
      project: undefined,
      view: "legacy",
    });
  });

  it("parses explicit pixel view and all-project scope", () => {
    expect(parseDashboardRouteState(new URLSearchParams("project=all&view=pixel"))).toEqual({
      project: "all",
      view: "pixel",
    });
  });

  it("builds canonical urls without legacy view noise", () => {
    expect(buildDashboardHref("/", { project: "alpha", view: "legacy" })).toBe("/?project=alpha");
    expect(buildDashboardHref("/", { project: "alpha", view: "pixel" })).toBe(
      "/?project=alpha&view=pixel",
    );
  });

  it("preserves project while updating view", () => {
    const href = updateDashboardHref("/", new URLSearchParams("project=docs-app"), {
      view: "pixel",
    });
    expect(href).toBe("/?project=docs-app&view=pixel");
  });
});
