import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { AddProjectModal } from "@/components/AddProjectModal";

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn(), refresh: vi.fn() }),
}));

// ---------- helpers ----------
function fetchJsonOk(data: unknown) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(data),
  });
}

function fetchJsonFail(status: number, data: unknown) {
  return Promise.resolve({
    ok: false,
    status,
    json: () => Promise.resolve(data),
  });
}

const HOME = "/Users/testuser";

function makeBrowseResult(overrides?: Record<string, unknown>) {
  return {
    path: HOME,
    parent: null,
    directories: [
      { name: "project-a", path: `${HOME}/project-a`, hasChildren: true },
      { name: "project-b", path: `${HOME}/project-b`, hasChildren: false },
    ],
    isGitRepo: false,
    hasConfig: false,
    ...overrides,
  };
}

function renderModal(props?: Partial<React.ComponentProps<typeof AddProjectModal>>) {
  const onClose = vi.fn();
  const onProjectAdded = vi.fn();
  const utils = render(
    <AddProjectModal
      open
      onClose={onClose}
      onProjectAdded={onProjectAdded}
      {...props}
    />,
  );
  return { onClose, onProjectAdded, ...utils };
}

// ---------- setup ----------
beforeEach(() => {
  vi.restoreAllMocks();
  mockPush.mockClear();
  // jsdom doesn't implement scrollTo
  Element.prototype.scrollTo = vi.fn();
  // Default: browse returns home directory
  (global.fetch as Mock) = vi.fn().mockImplementation((url: string) => {
    if (typeof url === "string" && url.startsWith("/api/browse-directory")) {
      return fetchJsonOk(makeBrowseResult());
    }
    return fetchJsonFail(404, { error: "not found" });
  });
});

// ---------- tests ----------

