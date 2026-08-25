import type { ProjectShareLink } from "./share-types";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { CloudShareDialog } from "./CloudShareDialog";

const project = {
  id: "project-1",
  orgId: "org-1",
  displayName: "Cloud platform",
  repositoryUrl: "https://github.com/acme/cloud",
  defaultBranch: "main",
  config: {},
  createdAt: "2026-08-12T00:00:00Z",
  updatedAt: "2026-08-12T00:00:00Z",
};

it("uses sandbox policy as the only link permission control", () => {
  render(
    <CloudShareDialog
      busy={false}
      grants={[]}
      links={[]}
      open
      onClose={vi.fn()}
      onCreate={vi.fn()}
      onRevoke={vi.fn()}
      onRevokeGrant={vi.fn()}
      project={project}
    />,
  );

  expect(screen.queryByText("Permission")).not.toBeInTheDocument();
  expect(screen.queryByText("Viewer")).not.toBeInTheDocument();
  expect(screen.queryByText("Editor")).not.toBeInTheDocument();
  expect(screen.getByText("Sandbox policy")).toBeVisible();
  expect(screen.getByRole("button", { name: /Standard/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByRole("button", { name: "Create link" })).toBeEnabled();
});

it("creates a link and shows its one-time url", async () => {
  const link = {
    id: "link-1",
    orgId: "org-1",
    projectId: "project-1",
    role: "editor",
    status: "active",
    accessScope: "anyone",
    recipients: [],
    interaction: "interact",
    deniedCommands: [],
    createdAt: "2026-08-13T00:00:00Z",
    updatedAt: "2026-08-13T00:00:00Z",
    token: "tok_abc123",
    url: "https://wrong-internal-host.example/share/org-1/tok_abc123",
  } as ProjectShareLink;
  const onCreate = vi.fn().mockResolvedValue(link);
  render(
    <CloudShareDialog
      busy={false}
      grants={[]}
      links={[]}
      open
      onClose={vi.fn()}
      onCreate={onCreate}
      onRevoke={vi.fn()}
      onRevokeGrant={vi.fn()}
      project={project}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Create link" }));

  expect(onCreate).toHaveBeenCalledWith({
    accessScope: "anyone",
    recipients: [],
    modeCap: "standard",
  });
  // Built from window.location.origin, not the server-provided url — the
  // server only sees whatever internal host this request happened to be
  // proxied through, which the browser must never trust for a link it will
  // open later.
  const expectedURL = `${window.location.origin}/share/${project.orgId}/${link.token}`;
  await waitFor(() =>
    expect(screen.getByDisplayValue(expectedURL)).toBeVisible(),
  );
});

it("lists active links and revokes them", async () => {
  const activeLink = {
    id: "link-1",
    orgId: "org-1",
    projectId: "project-1",
    role: "viewer",
    status: "active",
    accessScope: "anyone",
    recipients: [],
    interaction: "view",
    modeCap: "read-only",
    deniedCommands: [],
    createdAt: "2026-08-13T00:00:00Z",
    updatedAt: "2026-08-13T00:00:00Z",
  } as ProjectShareLink;
  const onRevoke = vi.fn().mockResolvedValue(undefined);
  render(
    <CloudShareDialog
      busy={false}
      grants={[]}
      links={[activeLink]}
      open
      onClose={vi.fn()}
      onCreate={vi.fn()}
      onRevoke={onRevoke}
      onRevokeGrant={vi.fn()}
      project={project}
    />,
  );

  expect(screen.getByText("Whole project · read-only")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Revoke link" }));
  expect(onRevoke).toHaveBeenCalledWith(activeLink);
});

it("updates collaborator role, sandbox policy, and agent access", () => {
  const collaborator = {
    project: { id: "project-1", orgId: "org-1", displayName: "Cloud platform" },
    grant: {
      id: "grant-1",
      role: "editor",
      modeCap: "standard",
      userEmail: "dev@example.com",
      userDisplayName: "Dev User",
    },
  } as const;
  const session = {
    id: "session-1",
    projectId: "project-1",
    displayName: "Orchestrator",
  } as never;
  const onUpdateGrant = vi.fn().mockResolvedValue(undefined);
  render(
    <CloudShareDialog
      grants={[collaborator]}
      links={[]}
      onClose={vi.fn()}
      onUpdateGrant={onUpdateGrant}
      open
      project={project}
      sessions={[session]}
    />,
  );

  fireEvent.change(screen.getByLabelText("Agent access for dev@example.com"), {
    target: { value: "session-1" },
  });
  expect(onUpdateGrant).toHaveBeenCalledWith(collaborator, {
    role: "editor",
    modeCap: "standard",
    sessionId: "session-1",
  });
});
