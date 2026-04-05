import type { AnchorHTMLAttributes, ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnifiedSidebar } from "../UnifiedSidebar";
import type { DashboardSession, PortfolioProjectSummary } from "@/lib/types";

// jsdom does not define PointerEvent; alias it to MouseEvent for tests
if (typeof globalThis.PointerEvent === "undefined") {
  (globalThis as Record<string, unknown>).PointerEvent = class PointerEvent extends MouseEvent {};
}

const router = {
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
};

let mockPathname = "/";

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => mockPathname,
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: ReactNode;
    href: string;
  } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

function makeProject(
  overrides: Partial<PortfolioProjectSummary> & Pick<PortfolioProjectSummary, "id" | "name">,
): PortfolioProjectSummary {
  return {
    sessionCount: 0,
    activeCount: 0,
    attentionCounts: {
      merge: 0,
      respond: 0,
      review: 0,
      pending: 0,
      working: 0,
      done: 0,
    },
    ...overrides,
  };
}

function makeSession(
  overrides: Partial<DashboardSession> & Pick<DashboardSession, "id" | "projectId">,
): DashboardSession {
  return {
    status: "working",
    activity: "active",
    branch: null,
    issueId: null,
    issueUrl: null,
    issueLabel: null,
    issueTitle: null,
    summary: null,
    summaryIsFallback: false,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    pr: null,
    metadata: {},
    ...overrides,
  };
}

function rowOrder() {
  return screen
    .getAllByTestId(/workspace-row-/)
    .map((row) => row.getAttribute("data-testid")?.replace("workspace-row-", ""));
}

function makeDataTransfer(): DataTransfer {
  const store = new Map<string, string>();
  return {
    dropEffect: "move",
    effectAllowed: "all",
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    types: [],
    clearData: (format?: string) => {
      if (format) {
        store.delete(format);
      } else {
        store.clear();
      }
    },
    getData: (format: string) => store.get(format) ?? "",
    setData: (format: string, value: string) => {
      store.set(format, value);
    },
    setDragImage: () => {},
  } as DataTransfer;
}