describe("AddProjectModal", () => {
  describe("rendering", () => {
    it("renders the modal with title and footer buttons", async () => {
      renderModal();

      await waitFor(() => {
        expect(screen.getByText("Open Project")).toBeInTheDocument();
      });
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
      expect(screen.getByText("No directory selected")).toBeInTheDocument();
    });

    it("does not render when closed", () => {
      render(
        <AddProjectModal open={false} onClose={vi.fn()} />,
      );
      expect(screen.queryByText("Open Project")).not.toBeInTheDocument();
    });

    it("shows loading state before browse resolves", async () => {
      // Never resolve the fetch
      (global.fetch as Mock) = vi.fn().mockReturnValue(new Promise(() => {}));
      renderModal();

      expect(screen.getByText("Loading...")).toBeInTheDocument();
    });

    it("shows directory listing after browse resolves", async () => {
      renderModal();

      await waitFor(() => {
        expect(screen.getByText("project-a")).toBeInTheDocument();
      });
      expect(screen.getByText("project-b")).toBeInTheDocument();
      expect(screen.getByText("Current folder")).toBeInTheDocument();
    });

    it("shows 'No subdirectories' when directory is empty", async () => {
      (global.fetch as Mock) = vi.fn().mockImplementation(() =>
        fetchJsonOk(makeBrowseResult({ directories: [] })),
      );
      renderModal();

      await waitFor(() => {
        expect(screen.getByText("No subdirectories")).toBeInTheDocument();
      });
    });

    it("shows browse error state", async () => {
      (global.fetch as Mock) = vi.fn().mockImplementation(() =>
        fetchJsonFail(500, { error: "Permission denied" }),
      );
      renderModal();

      await waitFor(() => {
        expect(screen.getByText("Permission denied")).toBeInTheDocument();
      });
    });
  });

  describe("badges", () => {
    it("shows git badge when directory is a git repo", async () => {
      (global.fetch as Mock) = vi.fn().mockImplementation(() =>
        fetchJsonOk(makeBrowseResult({ isGitRepo: true })),
      );
      renderModal();

      await waitFor(() => {
        expect(screen.getByText("git")).toBeInTheDocument();
      });
    });

    it("shows new badge when directory is not a git repo", async () => {
      (global.fetch as Mock) = vi.fn().mockImplementation(() =>
        fetchJsonOk(makeBrowseResult({ isGitRepo: false })),
      );
      renderModal();

      await waitFor(() => {
        expect(screen.getByText("new")).toBeInTheDocument();
      });
    });

    it("shows ao badge when directory has config", async () => {
      (global.fetch as Mock) = vi.fn().mockImplementation(() =>
        fetchJsonOk(makeBrowseResult({ hasConfig: true })),
      );
      renderModal();

      await waitFor(() => {
        expect(screen.getByText("ao")).toBeInTheDocument();
      });
    });
  });

  describe("navigation", () => {
    it("navigates into a subdirectory on click", async () => {
      const fetchMock = vi.fn();
      fetchMock.mockImplementation((url: string) => {
        if (url.includes("project-a")) {
          return fetchJsonOk(
            makeBrowseResult({
              path: `${HOME}/project-a`,
              parent: HOME,
              directories: [
                { name: "src", path: `${HOME}/project-a/src`, hasChildren: true },
              ],
              isGitRepo: true,
            }),
          );
        }
        return fetchJsonOk(makeBrowseResult());
      });
      (global.fetch as Mock) = fetchMock;
      renderModal();

      await waitFor(() => {
        expect(screen.getByText("project-a")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("project-a"));

      await waitFor(() => {
        expect(screen.getByText("src")).toBeInTheDocument();
      });
    });

    it("navigates to parent directory", async () => {
      (global.fetch as Mock) = vi.fn().mockImplementation((url: string) => {
        if (url.includes(encodeURIComponent(`${HOME}/project-a`))) {
          return fetchJsonOk(
            makeBrowseResult({
              path: `${HOME}/project-a`,
              parent: HOME,
              directories: [],
              isGitRepo: true,
            }),
          );
        }
        return fetchJsonOk(makeBrowseResult());
      });
      renderModal();

      // First, navigate into project-a
      await waitFor(() => {
        expect(screen.getByText("project-a")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText("project-a"));

      await waitFor(() => {
        expect(screen.getByText("..")).toBeInTheDocument();
      });

      // Click parent directory
      fireEvent.click(screen.getByText(".."));

      await waitFor(() => {
        expect(screen.getByText("project-a")).toBeInTheDocument();
      });
    });

    it("navigates via path input and Go button", async () => {
      renderModal();

      await waitFor(() => {
        expect(screen.getByPlaceholderText("/path/to/directory")).toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText("/path/to/directory");
      fireEvent.change(input, { target: { value: `${HOME}/project-a` } });
      fireEvent.click(screen.getByRole("button", { name: "Go" }));

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringContaining(`path=${encodeURIComponent(`${HOME}/project-a`)}`),
        );
      });
    });

    it("navigates via Enter key in path input", async () => {
      renderModal();

      await waitFor(() => {
        expect(screen.getByPlaceholderText("/path/to/directory")).toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText("/path/to/directory");
      fireEvent.change(input, { target: { value: `${HOME}/project-a` } });
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringContaining(`path=${encodeURIComponent(`${HOME}/project-a`)}`),
        );
      });
    });
  });

  describe("selection and name auto-fill", () => {
    it("auto-fills name from selected directory path", async () => {
      (global.fetch as Mock) = vi.fn().mockImplementation((url: string) => {
        if (url.includes("project-a")) {
          return fetchJsonOk(
            makeBrowseResult({
              path: `${HOME}/project-a`,
              parent: HOME,
              directories: [],
              isGitRepo: true,
            }),
          );
        }
        return fetchJsonOk(makeBrowseResult());
      });
      renderModal();

      await waitFor(() => {
        expect(screen.getByText("project-a")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("project-a"));

      await waitFor(() => {
        const nameInput = screen.getByPlaceholderText("my-project");
        expect(nameInput).toBeInTheDocument();
        expect(nameInput).toHaveValue("project-a");
      });
    });

    it("shows Display Name field only when a path is selected", async () => {
      renderModal();

      await waitFor(() => {
        expect(screen.getByText("project-a")).toBeInTheDocument();
      });

      // At home, no directory is selected
      expect(screen.queryByText("Display Name")).not.toBeInTheDocument();
    });

    it("preserves manually-set name on further navigation", async () => {
      (global.fetch as Mock) = vi.fn().mockImplementation((url: string) => {
        if (url.includes("project-a")) {
          return fetchJsonOk(
            makeBrowseResult({
              path: `${HOME}/project-a`,
              parent: HOME,
              directories: [
                { name: "sub", path: `${HOME}/project-a/sub`, hasChildren: false },
              ],
              isGitRepo: true,
            }),
          );
        }
        if (url.includes("sub")) {
          return fetchJsonOk(
            makeBrowseResult({
              path: `${HOME}/project-a/sub`,
              parent: `${HOME}/project-a`,
              directories: [],
              isGitRepo: false,
            }),
          );
        }
        return fetchJsonOk(makeBrowseResult());
      });
      renderModal();

      await waitFor(() => expect(screen.getByText("project-a")).toBeInTheDocument());
      fireEvent.click(screen.getByText("project-a"));

      await waitFor(() => {
        expect(screen.getByPlaceholderText("my-project")).toBeInTheDocument();
      });

      // Manually set name
      const nameInput = screen.getByPlaceholderText("my-project");
      fireEvent.change(nameInput, { target: { value: "custom-name" } });

      // Navigate into sub
      fireEvent.click(screen.getByText("sub"));

      await waitFor(() => {
        expect(screen.getByPlaceholderText("my-project")).toHaveValue("custom-name");
      });
    });
  });

  describe("submit button text", () => {
    it("shows 'Initialize Project' for non-git directory", async () => {
      (global.fetch as Mock) = vi.fn().mockImplementation((url: string) => {
        if (url.includes("project-a")) {
          return fetchJsonOk(
            makeBrowseResult({
              path: `${HOME}/project-a`,
              parent: HOME,
              directories: [],
              isGitRepo: false,
              hasConfig: false,
            }),
          );
        }
        return fetchJsonOk(makeBrowseResult());
      });
      renderModal();

      await waitFor(() => expect(screen.getByText("project-a")).toBeInTheDocument());
      fireEvent.click(screen.getByText("project-a"));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Initialize Project" })).toBeInTheDocument();
      });
    });

    it("shows 'Set Up Project' for git repo without config", async () => {
      (global.fetch as Mock) = vi.fn().mockImplementation((url: string) => {
        if (url.includes("project-a")) {
          return fetchJsonOk(
            makeBrowseResult({
              path: `${HOME}/project-a`,
              parent: HOME,
              directories: [],
              isGitRepo: true,
              hasConfig: false,
            }),
          );
        }
        return fetchJsonOk(makeBrowseResult());
      });
      renderModal();

      await waitFor(() => expect(screen.getByText("project-a")).toBeInTheDocument());
      fireEvent.click(screen.getByText("project-a"));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Set Up Project" })).toBeInTheDocument();
      });
    });

    it("shows 'Open Project' for git repo with config", async () => {
      (global.fetch as Mock) = vi.fn().mockImplementation((url: string) => {
        if (url.includes("project-a")) {
          return fetchJsonOk(
            makeBrowseResult({
              path: `${HOME}/project-a`,
              parent: HOME,
              directories: [],
              isGitRepo: true,
              hasConfig: true,
            }),
          );
        }
        return fetchJsonOk(makeBrowseResult());
      });
      renderModal();

      await waitFor(() => expect(screen.getByText("project-a")).toBeInTheDocument());
      fireEvent.click(screen.getByText("project-a"));

      await waitFor(() => {
        // The footer has an "Open Project" button (submit) distinct from modal title
        const openButtons = screen.getAllByText("Open Project");
        expect(openButtons.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  describe("form submission", () => {
    it("submit button is disabled when no path is selected", async () => {
      renderModal();

      await waitFor(() => {
        expect(screen.getByText("project-a")).toBeInTheDocument();
      });

      // The submit button should be disabled since we're at home (no selectedPath)
      const initBtn = screen.getByRole("button", { name: "Initialize Project" });
      expect(initBtn).toBeDisabled();
    });

    it("submits successfully and navigates to project", async () => {
      const projectId = "proj-123";
      (global.fetch as Mock) = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
        if (url.startsWith("/api/browse-directory")) {
          if (url.includes("project-a")) {
            return fetchJsonOk(
              makeBrowseResult({
                path: `${HOME}/project-a`,
                parent: HOME,
                directories: [],
                isGitRepo: true,
                hasConfig: true,
              }),
            );
          }
          return fetchJsonOk(makeBrowseResult());
        }
        if (url === "/api/projects" && opts?.method === "POST") {
          return fetchJsonOk({ project: { id: projectId } });
        }
        return fetchJsonFail(404, { error: "not found" });
      });

      const { onClose, onProjectAdded } = renderModal();

      await waitFor(() => expect(screen.getByText("project-a")).toBeInTheDocument());
      fireEvent.click(screen.getByText("project-a"));

      await waitFor(() => {
        const btns = screen.getAllByText("Open Project");
        expect(btns.length).toBeGreaterThanOrEqual(1);
      });

      // Click the one that is not disabled
      const submitBtn = screen.getAllByRole("button").find(
        (btn) => btn.textContent === "Open Project" && !btn.hasAttribute("disabled"),
      );
      expect(submitBtn).toBeDefined();

      await act(async () => {
        fireEvent.click(submitBtn!);
      });

      await waitFor(() => {
        expect(onProjectAdded).toHaveBeenCalledWith(projectId);
        expect(mockPush).toHaveBeenCalledWith(`/projects/${encodeURIComponent(projectId)}`);
        expect(onClose).toHaveBeenCalled();
      });
    });

    it("shows error when submission fails", async () => {
      (global.fetch as Mock) = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
        if (url.startsWith("/api/browse-directory")) {
          if (url.includes("project-a")) {
            return fetchJsonOk(
              makeBrowseResult({
                path: `${HOME}/project-a`,
                parent: HOME,
                directories: [],
                isGitRepo: true,
              }),
            );
          }
          return fetchJsonOk(makeBrowseResult());
        }
        if (url === "/api/projects" && opts?.method === "POST") {
          return fetchJsonFail(400, { error: "Duplicate project" });
        }
        return fetchJsonFail(404, {});
      });

      renderModal();

      await waitFor(() => expect(screen.getByText("project-a")).toBeInTheDocument());
      fireEvent.click(screen.getByText("project-a"));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Set Up Project" })).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Set Up Project" }));
      });

      await waitFor(() => {
        expect(screen.getByText("Duplicate project")).toBeInTheDocument();
      });
    });

    it("shows submitting state with spinner text", async () => {
      // Make POST never resolve to keep submitting state
      (global.fetch as Mock) = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
        if (url.startsWith("/api/browse-directory")) {
          if (url.includes("project-a")) {
            return fetchJsonOk(
              makeBrowseResult({
                path: `${HOME}/project-a`,
                parent: HOME,
                directories: [],
                isGitRepo: true,
              }),
            );
          }
          return fetchJsonOk(makeBrowseResult());
        }
        if (url === "/api/projects" && opts?.method === "POST") {
          return new Promise(() => {}); // never resolves
        }
        return fetchJsonFail(404, {});
      });

      renderModal();

      await waitFor(() => expect(screen.getByText("project-a")).toBeInTheDocument());
      fireEvent.click(screen.getByText("project-a"));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Set Up Project" })).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Set Up Project" }));
      });

      expect(screen.getByText("Opening...")).toBeInTheDocument();
      expect(screen.getByText(/Registering workspace/)).toBeInTheDocument();
      expect(screen.getByText("Opening workspace")).toBeInTheDocument();
    });
  });

  describe("migration error display", () => {
    it("shows parsed migration error with file path and duplicate keys", async () => {
      const migrationError = [
        "Found older AO config that needs migration",
        "File to edit: /Users/testuser/.agent-orchestrator.yaml",
        "Duplicate project keys: proj-a, proj-b",
        "Please resolve the duplicate keys manually and try again.",
      ].join("\n");

      (global.fetch as Mock) = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
        if (url.startsWith("/api/browse-directory")) {
          if (url.includes("project-a")) {
            return fetchJsonOk(
              makeBrowseResult({
                path: `${HOME}/project-a`,
                parent: HOME,
                directories: [],
                isGitRepo: true,
              }),
            );
          }
          return fetchJsonOk(makeBrowseResult());
        }
        if (url === "/api/projects" && opts?.method === "POST") {
          return fetchJsonFail(400, { error: migrationError });
        }
        return fetchJsonFail(404, {});
      });

      renderModal();

      await waitFor(() => expect(screen.getByText("project-a")).toBeInTheDocument());
      fireEvent.click(screen.getByText("project-a"));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Set Up Project" })).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Set Up Project" }));
      });

      await waitFor(() => {
        expect(screen.getByText("Older AO config needs a quick cleanup")).toBeInTheDocument();
      });
      expect(screen.getByText("File to edit")).toBeInTheDocument();
      expect(screen.getByText("/Users/testuser/.agent-orchestrator.yaml")).toBeInTheDocument();
      expect(screen.getByText("Duplicate project keys")).toBeInTheDocument();
      expect(screen.getByText("proj-a")).toBeInTheDocument();
      expect(screen.getByText("proj-b")).toBeInTheDocument();
      expect(screen.getByText("Please resolve the duplicate keys manually and try again.")).toBeInTheDocument();
    });

    it("shows plain error for non-migration errors", async () => {
      (global.fetch as Mock) = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
        if (url.startsWith("/api/browse-directory")) {
          if (url.includes("project-a")) {
            return fetchJsonOk(
              makeBrowseResult({
                path: `${HOME}/project-a`,
                parent: HOME,
                directories: [],
                isGitRepo: true,
              }),
            );
          }
          return fetchJsonOk(makeBrowseResult());
        }
        if (url === "/api/projects" && opts?.method === "POST") {
          return fetchJsonFail(500, { error: "Server exploded" });
        }
        return fetchJsonFail(404, {});
      });

      renderModal();

      await waitFor(() => expect(screen.getByText("project-a")).toBeInTheDocument());
      fireEvent.click(screen.getByText("project-a"));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Set Up Project" })).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Set Up Project" }));
      });

      await waitFor(() => {
        expect(screen.getByText("Server exploded")).toBeInTheDocument();
      });
      // Should NOT show migration-specific UI
      expect(screen.queryByText("Older AO config needs a quick cleanup")).not.toBeInTheDocument();
    });
  });

  describe("home path guidance", () => {
    it("shows guidance when at home directory", async () => {
      renderModal();

      await waitFor(() => {
        expect(
          screen.getByText("Choose a repository folder inside your home directory to continue."),
        ).toBeInTheDocument();
      });
    });

    it("hides guidance when navigated into a subdirectory", async () => {
      (global.fetch as Mock) = vi.fn().mockImplementation((url: string) => {
        if (url.includes("project-a")) {
          return fetchJsonOk(
            makeBrowseResult({
              path: `${HOME}/project-a`,
              parent: HOME,
              directories: [],
              isGitRepo: true,
            }),
          );
        }
        return fetchJsonOk(makeBrowseResult());
      });
      renderModal();

      await waitFor(() => expect(screen.getByText("project-a")).toBeInTheDocument());
      fireEvent.click(screen.getByText("project-a"));

      await waitFor(() => {
        expect(
          screen.queryByText("Choose a repository folder inside your home directory to continue."),
        ).not.toBeInTheDocument();
      });
    });
  });

  describe("footer display", () => {
    it("shows selected path in footer when a directory is selected", async () => {
      (global.fetch as Mock) = vi.fn().mockImplementation((url: string) => {
        if (url.includes("project-a")) {
          return fetchJsonOk(
            makeBrowseResult({
              path: `${HOME}/project-a`,
              parent: HOME,
              directories: [],
              isGitRepo: true,
            }),
          );
        }
        return fetchJsonOk(makeBrowseResult());
      });
      renderModal();

      await waitFor(() => expect(screen.getByText("project-a")).toBeInTheDocument());
      fireEvent.click(screen.getByText("project-a"));

      await waitFor(() => {
        // Path appears in both "Current folder" header and footer
        const matches = screen.getAllByText(`${HOME}/project-a`);
        expect(matches.length).toBeGreaterThanOrEqual(1);
        // Footer-specific: find the span with the path
        const footerSpan = matches.find((el) => el.tagName === "SPAN");
        expect(footerSpan).toBeDefined();
      });
    });

    it("calls onClose when Cancel is clicked", async () => {
      const { onClose } = renderModal();

      await waitFor(() => expect(screen.getByText("project-a")).toBeInTheDocument());

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("reset on close", () => {
    it("resets state when modal reopens", async () => {
      const { rerender, onClose } = renderModal();

      await waitFor(() => expect(screen.getByText("project-a")).toBeInTheDocument());

      // Close modal
      rerender(
        <AddProjectModal open={false} onClose={onClose} />,
      );

      // Re-open
      rerender(
        <AddProjectModal open onClose={onClose} />,
      );

      await waitFor(() => {
        expect(screen.getByText("project-a")).toBeInTheDocument();
      });
      // No directory selected text should be back
      expect(screen.getByText("No directory selected")).toBeInTheDocument();
    });
  });
});
