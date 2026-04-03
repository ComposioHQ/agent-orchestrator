import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { WorkspaceResourcesModal } from "@/components/WorkspaceResourcesModal";

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn(), refresh: vi.fn() }),
}));

// ---------- helpers ----------

function fetchJsonOk(data: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
}

function fetchJsonFail(status: number, data: unknown) {
  return Promise.resolve({ ok: false, status, json: () => Promise.resolve(data) });
}

const PROJECT = { id: "proj-1", name: "My Project", repo: "org/repo" };

function makeResourcesResponse(overrides?: Record<string, unknown>) {
  return {
    pullRequests: [
      { id: "pr-1", number: 42, title: "Fix auth", author: "alice", branch: "fix-auth", url: "https://gh/pr/42" },
      { id: "pr-2", number: 99, title: "Add tests", author: "bob", branch: "add-tests", url: "https://gh/pr/99" },
    ],
    branches: [
      { id: "b-1", name: "main", author: "system" },
      { id: "b-2", name: "feature-x", author: "carol" },
    ],
    issues: [
      { id: "ISS-1", title: "Bug report", url: "https://gh/issues/1", state: "open", assignee: "dave" },
    ],
    ...overrides,
  };
}

function renderModal(props?: Partial<React.ComponentProps<typeof WorkspaceResourcesModal>>) {
  const onClose = vi.fn();
  const utils = render(
    <WorkspaceResourcesModal
      open
      onClose={onClose}
      project={PROJECT}
      {...props}
    />,
  );
  return { onClose, ...utils };
}

// ---------- setup ----------