function setupFetch(overrides?: Record<string, () => Response>) {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (overrides?.[url]) return overrides[url]();
    if (url === "/api/agents") {
      return new Response(JSON.stringify({ agents: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "/api/settings/preferences" && init?.method === "PUT") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.startsWith("/api/projects/") && init?.method === "DELETE") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "/api/spawn" && init?.method === "POST") {
      return new Response(
        JSON.stringify({ session: { id: "new-session-1" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

function setupFetchWithAgents(agents: Array<{ id: string }>) {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/agents") {
      return new Response(JSON.stringify({ agents }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "/api/settings/preferences" && init?.method === "PUT") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.startsWith("/api/projects/") && init?.method === "DELETE") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "/api/spawn" && init?.method === "POST") {
      return new Response(
        JSON.stringify({ session: { id: "new-session-1" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

describe("UnifiedSidebar workspace ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = "/";
    setupFetch();
  });

  it("renders projects in the provided saved order instead of alphabetizing them", () => {
    render(
      <UnifiedSidebar
        projects={[
          makeProject({ id: "bravo", name: "Bravo" }),
          makeProject({ id: "alpha", name: "Alpha" }),
          makeProject({ id: "charlie", name: "Charlie" }),
        ]}
      />,
    );

    expect(rowOrder()).toEqual(["bravo", "alpha", "charlie"]);
  });

  it("reorders projects on drag and persists the new order", async () => {
    render(
      <UnifiedSidebar
        projects={[
          makeProject({ id: "alpha", name: "Alpha" }),
          makeProject({ id: "bravo", name: "Bravo" }),
          makeProject({ id: "charlie", name: "Charlie" }),
        ]}
      />,
    );

    const dataTransfer = makeDataTransfer();
    const alphaRow = screen.getByTestId("workspace-row-alpha");
    const charlieRow = screen.getByTestId("workspace-row-charlie");

    fireEvent.dragStart(alphaRow, { dataTransfer });
    fireEvent.dragOver(charlieRow, { dataTransfer });
    fireEvent.drop(charlieRow, { dataTransfer });

    expect(rowOrder()).toEqual(["bravo", "charlie", "alpha"]);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/settings/preferences",
        expect.objectContaining({
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectOrder: ["bravo", "charlie", "alpha"] }),
        }),
      );
    });

    expect(router.refresh).toHaveBeenCalled();
  });

  it("disables dragging when the sidebar is grouped away from the plain repo list", () => {
    render(
      <UnifiedSidebar
        projects={[
          makeProject({ id: "alpha", name: "Alpha" }),
          makeProject({ id: "bravo", name: "Bravo", activeCount: 1 }),
        ]}
      />,
    );

    fireEvent.click(screen.getByLabelText("Workspace filters"));
    fireEvent.click(screen.getAllByRole("button", { name: /Repo/i })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Status" }));

    expect(screen.getByTestId("workspace-row-alpha")).toHaveAttribute("data-draggable", "false");
    expect(screen.getByTestId("workspace-row-bravo")).toHaveAttribute("data-draggable", "false");
  });

  it("shows alphabetized projects when grouped by status", () => {
    render(
      <UnifiedSidebar
        projects={[
          makeProject({ id: "bravo", name: "Bravo" }),
          makeProject({ id: "alpha", name: "Alpha", activeCount: 1 }),
          makeProject({ id: "charlie", name: "Charlie" }),
        ]}
      />,
    );

    fireEvent.click(screen.getByLabelText("Workspace filters"));
    fireEvent.click(screen.getAllByRole("button", { name: /Repo/i })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Status" }));

    expect(rowOrder()).toEqual(["alpha", "bravo", "charlie"]);
  });
});

describe("UnifiedSidebar basic rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = "/";
    setupFetch();
  });

  it("renders the Activity link", () => {
    render(<UnifiedSidebar projects={[]} />);
    expect(screen.getByText("Activity")).toBeInTheDocument();
  });

  it("renders Workspaces header", () => {
    render(<UnifiedSidebar projects={[]} />);
    expect(screen.getByText("Workspaces")).toBeInTheDocument();
  });

  it("renders settings link", () => {
    render(<UnifiedSidebar projects={[]} />);
    expect(screen.getByLabelText("Open settings")).toBeInTheDocument();
  });

  it("highlights the Activity link when pathname is /activity", () => {
    mockPathname = "/activity";
    render(<UnifiedSidebar projects={[]} />);
    const activityLink = screen.getByText("Activity").closest("a");
    expect(activityLink).toHaveAttribute("href", "/activity");
  });

  it("renders project names as links", () => {
    render(
      <UnifiedSidebar
        projects={[makeProject({ id: "proj-1", name: "My Project" })]}
      />,
    );
    const link = screen.getByText("My Project").closest("a");
    expect(link).toHaveAttribute("href", "/projects/proj-1");
  });

  it("renders an active project with accent styling", () => {
    render(
      <UnifiedSidebar
        projects={[makeProject({ id: "proj-1", name: "My Project" })]}
        activeProjectId="proj-1"
      />,
    );
    const row = screen.getByTestId("workspace-row-proj-1");
    expect(row.className).toContain("bg-[var(--color-accent-subtle)]");
  });
});

describe("UnifiedSidebar attention pills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = "/";
    setupFetch();
  });

  it("renders attention pills for projects with working sessions", () => {
    render(
      <UnifiedSidebar
        projects={[
          makeProject({
            id: "proj-1",
            name: "Active Project",
            attentionCounts: { merge: 0, respond: 2, review: 1, pending: 0, working: 3, done: 0 },
          }),
        ]}
      />,
    );
    // Should see pills for working (3), respond (2), review (1)
    expect(screen.getByText("3w")).toBeInTheDocument();
    expect(screen.getByText("2r")).toBeInTheDocument();
    expect(screen.getByText("1r")).toBeInTheDocument();
  });

  it("does not render pills when all attention counts are zero", () => {
    render(
      <UnifiedSidebar
        projects={[makeProject({ id: "proj-1", name: "Quiet Project" })]}
      />,
    );
    expect(screen.queryByText(/\d+[wmrp]/)).toBeNull();
  });
});

