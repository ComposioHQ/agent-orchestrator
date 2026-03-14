import type { DashboardView } from "./types";

export type DashboardProjectParam = string | "all" | undefined;

export interface DashboardRouteState {
  project: DashboardProjectParam;
  view: DashboardView;
}

type SearchParamsLike =
  | URLSearchParams
  | { get(name: string): string | null }
  | Record<string, string | string[] | undefined>;

function getSearchParam(searchParams: SearchParamsLike, key: string): string | undefined {
  if ("get" in searchParams && typeof searchParams.get === "function") {
    return searchParams.get(key) ?? undefined;
  }

  const value = (searchParams as Record<string, string | string[] | undefined>)[key];
  return Array.isArray(value) ? value[0] : value;
}

export function parseDashboardView(value: string | null | undefined): DashboardView {
  return value === "pixel" ? "pixel" : "legacy";
}

export function parseDashboardRouteState(searchParams: SearchParamsLike): DashboardRouteState {
  const project = getSearchParam(searchParams, "project");

  return {
    project: project === "all" ? "all" : project,
    view: parseDashboardView(getSearchParam(searchParams, "view")),
  };
}

export function buildDashboardHref(pathname: string, state: DashboardRouteState): string {
  const params = new URLSearchParams();

  if (state.project) {
    params.set("project", state.project);
  }

  if (state.view !== "legacy") {
    params.set("view", state.view);
  }

  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function updateDashboardHref(
  pathname: string,
  searchParams: SearchParamsLike,
  updates: Partial<DashboardRouteState>,
): string {
  return buildDashboardHref(pathname, {
    ...parseDashboardRouteState(searchParams),
    ...updates,
  });
}
