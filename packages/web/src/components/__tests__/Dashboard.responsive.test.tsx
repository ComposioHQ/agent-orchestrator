import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Dashboard } from "@/components/Dashboard";
import { makeSession } from "@/__tests__/helpers";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
}));

function mockMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe("Dashboard responsive behavior", () => {
  beforeEach(() => {
    global.EventSource = vi.fn(
      () =>
        ({
          onmessage: null,
          onerror: null,
          close: vi.fn(),
        }) as unknown as EventSource,
    );
    global.fetch = vi.fn();
    localStorage.clear();
  });

  it("renders correctly on mobile viewport", () => {
    mockMatchMedia(true); // matches (max-width: 767px)

    render(
      <Dashboard
        initialSessions={[makeSession()]}
        projectId="my-app"
        projectName="My App"
        projects={[{ id: "my-app", name: "My App" }]}
      />,
    );

    expect(screen.getByText("My App")).toBeInTheDocument();
  });

  it("auto-collapses sidebar on mobile", () => {
    mockMatchMedia(true); // mobile viewport

    render(
      <Dashboard
        initialSessions={[makeSession()]}
        projectId="my-app"
        projectName="My App"
        projects={[
          { id: "my-app", name: "My App" },
          { id: "docs-app", name: "Docs App" },
        ]}
      />,
    );

    // On mobile the sidebar should be collapsed, so the expand button is visible
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
    // The collapse button should not be present when sidebar is collapsed
    expect(screen.queryByRole("button", { name: "Collapse sidebar" })).not.toBeInTheDocument();
  });

  it("shows expanded sidebar on desktop viewport", () => {
    mockMatchMedia(false); // desktop viewport

    render(
      <Dashboard
        initialSessions={[makeSession()]}
        projectId="my-app"
        projectName="My App"
        projects={[
          { id: "my-app", name: "My App" },
          { id: "docs-app", name: "Docs App" },
        ]}
      />,
    );

    // On desktop the sidebar should be expanded, so the collapse button is visible
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeInTheDocument();
  });
});