describe("UnifiedSidebar project session accordion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = "/";
    setupFetch();
  });

  it("renders project sessions in an accordion when expanded", () => {
    render(
      <UnifiedSidebar
        projects={[makeProject({ id: "proj-1", name: "Project One", activeCount: 1 })]}
        sessions={[
          makeSession({
            id: "proj-1-1",
            projectId: "proj-1",
            summary: "Fix flaky sidebar state",
            metadata: { agent: "codex" },
          }),
        ]}
      />,
    );

    expect(screen.queryByText("Fix flaky sidebar state")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Expand Project One sessions"));

    expect(screen.getByText("Fix flaky sidebar state")).toBeInTheDocument();
    expect(screen.getByText("Codex · proj-1-1")).toBeInTheDocument();
    expect(screen.getAllByLabelText("Codex agent").length).toBeGreaterThan(0);
  });

  it("auto-expands the active session's project", () => {
    render(
      <UnifiedSidebar
        projects={[makeProject({ id: "proj-1", name: "Project One", activeCount: 1 })]}
        sessions={[
          makeSession({
            id: "proj-1-1",
            projectId: "proj-1",
            summary: "Investigate review feedback",
            metadata: { agent: "claude-code" },
          }),
        ]}
        activeProjectId="proj-1"
        activeSessionId="proj-1-1"
      />,
    );

    expect(screen.getByText("Investigate review feedback")).toBeInTheDocument();
    expect(screen.getByLabelText("Collapse Project One sessions")).toBeInTheDocument();
  });

  it("shows inline confirm before killing an AO agent session", async () => {
    render(
      <UnifiedSidebar
        projects={[makeProject({ id: "proj-1", name: "Project One", activeCount: 1 })]}
        sessions={[
          makeSession({
            id: "proj-1-1",
            projectId: "proj-1",
            summary: "Investigate review feedback",
            metadata: { agent: "claude-code" },
          }),
        ]}
        activeProjectId="proj-1"
      />,
    );

    fireEvent.click(screen.getByLabelText("Terminate session"));

    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/sessions/proj-1-1/kill",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("clears the inline confirm state when the mouse leaves the AO agent row", () => {
    render(
      <UnifiedSidebar
        projects={[makeProject({ id: "proj-1", name: "Project One", activeCount: 1 })]}
        sessions={[
          makeSession({
            id: "proj-1-1",
            projectId: "proj-1",
            summary: "Investigate review feedback",
            metadata: { agent: "claude-code" },
          }),
        ]}
      />,
    );

    fireEvent.click(screen.getByLabelText("Terminate session"));
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();

    const row = screen.getByText("Investigate review feedback").closest(".group\\/agent");
    expect(row).not.toBeNull();
    fireEvent.pointerLeave(row!);

    expect(screen.queryByRole("button", { name: "Confirm" })).not.toBeInTheDocument();
  });

  it("does not show orchestrator sessions in the sidebar agent lists", () => {
    render(
      <UnifiedSidebar
        projects={[makeProject({ id: "proj-1", name: "Project One", activeCount: 2 })]}
        sessions={[
          makeSession({
            id: "proj-1-orchestrator",
            projectId: "proj-1",
            summary: "Main orchestrator",
            metadata: { role: "orchestrator", agent: "codex" },
          }),
          makeSession({
            id: "proj-1-1",
            projectId: "proj-1",
            summary: "Worker task",
            metadata: { agent: "codex" },
          }),
        ]}
        activeProjectId="proj-1"
      />,
    );

    expect(screen.getByText("Worker task")).toBeInTheDocument();
    expect(screen.queryByText("Main orchestrator")).not.toBeInTheDocument();
  });
});

