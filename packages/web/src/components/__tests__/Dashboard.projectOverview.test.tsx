import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Dashboard } from "@/components/Dashboard";
import { makeSession } from "@/__tests__/helpers";

const mockPush = vi.fn();
const mockSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => mockSearchParams,
}));

describe("Dashboard project overview cards", () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockSearchParams.delete("project");
    mockSearchParams.delete("view");
    global.EventSource = vi.fn(
      () =>
        ({
          onmessage: null,
          onerror: null,
          close: vi.fn(),
        }) as unknown as EventSource,
    );
    global.fetch = vi.fn();
  });

  it("renders Spawn Orchestrator only for projects without one", () => {
    render(
      <Dashboard
        initialSessions={[makeSession({ projectId: "my-app" })]}
        projects={[
          { id: "my-app", name: "My App" },
          { id: "docs-app", name: "Docs App" },
        ]}
        orchestrators={[{ id: "my-app-orchestrator", projectId: "my-app", projectName: "My App" }]}
      />,
    );

    expect(screen.getAllByText("My App").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Docs App").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "orchestrator" })).toHaveAttribute(
      "href",
      "/sessions/my-app-orchestrator",
    );
    expect(screen.getByRole("button", { name: "Spawn Orchestrator" })).toBeInTheDocument();
    expect(screen.getAllByText("No running orchestrator")).toHaveLength(1);
  });

  it("remains stable when orchestrators prop is omitted", () => {
    render(
      <Dashboard
        initialSessions={[makeSession({ projectId: "my-app" })]}
        projects={[
          { id: "my-app", name: "My App" },
          { id: "docs-app", name: "Docs App" },
        ]}
      />,
    );

    expect(screen.getAllByRole("button", { name: "Spawn Orchestrator" })).toHaveLength(2);
  });

  it("updates the card after spawning an orchestrator", async () => {
    let resolveSpawn: ((value: Response) => void) | null = null;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveSpawn = resolve;
        }),
    );

    render(
      <Dashboard
        initialSessions={[makeSession({ projectId: "my-app" })]}
        projects={[
          { id: "my-app", name: "My App" },
          { id: "docs-app", name: "Docs App" },
        ]}
        orchestrators={[]}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Spawn Orchestrator" })[1]);

    expect(screen.getByRole("button", { name: "Spawning..." })).toBeDisabled();

    resolveSpawn?.({
      ok: true,
      json: async () => ({
        orchestrator: {
          id: "docs-orchestrator",
          projectId: "docs-app",
          projectName: "Docs App",
        },
      }),
    } as Response);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/api/orchestrators", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "docs-app" }),
      });
    });

    await waitFor(() => {
      const links = screen.getAllByRole("link", { name: "orchestrator" });
      expect(links).toHaveLength(1);
      expect(links[0]).toHaveAttribute("href", "/sessions/docs-orchestrator");
    });

    expect(screen.queryByText("Spawning...")).not.toBeInTheDocument();
    expect(screen.getAllByText("No running orchestrator")).toHaveLength(1);
  });

  it("shows the API error when spawning fails", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Project is paused" }),
    } as Response);

    render(
      <Dashboard
        initialSessions={[makeSession({ projectId: "my-app" })]}
        projects={[
          { id: "my-app", name: "My App" },
          { id: "docs-app", name: "Docs App" },
        ]}
        orchestrators={[]}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Spawn Orchestrator" })[1]);

    await waitFor(() => {
      expect(screen.getByText("Project is paused")).toBeInTheDocument();
    });
    expect(screen.getAllByRole("button", { name: "Spawn Orchestrator" })).toHaveLength(2);
  });

  it("shows the visible mode switcher and preserves project scope when switching views", () => {
    mockSearchParams.set("project", "docs-app");

    render(
      <Dashboard
        initialSessions={[makeSession({ projectId: "docs-app" })]}
        projectId="docs-app"
        projectName="Docs App"
        projects={[
          { id: "my-app", name: "My App" },
          { id: "docs-app", name: "Docs App" },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Pixel" }));

    expect(mockPush).toHaveBeenCalledWith("/?project=docs-app&view=pixel");
  });

  it("renders pixel districts in all-project mode", () => {
    render(
      <Dashboard
        initialSessions={[
          makeSession({ projectId: "my-app", summary: "Alpha worker" }),
          makeSession({ projectId: "docs-app", summary: "Docs worker" }),
        ]}
        projects={[
          { id: "my-app", name: "My App" },
          { id: "docs-app", name: "Docs App" },
        ]}
        view="pixel"
      />,
    );

    expect(screen.getByText("Project districts")).toBeInTheDocument();
    expect(screen.getAllByText("District")).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: "Enter" })).toHaveLength(2);
  });
});
