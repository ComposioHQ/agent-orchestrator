import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../Dashboard";
import { makeSession } from "../../__tests__/helpers";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({
    resolvedTheme: "dark",
    setTheme: vi.fn(),
  }),
}));

function mockViewport(isMobile: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: isMobile && query.includes("max-width: 767px"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

describe("Dashboard header orchestrator action", () => {
  beforeEach(() => {
    mockViewport(false);
    global.EventSource = Object.assign(
      vi.fn(() => ({
        onmessage: null,
        onerror: null,
        onopen: null,
        close: vi.fn(),
      })),
      {
        CONNECTING: 0,
        OPEN: 1,
        CLOSED: 2,
      },
    ) as unknown as typeof EventSource;
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({}),
        text: async () => "",
      } as Response),
    );
  });

  it("renders the current project orchestrator in the header and keeps it as the rightmost desktop action", async () => {
    render(
      <Dashboard
        initialSessions={[makeSession({ projectId: "my-app" })]}
        projectId="my-app"
        projectName="My App"
        projects={[
          { id: "my-app", name: "My App" },
          { id: "docs-app", name: "Docs App" },
        ]}
        orchestrators={[
          { id: "my-app-orchestrator", projectId: "my-app", projectName: "My App" },
          { id: "docs-app-orchestrator", projectId: "docs-app", projectName: "Docs App" },
        ]}
      />,
    );

    const headerActions = await screen.findByTestId("dashboard-header-actions");
    const orchestratorAction = screen.getByTestId("dashboard-header-orchestrator-action");

    expect(headerActions).toBeVisible();
    expect(orchestratorAction).toBeVisible();
    expect(orchestratorAction).toHaveAttribute("href", "/projects/my-app/sessions/my-app-orchestrator");
    expect(within(headerActions).getAllByRole("button", { name: "Switch to light mode" })).toHaveLength(1);
    expect(headerActions.lastElementChild).toBe(orchestratorAction);
  });

  it("keeps the header orchestrator visible and rightmost on mobile, even when the sidebar drawer opens", async () => {
    mockViewport(true);

    render(
      <Dashboard
        initialSessions={[makeSession({ projectId: "my-app" })]}
        projectId="my-app"
        projectName="My App"
        projects={[
          { id: "my-app", name: "My App" },
          { id: "docs-app", name: "Docs App" },
        ]}
        orchestrators={[{ id: "my-app-orchestrator", projectId: "my-app", projectName: "My App" }]}
      />,
    );

    const headerActions = await screen.findByTestId("dashboard-header-actions");
    const orchestratorAction = screen.getByTestId("dashboard-header-orchestrator-action");

    expect(headerActions).toBeVisible();
    expect(orchestratorAction).toBeVisible();
    expect(orchestratorAction).toHaveAttribute("href", "/projects/my-app/sessions/my-app-orchestrator");
    expect(within(headerActions).getAllByRole("button", { name: "Switch to light mode" })).toHaveLength(1);
    expect(headerActions.lastElementChild).toBe(orchestratorAction);

    fireEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }));

    expect(orchestratorAction).toBeVisible();
    expect(headerActions.lastElementChild).toBe(orchestratorAction);
  });

  it("keeps the multi-orchestrator header control as the rightmost action for single-project dashboards", async () => {
    render(
      <Dashboard
        initialSessions={[makeSession({ projectId: "my-app" })]}
        projectName="My App"
        orchestrators={[
          { id: "my-app-orchestrator", projectId: "my-app", projectName: "My App" },
          { id: "docs-app-orchestrator", projectId: "docs-app", projectName: "Docs App" },
        ]}
      />,
    );

    const headerActions = await screen.findByTestId("dashboard-header-actions");
    const orchestratorAction = screen.getByTestId("dashboard-header-orchestrator-action");
    const visibleLabel = within(orchestratorAction).getByText("2 orchestrators");

    expect(within(headerActions).getAllByRole("button", { name: "Switch to light mode" })).toHaveLength(1);
    expect(visibleLabel).toBeVisible();
    expect(headerActions.lastElementChild).toBe(orchestratorAction);
  });
});