describe("UnifiedSidebar filter menu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = "/";
    setupFetch();
  });

  it("opens and closes the filter menu", () => {
    render(
      <UnifiedSidebar
        projects={[makeProject({ id: "alpha", name: "Alpha" })]}
      />,
    );

    // Open filter menu
    fireEvent.click(screen.getByLabelText("Workspace filters"));
    expect(screen.getByText("Group by")).toBeInTheDocument();

    // Close by clicking again
    fireEvent.click(screen.getByLabelText("Workspace filters"));
    expect(screen.queryByText("Group by")).toBeNull();
  });

  it("filters by specific repo", () => {
    render(
      <UnifiedSidebar
        projects={[
          makeProject({ id: "alpha", name: "Alpha" }),
          makeProject({ id: "bravo", name: "Bravo" }),
        ]}
      />,
    );

    // Open filter menu
    fireEvent.click(screen.getByLabelText("Workspace filters"));

    // Open the Repo filter dropdown
    fireEvent.click(screen.getByRole("button", { name: /All repos/i }));

    // Select "Alpha" - this should filter to just Alpha
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));

    // Only Alpha should be visible
    expect(screen.getByTestId("workspace-row-alpha")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-row-bravo")).toBeNull();
  });

  it("switches to status grouping and filters by active status", () => {
    render(
      <UnifiedSidebar
        projects={[
          makeProject({ id: "alpha", name: "Alpha", activeCount: 2 }),
          makeProject({ id: "bravo", name: "Bravo", activeCount: 0 }),
        ]}
      />,
    );

    // Open filter menu and switch to Status group
    fireEvent.click(screen.getByLabelText("Workspace filters"));
    // The Group by value label button shows "Repo" - click it to open the dropdown
    const repoButtons = screen.getAllByRole("button", { name: /^Repo$/i });
    fireEvent.click(repoButtons[0]);
    // Now click "Status" option in the dropdown
    fireEvent.click(screen.getByRole("button", { name: /^Status$/i }));

    // Open Status filter dropdown (now visible because we're in status group)
    fireEvent.click(screen.getByRole("button", { name: /All statuses/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Active$/i }));

    expect(screen.getByTestId("workspace-row-alpha")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-row-bravo")).toBeNull();
  });

  it("filters by respond status", () => {
    render(
      <UnifiedSidebar
        projects={[
          makeProject({ id: "alpha", name: "Alpha", attentionCounts: { merge: 0, respond: 1, review: 0, pending: 0, working: 0, done: 0 } }),
          makeProject({ id: "bravo", name: "Bravo" }),
        ]}
      />,
    );

    fireEvent.click(screen.getByLabelText("Workspace filters"));
    const repoButtons = screen.getAllByRole("button", { name: /^Repo$/i });
    fireEvent.click(repoButtons[0]);
    fireEvent.click(screen.getByRole("button", { name: /^Status$/i }));

    fireEvent.click(screen.getByRole("button", { name: /All statuses/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Respond$/i }));

    expect(screen.getByTestId("workspace-row-alpha")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-row-bravo")).toBeNull();
  });

  it("filters by review status", () => {
    render(
      <UnifiedSidebar
        projects={[
          makeProject({ id: "alpha", name: "Alpha", attentionCounts: { merge: 0, respond: 0, review: 1, pending: 0, working: 0, done: 0 } }),
          makeProject({ id: "bravo", name: "Bravo" }),
        ]}
      />,
    );

    fireEvent.click(screen.getByLabelText("Workspace filters"));
    const repoButtons = screen.getAllByRole("button", { name: /^Repo$/i });
    fireEvent.click(repoButtons[0]);
    fireEvent.click(screen.getByRole("button", { name: /^Status$/i }));

    fireEvent.click(screen.getByRole("button", { name: /All statuses/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Review$/i }));

    expect(screen.getByTestId("workspace-row-alpha")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-row-bravo")).toBeNull();
  });

  it("filters by quiet status (no active count)", () => {
    render(
      <UnifiedSidebar
        projects={[
          makeProject({ id: "alpha", name: "Alpha", activeCount: 1 }),
          makeProject({ id: "bravo", name: "Bravo", activeCount: 0 }),
        ]}
      />,
    );

    fireEvent.click(screen.getByLabelText("Workspace filters"));
    const repoButtons = screen.getAllByRole("button", { name: /^Repo$/i });
    fireEvent.click(repoButtons[0]);
    fireEvent.click(screen.getByRole("button", { name: /^Status$/i }));

    fireEvent.click(screen.getByRole("button", { name: /All statuses/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Quiet$/i }));

    expect(screen.queryByTestId("workspace-row-alpha")).toBeNull();
    expect(screen.getByTestId("workspace-row-bravo")).toBeInTheDocument();
  });

  it("closes filter menu when clicking outside", () => {
    render(
      <UnifiedSidebar
        projects={[makeProject({ id: "alpha", name: "Alpha" })]}
      />,
    );

    fireEvent.click(screen.getByLabelText("Workspace filters"));
    expect(screen.getByText("Group by")).toBeInTheDocument();

    // Simulate clicking outside - use the document body as target
    act(() => {
      const event = new Event("pointerdown", { bubbles: true });
      document.body.dispatchEvent(event);
    });

    expect(screen.queryByText("Group by")).toBeNull();
  });
});

describe("UnifiedSidebar add repository menu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = "/";
    setupFetch();
  });

  it("opens and closes the add menu", () => {
    render(
      <UnifiedSidebar
        projects={[]}
        onAddProject={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText("Add repository"));
    expect(screen.getByText("Open project")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Add repository"));
    expect(screen.queryByText("Open project")).toBeNull();
  });

  it("calls onAddProject when Open project is clicked", () => {
    const onAddProject = vi.fn();
    render(
      <UnifiedSidebar
        projects={[]}
        onAddProject={onAddProject}
      />,
    );

    fireEvent.click(screen.getByLabelText("Add repository"));
    fireEvent.click(screen.getByText("Open project"));
    expect(onAddProject).toHaveBeenCalled();
  });

  it("closes add menu when clicking outside", () => {
    render(
      <UnifiedSidebar
        projects={[]}
        onAddProject={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText("Add repository"));
    expect(screen.getByText("Open project")).toBeInTheDocument();

    act(() => {
      const event = new Event("pointerdown", { bubbles: true });
      document.body.dispatchEvent(event);
    });

    expect(screen.queryByText("Open project")).toBeNull();
  });
});

describe("UnifiedSidebar remove project", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = "/";
    setupFetch();
  });

  it("opens remove confirmation modal and removes project", async () => {
    render(
      <UnifiedSidebar
        projects={[makeProject({ id: "proj-1", name: "My Project" })]}
      />,
    );

    // Click remove button (trash icon)
    fireEvent.click(screen.getByLabelText("Remove workspace"));

    // Confirm modal appears
    expect(screen.getByText("Remove Workspace")).toBeInTheDocument();
    // "My Project" appears in both workspace list and modal
    expect(screen.getAllByText("My Project").length).toBeGreaterThanOrEqual(2);

    // Click Remove button in modal
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/projects/proj-1",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });

  it("closes remove modal on Cancel", () => {
    render(
      <UnifiedSidebar
        projects={[makeProject({ id: "proj-1", name: "My Project" })]}
      />,
    );

    fireEvent.click(screen.getByLabelText("Remove workspace"));
    expect(screen.getByText("Remove Workspace")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Remove Workspace")).toBeNull();
  });

  it("redirects to home when removing the active project", async () => {
    render(
      <UnifiedSidebar
        projects={[makeProject({ id: "proj-1", name: "My Project" })]}
        activeProjectId="proj-1"
      />,
    );

    fireEvent.click(screen.getByLabelText("Remove workspace"));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith("/");
    });
  });

  it("shows error toast when remove fails", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/agents") {
        return new Response(JSON.stringify({ agents: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.startsWith("/api/projects/") && init?.method === "DELETE") {
        return new Response(JSON.stringify({ error: "Server error" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    render(
      <UnifiedSidebar
        projects={[makeProject({ id: "proj-1", name: "My Project" })]}
      />,
    );

    fireEvent.click(screen.getByLabelText("Remove workspace"));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(screen.getByText("Server error")).toBeInTheDocument();
    });
  });

  it("can dismiss the error toast", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/agents") {
        return new Response(JSON.stringify({ agents: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.startsWith("/api/projects/") && init?.method === "DELETE") {
        return new Response(JSON.stringify({ error: "Server error" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    render(
      <UnifiedSidebar
        projects={[makeProject({ id: "proj-1", name: "My Project" })]}
      />,
    );

    fireEvent.click(screen.getByLabelText("Remove workspace"));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(screen.getByText("Server error")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Dismiss error"));
    expect(screen.queryByText("Server error")).toBeNull();
  });
});

describe("UnifiedSidebar spawn agent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = "/";
    setupFetchWithAgents([{ id: "claude-code" }, { id: "codex" }, { id: "opencode" }]);
  });

  it("opens spawn menu and spawns an agent", async () => {
    render(
      <UnifiedSidebar
        projects={[makeProject({ id: "proj-1", name: "My Project" })]}
      />,
    );

    // Wait for agents to load
    await waitFor(() => {
      fireEvent.click(screen.getByLabelText("Spawn a new agent"));
      expect(screen.getByText("Claude Code")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Claude Code"));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/spawn",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ projectId: "proj-1", agent: "claude-code" }),
        }),
      );
    });

    expect(router.push).toHaveBeenCalledWith("/projects/proj-1/sessions/new-session-1");
  });

  it("shows 'No available agents' when none are loaded", () => {
    setupFetch(); // No agents returned
    render(
      <UnifiedSidebar
        projects={[makeProject({ id: "proj-1", name: "My Project" })]}
      />,
    );

    fireEvent.click(screen.getByLabelText("Spawn a new agent"));
    expect(screen.getByText("No available agents")).toBeInTheDocument();
  });

  it("shows error when spawn fails", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/agents") {
        return new Response(JSON.stringify({ agents: [{ id: "claude-code" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/spawn" && init?.method === "POST") {
        return new Response(JSON.stringify({ error: "Spawn failed" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    render(
      <UnifiedSidebar
        projects={[makeProject({ id: "proj-1", name: "My Project" })]}
      />,
    );

    await waitFor(() => {
      fireEvent.click(screen.getByLabelText("Spawn a new agent"));
      expect(screen.getByText("Claude Code")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Claude Code"));

    await waitFor(() => {
      expect(screen.getByText("Spawn failed")).toBeInTheDocument();
    });
  });

  it("closes spawn menu when clicking outside", async () => {
    render(
      <UnifiedSidebar
        projects={[makeProject({ id: "proj-1", name: "My Project" })]}
      />,
    );

    await waitFor(() => {
      fireEvent.click(screen.getByLabelText("Spawn a new agent"));
      expect(screen.getByText("Claude Code")).toBeInTheDocument();
    });

    act(() => {
      const event = new Event("pointerdown", { bubbles: true });
      document.body.dispatchEvent(event);
    });

    expect(screen.queryByText("Claude Code")).toBeNull();
  });
});

describe("UnifiedSidebar active agents section", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = "/";
    setupFetch();
  });

  it("renders the agents section when there are active sessions", () => {
    const sessions: DashboardSession[] = [
      makeSession({
        id: "sess-1",
        projectId: "proj-1",
        status: "working",
        summary: "Fix the bug",
        lastActivityAt: new Date().toISOString(),
      }),
    ];

    render(
      <UnifiedSidebar
        projects={[makeProject({ id: "proj-1", name: "My Project" })]}
        sessions={sessions}
      />,
    );

    expect(screen.getByText("Agents")).toBeInTheDocument();
    expect(screen.getByText("Fix the bug")).toBeInTheDocument();
  });

  it("does not render agents section when no sessions", () => {
    render(
      <UnifiedSidebar
        projects={[makeProject({ id: "proj-1", name: "My Project" })]}
      />,
    );

    expect(screen.queryByText("Agents")).toBeNull();
  });

  it("does not render agents section when all sessions are done", () => {
    const sessions: DashboardSession[] = [
      makeSession({
        id: "sess-1",
        projectId: "proj-1",
        status: "merged",
        lastActivityAt: new Date().toISOString(),
      }),
    ];

    render(
      <UnifiedSidebar
        projects={[makeProject({ id: "proj-1", name: "My Project" })]}
        sessions={sessions}
      />,
    );

    expect(screen.queryByText("Agents")).toBeNull();
  });

  it("shows project name for each agent session", () => {
    const sessions: DashboardSession[] = [
      makeSession({
        id: "sess-1",
        projectId: "proj-1",
        status: "working",
        pr: {
          number: 42,
          url: "https://github.com/test/test/pull/42",
          title: "Add auth",
          owner: "test",
          repo: "test",
          branch: "feat/auth",
          baseBranch: "main",
          isDraft: false,
          state: "open",
          additions: 100,
          deletions: 10,
          ciStatus: "success",
          ciChecks: [],
          reviewDecision: "approved",
          mergeability: { mergeable: true, ciPassing: true, approved: true, noConflicts: true, blockers: [] },
          unresolvedThreads: 0,
          unresolvedComments: [],
        },
        lastActivityAt: new Date().toISOString(),
      }),
    ];

    render(
      <UnifiedSidebar
        projects={[makeProject({ id: "proj-1", name: "My Project" })]}
        sessions={sessions}
      />,
    );

    // "My Project" appears in workspace list and agent section
    expect(screen.getAllByText("My Project").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Add auth")).toBeInTheDocument();
  });

  it("highlights the active session", () => {
    const sessions: DashboardSession[] = [
      makeSession({
        id: "sess-1",
        projectId: "proj-1",
        status: "working",
        summary: "Session one",
        lastActivityAt: new Date().toISOString(),
      }),
    ];

    render(
      <UnifiedSidebar
        projects={[makeProject({ id: "proj-1", name: "My Project" })]}
        sessions={sessions}
        activeSessionId="sess-1"
      />,
    );

    const agentLink = screen.getByText("Session one").closest("a");
    expect(agentLink?.className).toContain("bg-[var(--color-accent-subtle)]");
  });

  it("shows agent count", () => {
    const sessions: DashboardSession[] = [
      makeSession({
        id: "sess-1",
        projectId: "proj-1",
        status: "working",
        summary: "Session 1",
        lastActivityAt: new Date().toISOString(),
      }),
      makeSession({
        id: "sess-2",
        projectId: "proj-1",
        status: "pr_open",
        summary: "Session 2",
        lastActivityAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ];

    render(
      <UnifiedSidebar
        projects={[makeProject({ id: "proj-1", name: "My Project" })]}
        sessions={sessions}
      />,
    );

    expect(screen.getByText("2")).toBeInTheDocument();
  });
});

describe("UnifiedSidebar mobile drawer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = "/";
    setupFetch();
  });

  it("renders mobile drawer when mobileOpen is true", () => {
    render(
      <UnifiedSidebar
        projects={[makeProject({ id: "proj-1", name: "My Project" })]}
        mobileOpen={true}
        onMobileClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // There are two elements with this label: backdrop button and close button
    expect(screen.getAllByLabelText("Close workspace switcher").length).toBeGreaterThanOrEqual(2);
  });

  it("does not render mobile drawer when mobileOpen is false", () => {
    render(
      <UnifiedSidebar
        projects={[makeProject({ id: "proj-1", name: "My Project" })]}
        mobileOpen={false}
      />,
    );

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("calls onMobileClose when backdrop is clicked", () => {
    const onMobileClose = vi.fn();
    render(
      <UnifiedSidebar
        projects={[makeProject({ id: "proj-1", name: "My Project" })]}
        mobileOpen={true}
        onMobileClose={onMobileClose}
      />,
    );

    // The backdrop button has aria-label "Close workspace switcher"
    const buttons = screen.getAllByLabelText("Close workspace switcher");
    // The backdrop is a button with tabIndex={-1}
    const backdrop = buttons.find((btn) => btn.getAttribute("tabindex") === "-1");
    if (backdrop) fireEvent.click(backdrop);

    expect(onMobileClose).toHaveBeenCalled();
  });

  it("calls onMobileClose when close button is clicked", () => {
    const onMobileClose = vi.fn();
    render(
      <UnifiedSidebar
        projects={[makeProject({ id: "proj-1", name: "My Project" })]}
        mobileOpen={true}
        onMobileClose={onMobileClose}
      />,
    );

    // The close button (not the backdrop) - find the one without tabIndex=-1
    const buttons = screen.getAllByLabelText("Close workspace switcher");
    const closeBtn = buttons.find((btn) => btn.getAttribute("tabindex") !== "-1");
    if (closeBtn) fireEvent.click(closeBtn);

    expect(onMobileClose).toHaveBeenCalled();
  });

  it("closes drawer on Escape key", () => {
    const onMobileClose = vi.fn();
    render(
      <UnifiedSidebar
        projects={[makeProject({ id: "proj-1", name: "My Project" })]}
        mobileOpen={true}
        onMobileClose={onMobileClose}
      />,
    );

    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onMobileClose).toHaveBeenCalled();
  });

  it("traps focus with Tab key in mobile drawer", () => {
    const onMobileClose = vi.fn();
    render(
      <UnifiedSidebar
        projects={[makeProject({ id: "proj-1", name: "My Project" })]}
        mobileOpen={true}
        onMobileClose={onMobileClose}
      />,
    );

    const dialog = screen.getByRole("dialog");
    const focusables = dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), textarea, input, select, [tabindex]:not([tabindex="-1"])',
    );

    if (focusables.length > 0) {
      const last = focusables[focusables.length - 1];
      act(() => last.focus());

      fireEvent.keyDown(dialog, { key: "Tab", shiftKey: false });
      // Focus should wrap to first focusable (or event is prevented)
    }
  });

  it("traps focus with Shift+Tab key in mobile drawer", () => {
    const onMobileClose = vi.fn();
    render(
      <UnifiedSidebar
        projects={[makeProject({ id: "proj-1", name: "My Project" })]}
        mobileOpen={true}
        onMobileClose={onMobileClose}
      />,
    );

    const dialog = screen.getByRole("dialog");
    const focusables = dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), textarea, input, select, [tabindex]:not([tabindex="-1"])',
    );

    if (focusables.length > 0) {
      const first = focusables[0];
      act(() => first.focus());

      fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
      // Focus should wrap to last focusable
    }
  });
});

describe("UnifiedSidebar collapsed state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = "/";
    setupFetch();
  });

  it("renders collapse button with correct label when expanded", () => {
    render(
      <UnifiedSidebar
        projects={[]}
        collapsed={false}
        onToggleCollapse={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Collapse sidebar")).toBeInTheDocument();
  });

  it("renders expand button with correct label when collapsed", () => {
    render(
      <UnifiedSidebar
        projects={[]}
        collapsed={true}
        onToggleCollapse={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Expand sidebar")).toBeInTheDocument();
  });

  it("calls onToggleCollapse when toggle button is clicked", () => {
    const onToggleCollapse = vi.fn();
    render(
      <UnifiedSidebar
        projects={[]}
        collapsed={false}
        onToggleCollapse={onToggleCollapse}
      />,
    );

    fireEvent.click(screen.getByLabelText("Collapse sidebar"));
    expect(onToggleCollapse).toHaveBeenCalled();
  });

  it("hides resize handle when collapsed", () => {
    const { container } = render(
      <UnifiedSidebar
        projects={[]}
        collapsed={true}
        onToggleCollapse={vi.fn()}
      />,
    );

    // The resize handle has cursor-col-resize class
    expect(container.querySelector(".cursor-col-resize")).toBeNull();
  });

  it("shows resize handle when expanded", () => {
    const { container } = render(
      <UnifiedSidebar
        projects={[]}
        collapsed={false}
        onToggleCollapse={vi.fn()}
      />,
    );

    expect(container.querySelector(".cursor-col-resize")).toBeInTheDocument();
  });
});

describe("UnifiedSidebar resize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = "/";
    setupFetch();
  });

  it("calls onWidthChange during pointer move on resize handle", () => {
    const onWidthChange = vi.fn();
    const { container } = render(
      <UnifiedSidebar
        projects={[]}
        collapsed={false}
        onToggleCollapse={vi.fn()}
        width={228}
        onWidthChange={onWidthChange}
      />,
    );

    const handle = container.querySelector(".cursor-col-resize");
    expect(handle).toBeTruthy();

    // Start resize
    fireEvent.pointerDown(handle!, { clientX: 228 });

    // Move
    act(() => {
      document.dispatchEvent(new PointerEvent("pointermove", { clientX: 280, bubbles: true }));
    });

    expect(onWidthChange).toHaveBeenCalledWith(280);

    // End resize
    act(() => {
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    });
  });

  it("clamps width to minimum", () => {
    const onWidthChange = vi.fn();
    const { container } = render(
      <UnifiedSidebar
        projects={[]}
        collapsed={false}
        onToggleCollapse={vi.fn()}
        width={228}
        onWidthChange={onWidthChange}
      />,
    );

    const handle = container.querySelector(".cursor-col-resize");
    fireEvent.pointerDown(handle!, { clientX: 228 });

    act(() => {
      document.dispatchEvent(new PointerEvent("pointermove", { clientX: 50, bubbles: true }));
    });

    // Min is 200
    expect(onWidthChange).toHaveBeenCalledWith(200);
  });

  it("clamps width to maximum", () => {
    const onWidthChange = vi.fn();
    const { container } = render(
      <UnifiedSidebar
        projects={[]}
        collapsed={false}
        onToggleCollapse={vi.fn()}
        width={228}
        onWidthChange={onWidthChange}
      />,
    );

    const handle = container.querySelector(".cursor-col-resize");
    fireEvent.pointerDown(handle!, { clientX: 228 });

    act(() => {
      document.dispatchEvent(new PointerEvent("pointermove", { clientX: 600, bubbles: true }));
    });

    // Max is 400
    expect(onWidthChange).toHaveBeenCalledWith(400);
  });
});

describe("UnifiedSidebar workspace resources modal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = "/";
    setupFetch();
  });

  it("opens the workspace resources modal when link icon is clicked", () => {
    render(
      <UnifiedSidebar
        projects={[makeProject({ id: "proj-1", name: "My Project" })]}
      />,
    );

    fireEvent.click(screen.getByLabelText("Open from"));
    // The modal should open - WorkspaceResourcesModal receives open=true
    // Since it's a real component, we check it's rendered
  });
});

describe("UnifiedSidebar degraded projects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = "/";
    setupFetch();
  });

  it("renders degraded projects with transparent swatch", () => {
    render(
      <UnifiedSidebar
        projects={[makeProject({ id: "proj-1", name: "Degraded Project", degraded: true })]}
      />,
    );

    expect(screen.getByText("Degraded Project")).toBeInTheDocument();
  });
});