beforeEach(() => {
  vi.restoreAllMocks();
  mockPush.mockClear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  (global.fetch as Mock) = vi.fn().mockImplementation((url: string) => {
    if (typeof url === "string" && url.includes("/resources")) {
      return fetchJsonOk(makeResourcesResponse());
    }
    return fetchJsonFail(404, { error: "not found" });
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------- tests ----------

describe("WorkspaceResourcesModal", () => {
  describe("rendering", () => {
    it("renders modal with project name in title", async () => {
      renderModal();
      await vi.advanceTimersByTimeAsync(200);

      expect(screen.getByText("Link work in My Project")).toBeInTheDocument();
    });

    it("renders fallback title when project is null", () => {
      renderModal({ project: null });
      expect(screen.getByText("Link work")).toBeInTheDocument();
    });

    it("does not render when closed", () => {
      render(
        <WorkspaceResourcesModal open={false} onClose={vi.fn()} project={PROJECT} />,
      );
      expect(screen.queryByText("Link work in My Project")).not.toBeInTheDocument();
    });

    it("shows loading state", async () => {
      // Make fetch hang so loading persists
      (global.fetch as Mock) = vi.fn().mockReturnValue(new Promise(() => {}));
      renderModal();
      // The component uses a 180ms setTimeout before fetching
      await vi.advanceTimersByTimeAsync(200);

      await waitFor(() => {
        expect(screen.getByText("Loading resources...")).toBeInTheDocument();
      });
    });

    it("shows pull requests after loading", async () => {
      renderModal();
      await vi.advanceTimersByTimeAsync(200);

      await waitFor(() => {
        expect(screen.getByText(/#42 Fix auth/)).toBeInTheDocument();
      });
      expect(screen.getByText(/#99 Add tests/)).toBeInTheDocument();
    });

    it("shows empty state when no resources", async () => {
      (global.fetch as Mock) = vi.fn().mockImplementation(() =>
        fetchJsonOk({ pullRequests: [], branches: [], issues: [] }),
      );
      renderModal();
      await vi.advanceTimersByTimeAsync(200);

      await waitFor(() => {
        expect(screen.getByText("No matching resources.")).toBeInTheDocument();
      });
    });

    it("shows error state", async () => {
      (global.fetch as Mock) = vi.fn().mockImplementation(() =>
        fetchJsonFail(500, { error: "Server error" }),
      );
      renderModal();
      await vi.advanceTimersByTimeAsync(200);

      await waitFor(() => {
        expect(screen.getByText("Server error")).toBeInTheDocument();
      });
    });

    it("shows repo name in footer and tab area", async () => {
      renderModal();
      await vi.advanceTimersByTimeAsync(200);

      // repo appears in both the footer and the tab area header
      await waitFor(() => {
        expect(screen.getAllByText("org/repo").length).toBeGreaterThanOrEqual(1);
      });
    });

    it("shows fallback text when project has no repo", async () => {
      renderModal({ project: { id: "p1", name: "NoRepo" } });
      await vi.advanceTimersByTimeAsync(200);

      expect(screen.getByText("NoRepo")).toBeInTheDocument();
    });
  });

  describe("tab switching", () => {
    it("switches to Branches tab", async () => {
      renderModal();
      await vi.advanceTimersByTimeAsync(200);

      await waitFor(() => {
        expect(screen.getByText(/#42 Fix auth/)).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Branches" }));

      await waitFor(() => {
        expect(screen.getByText("main")).toBeInTheDocument();
        expect(screen.getByText("feature-x")).toBeInTheDocument();
      });
    });

    it("switches to Issues tab", async () => {
      renderModal();
      await vi.advanceTimersByTimeAsync(200);

      await waitFor(() => {
        expect(screen.getByText(/#42 Fix auth/)).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Issues" }));

      await waitFor(() => {
        expect(screen.getByText(/ISS-1 Bug report/)).toBeInTheDocument();
      });
    });

    it("highlights active tab", async () => {
      renderModal();
      await vi.advanceTimersByTimeAsync(200);

      await waitFor(() => {
        expect(screen.getByText(/#42 Fix auth/)).toBeInTheDocument();
      });

      const prTab = screen.getByRole("button", { name: "Pull requests" });
      const branchTab = screen.getByRole("button", { name: "Branches" });

      // PR tab is active by default
      expect(prTab.className).toContain("font-medium");
      expect(branchTab.className).not.toContain("font-medium");

      fireEvent.click(branchTab);
      expect(branchTab.className).toContain("font-medium");
    });
  });

  describe("selection and detail panel", () => {
    it("shows placeholder when nothing is selected", async () => {
      renderModal();
      await vi.advanceTimersByTimeAsync(200);

      await waitFor(() => {
        expect(screen.getByText(/#42 Fix auth/)).toBeInTheDocument();
      });

      expect(
        screen.getByText("Select a pull request, branch, or issue to reuse its context."),
      ).toBeInTheDocument();
    });

    it("shows PR detail when a pull request is selected", async () => {
      renderModal();
      await vi.advanceTimersByTimeAsync(200);

      await waitFor(() => {
        expect(screen.getByText(/#42 Fix auth/)).toBeInTheDocument();
      });

      // Click the first PR
      const prButton = screen.getByText(/#42 Fix auth/).closest("button")!;
      fireEvent.click(prButton);

      expect(screen.getByText("Pull request")).toBeInTheDocument();
      expect(screen.getByText("Fix auth")).toBeInTheDocument();
      expect(screen.getByText("#42 by alice")).toBeInTheDocument();
      expect(screen.getByText("Open source link")).toBeInTheDocument();
      expect(screen.getByText(/Use branch fix-auth to continue this PR/)).toBeInTheDocument();
    });

    it("shows branch detail when a branch is selected", async () => {
      renderModal();
      await vi.advanceTimersByTimeAsync(200);

      await waitFor(() => {
        expect(screen.getByText(/#42 Fix auth/)).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Branches" }));

      await waitFor(() => {
        expect(screen.getByText("feature-x")).toBeInTheDocument();
      });

      const branchButton = screen.getByText("feature-x").closest("button")!;
      fireEvent.click(branchButton);

      expect(screen.getByText("Branch")).toBeInTheDocument();
      expect(screen.getByText(/Use branch feature-x for the next session/)).toBeInTheDocument();
      // No "Open source link" for branches
      expect(screen.queryByText("Open source link")).not.toBeInTheDocument();
    });

    it("shows issue detail when an issue is selected", async () => {
      renderModal();
      await vi.advanceTimersByTimeAsync(200);

      await waitFor(() => {
        expect(screen.getByText(/#42 Fix auth/)).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Issues" }));

      await waitFor(() => {
        expect(screen.getByText(/ISS-1 Bug report/)).toBeInTheDocument();
      });

      const issueButton = screen.getByText(/ISS-1 Bug report/).closest("button")!;
      fireEvent.click(issueButton);

      expect(screen.getByText("Issue")).toBeInTheDocument();
      expect(screen.getByText("Bug report")).toBeInTheDocument();
      expect(screen.getByText("Open source link")).toBeInTheDocument();
      expect(screen.getByText(/Use issue ISS-1 and auto-attach tracker context/)).toBeInTheDocument();
    });
  });

  describe("search", () => {
    it("debounces search and re-fetches resources", async () => {
      renderModal();
      await vi.advanceTimersByTimeAsync(200);

      await waitFor(() => {
        expect(screen.getByText(/#42 Fix auth/)).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText("Search by title, number, or author");
      fireEvent.change(searchInput, { target: { value: "fix" } });

      // Wait for debounce
      await vi.advanceTimersByTimeAsync(200);

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringContaining("q=fix"),
          expect.anything(),
        );
      });
    });
  });

  describe("footer actions", () => {
    it("renders New thread and Spawn agent buttons", async () => {
      renderModal();
      await vi.advanceTimersByTimeAsync(200);

      expect(screen.getByRole("button", { name: "New thread" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Spawn agent" })).toBeInTheDocument();
    });

    it("buttons are disabled when project is null", () => {
      renderModal({ project: null });

      expect(screen.getByRole("button", { name: "New thread" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Spawn agent" })).toBeDisabled();
    });

    it("spawns agent without selection (orchestrator mode)", async () => {
      const orchestratorId = "orch-99";
      (global.fetch as Mock) = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
        if (url.includes("/resources")) {
          return fetchJsonOk(makeResourcesResponse());
        }
        if (url === "/api/orchestrators" && opts?.method === "POST") {
          return fetchJsonOk({ orchestrator: { id: orchestratorId } });
        }
        return fetchJsonFail(404, {});
      });

      const { onClose } = renderModal();
      await vi.advanceTimersByTimeAsync(200);

      await waitFor(() => {
        expect(screen.getByText(/#42 Fix auth/)).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Spawn agent" }));
      });

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith(
          `/projects/${encodeURIComponent(PROJECT.id)}/sessions/${encodeURIComponent(orchestratorId)}`,
        );
        expect(onClose).toHaveBeenCalled();
      });
    });

    it("creates thread with selected PR context", async () => {
      const sessionId = "sess-42";
      (global.fetch as Mock) = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
        if (url.includes("/resources")) {
          return fetchJsonOk(makeResourcesResponse());
        }
        if (url === "/api/spawn" && opts?.method === "POST") {
          return fetchJsonOk({ session: { id: sessionId } });
        }
        return fetchJsonFail(404, {});
      });

      const { onClose } = renderModal();
      await vi.advanceTimersByTimeAsync(200);

      await waitFor(() => {
        expect(screen.getByText(/#42 Fix auth/)).toBeInTheDocument();
      });

      // Select a PR
      const prButton = screen.getByText(/#42 Fix auth/).closest("button")!;
      fireEvent.click(prButton);

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "New thread" }));
      });

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          "/api/spawn",
          expect.objectContaining({
            method: "POST",
            body: expect.stringContaining("fix-auth"),
          }),
        );
        expect(mockPush).toHaveBeenCalledWith(
          `/projects/${encodeURIComponent(PROJECT.id)}/sessions/${encodeURIComponent(sessionId)}`,
        );
        expect(onClose).toHaveBeenCalled();
      });
    });

    it("creates thread with selected branch context", async () => {
      const sessionId = "sess-br";
      (global.fetch as Mock) = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
        if (url.includes("/resources")) {
          return fetchJsonOk(makeResourcesResponse());
        }
        if (url === "/api/spawn" && opts?.method === "POST") {
          return fetchJsonOk({ session: { id: sessionId } });
        }
        return fetchJsonFail(404, {});
      });

      const { onClose } = renderModal();
      await vi.advanceTimersByTimeAsync(200);

      await waitFor(() => {
        expect(screen.getByText(/#42 Fix auth/)).toBeInTheDocument();
      });

      // Switch to branches and select one
      fireEvent.click(screen.getByRole("button", { name: "Branches" }));
      await waitFor(() => expect(screen.getByText("feature-x")).toBeInTheDocument());

      const branchButton = screen.getByText("feature-x").closest("button")!;
      fireEvent.click(branchButton);

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "New thread" }));
      });

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          "/api/spawn",
          expect.objectContaining({
            body: expect.stringContaining("feature-x"),
          }),
        );
        expect(onClose).toHaveBeenCalled();
      });
    });

    it("creates thread with selected issue context", async () => {
      const sessionId = "sess-iss";
      (global.fetch as Mock) = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
        if (url.includes("/resources")) {
          return fetchJsonOk(makeResourcesResponse());
        }
        if (url === "/api/spawn" && opts?.method === "POST") {
          return fetchJsonOk({ session: { id: sessionId } });
        }
        return fetchJsonFail(404, {});
      });

      const { onClose } = renderModal();
      await vi.advanceTimersByTimeAsync(200);

      await waitFor(() => {
        expect(screen.getByText(/#42 Fix auth/)).toBeInTheDocument();
      });

      // Switch to issues and select one
      fireEvent.click(screen.getByRole("button", { name: "Issues" }));
      await waitFor(() => expect(screen.getByText(/ISS-1 Bug report/)).toBeInTheDocument());

      const issueButton = screen.getByText(/ISS-1 Bug report/).closest("button")!;
      fireEvent.click(issueButton);

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "New thread" }));
      });

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          "/api/spawn",
          expect.objectContaining({
            body: expect.stringContaining("ISS-1"),
          }),
        );
        expect(onClose).toHaveBeenCalled();
      });
    });

    it("shows error when spawn fails", async () => {
      (global.fetch as Mock) = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
        if (url.includes("/resources")) {
          return fetchJsonOk(makeResourcesResponse());
        }
        if (url === "/api/orchestrators" && opts?.method === "POST") {
          return fetchJsonFail(500, { error: "Orchestrator failed" });
        }
        return fetchJsonFail(404, {});
      });

      renderModal();
      await vi.advanceTimersByTimeAsync(200);

      await waitFor(() => {
        expect(screen.getByText(/#42 Fix auth/)).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Spawn agent" }));
      });

      await waitFor(() => {
        expect(screen.getByText("Orchestrator failed")).toBeInTheDocument();
      });
    });

    it("shows submitting state text", async () => {
      (global.fetch as Mock) = vi.fn().mockImplementation((url: string, _opts?: RequestInit) => {
        if (url.includes("/resources")) {
          return fetchJsonOk(makeResourcesResponse());
        }
        if (url === "/api/orchestrators") {
          return new Promise(() => {}); // never resolves
        }
        return fetchJsonFail(404, {});
      });

      renderModal();
      await vi.advanceTimersByTimeAsync(200);

      await waitFor(() => {
        expect(screen.getByText(/#42 Fix auth/)).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Spawn agent" }));
      });

      expect(screen.getByText("Spawning...")).toBeInTheDocument();
    });
  });

  describe("reset on close", () => {
    it("resets state when modal closes and reopens", async () => {
      const onClose = vi.fn();
      const { rerender } = render(
        <WorkspaceResourcesModal open onClose={onClose} project={PROJECT} />,
      );
      await vi.advanceTimersByTimeAsync(200);

      await waitFor(() => {
        expect(screen.getByText(/#42 Fix auth/)).toBeInTheDocument();
      });

      // Close
      rerender(
        <WorkspaceResourcesModal open={false} onClose={onClose} project={PROJECT} />,
      );

      // Reopen
      rerender(
        <WorkspaceResourcesModal open onClose={onClose} project={PROJECT} />,
      );
      await vi.advanceTimersByTimeAsync(200);

      // Should be back on pull requests tab with no selection
      await waitFor(() => {
        expect(
          screen.getByText("Select a pull request, branch, or issue to reuse its context."),
        ).toBeInTheDocument();
      });
    });
  });
});
