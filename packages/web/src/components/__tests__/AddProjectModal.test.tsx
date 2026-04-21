import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AddProjectModal } from "@/components/AddProjectModal";

const mockPush = vi.fn();
const mockRefresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, refresh: mockRefresh }),
}));

describe("AddProjectModal", () => {
  beforeEach(() => {
    mockPush.mockReset();
    mockRefresh.mockReset();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the hardened filesystem browse endpoint from the directory picker", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ entries: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AddProjectModal open onClose={vi.fn()} />);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/filesystem/browse?path=~"),
    );
  });

  it("shows a helpful message and disables submit when filesystem browsing is unavailable", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: "Not found" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AddProjectModal open onClose={vi.fn()} />);

    expect(
      await screen.findByText(/directory browsing is unavailable in this environment/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^add project$/i })).toBeDisabled();
  });

  it("blocks adding non-repo directories", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        entries: [{ name: "downloads", isDirectory: true, isGitRepo: false, hasLocalConfig: false }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AddProjectModal open onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: /downloads/i }));

    expect(await screen.findByText(/selected folder is not a git repository/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^add project$/i })).toBeDisabled();
  });

  it("offers opening the existing project or confirming shared storage reuse when the server returns 409", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        entries: [{ name: "second-app", isDirectory: true, isGitRepo: true, hasLocalConfig: false }],
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        entries: [{ name: "second-app", isDirectory: true, isGitRepo: true, hasLocalConfig: false }],
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        error: 'Project "existing-app" already owns this storage key.',
        existingProjectId: "existing-app",
        suggestion: "confirm-reuse",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AddProjectModal open onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: /second-app/i }));
    fireEvent.click(screen.getByRole("button", { name: /^add project$/i }));

    expect(
      await screen.findByRole("button", { name: /open existing/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reuse shared storage/i })).toBeInTheDocument();
  });

  it("retries with shared storage confirmation when requested", async () => {
    const onClose = vi.fn();
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        entries: [{ name: "my-app", isDirectory: true, isGitRepo: true, hasLocalConfig: false }],
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        error: 'Project "existing-app" already owns this storage key.',
        existingProjectId: "existing-app",
        suggestion: "confirm-reuse",
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ ok: true, projectId: "my-app" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AddProjectModal open onClose={onClose} />);

    fireEvent.click(await screen.findByRole("button", { name: /my-app/i }));
    fireEvent.click(screen.getByRole("button", { name: /^add project$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /reuse shared storage/i }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/projects/my-app"));
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/projects",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          projectId: "my-app",
          name: "My App",
          path: "~/my-app",
          allowStorageKeyReuse: true,
        }),
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("pushes directly to the new project after a successful POST", async () => {
    const onClose = vi.fn();
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        entries: [{ name: "my-app", isDirectory: true, isGitRepo: true, hasLocalConfig: false }],
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ ok: true, projectId: "my-app" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AddProjectModal open onClose={onClose} />);

    fireEvent.click(await screen.findByRole("button", { name: /my-app/i }));
    fireEvent.click(screen.getByRole("button", { name: /^add project$/i }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/projects/my-app"));
    expect(onClose).toHaveBeenCalled();
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("lets the user customize project id and name before submitting", async () => {
    const onClose = vi.fn();
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        entries: [{ name: "my-app", isDirectory: true, isGitRepo: true, hasLocalConfig: false }],
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ ok: true, projectId: "docs-app-alt" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AddProjectModal open onClose={onClose} />);

    fireEvent.click(await screen.findByRole("button", { name: /my-app/i }));
    fireEvent.change(screen.getByLabelText(/project id/i), { target: { value: "docs-app-alt" } });
    fireEvent.change(screen.getByLabelText(/project name/i), { target: { value: "Docs App Alt" } });
    fireEvent.click(screen.getByRole("button", { name: /^add project$/i }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/projects/docs-app-alt"));
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/projects",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          projectId: "docs-app-alt",
          name: "Docs App Alt",
          path: "~/my-app",
          allowStorageKeyReuse: false,
        }),
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });
});