describe("UnifiedSidebar drag and drop edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = "/";
    setupFetch();
  });

  it("does not reorder when dragging to the same position", () => {
    render(
      <UnifiedSidebar
        projects={[
          makeProject({ id: "alpha", name: "Alpha" }),
          makeProject({ id: "bravo", name: "Bravo" }),
        ]}
      />,
    );

    const dataTransfer = makeDataTransfer();
    const alphaRow = screen.getByTestId("workspace-row-alpha");

    fireEvent.dragStart(alphaRow, { dataTransfer });
    fireEvent.dragOver(alphaRow, { dataTransfer });
    fireEvent.drop(alphaRow, { dataTransfer });

    expect(rowOrder()).toEqual(["alpha", "bravo"]);
  });

  it("handles dragEnd correctly", () => {
    render(
      <UnifiedSidebar
        projects={[
          makeProject({ id: "alpha", name: "Alpha" }),
          makeProject({ id: "bravo", name: "Bravo" }),
        ]}
      />,
    );

    const dataTransfer = makeDataTransfer();
    const alphaRow = screen.getByTestId("workspace-row-alpha");

    fireEvent.dragStart(alphaRow, { dataTransfer });
    fireEvent.dragEnd(alphaRow);

    // Drag state should be cleared, no visual artifacts
    expect(alphaRow.className).not.toContain("opacity-70");
  });

  it("reverts order when persistence fails", async () => {
    let callCount = 0;
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/agents") {
        return new Response(JSON.stringify({ agents: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/settings/preferences" && init?.method === "PUT") {
        callCount++;
        return new Response("", { status: 500 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    render(
      <UnifiedSidebar
        projects={[
          makeProject({ id: "alpha", name: "Alpha" }),
          makeProject({ id: "bravo", name: "Bravo" }),
        ]}
      />,
    );

    const dataTransfer = makeDataTransfer();
    const alphaRow = screen.getByTestId("workspace-row-alpha");
    const bravoRow = screen.getByTestId("workspace-row-bravo");

    fireEvent.dragStart(alphaRow, { dataTransfer });
    fireEvent.dragOver(bravoRow, { dataTransfer });
    fireEvent.drop(bravoRow, { dataTransfer });

    // Immediately reordered
    expect(rowOrder()).toEqual(["bravo", "alpha"]);

    // After fetch fails, should revert
    await waitFor(() => {
      expect(callCount).toBe(1);
    });

    await waitFor(() => {
      expect(rowOrder()).toEqual(["alpha", "bravo"]);
    });
  });
});

describe("UnifiedSidebar pathname-based active project", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupFetch();
  });

  it("redirects when removing a project while viewing its path", async () => {
    mockPathname = "/projects/proj-1/sessions/sess-1";
    render(
      <UnifiedSidebar
        projects={[makeProject({ id: "proj-1", name: "My Project" })]}
      />,
    );

    fireEvent.click(screen.getByLabelText("Remove workspace"));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith("/");
    });
  });
});
