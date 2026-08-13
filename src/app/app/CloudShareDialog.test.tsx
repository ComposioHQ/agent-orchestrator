import type { ProjectShareLink } from "@aoagents/cloud-client";
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
    url: "https://app.example.com/share/org-1/tok_abc123",
  } as ProjectShareLink;
  const onCreate = vi.fn().mockResolvedValue(link);
  render(
    <CloudShareDialog
      busy={false}
      grants={[]}
      links={[]}
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
  await waitFor(() =>
    expect(screen.getByDisplayValue(link.url as string)).toBeVisible(),
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
