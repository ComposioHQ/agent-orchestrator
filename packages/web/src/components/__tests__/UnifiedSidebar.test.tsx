import type { AnchorHTMLAttributes, ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnifiedSidebar } from "../UnifiedSidebar";
import type { PortfolioProjectSummary } from "@/lib/types";

const router = {
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
};

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/",
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

describe("UnifiedSidebar workspace ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
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
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;
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
