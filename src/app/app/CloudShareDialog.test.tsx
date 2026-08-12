import { render, screen } from "@testing-library/react";
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
    <CloudShareDialog onClose={vi.fn()} project={project} />,
  );

  expect(screen.queryByText("Permission")).not.toBeInTheDocument();
  expect(screen.queryByText("Viewer")).not.toBeInTheDocument();
  expect(screen.queryByText("Editor")).not.toBeInTheDocument();
  expect(screen.getByText("Sandbox policy")).toBeVisible();
  expect(screen.getByRole("button", { name: /Standard/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.queryByText("Worker access")).not.toBeInTheDocument();
  expect(screen.queryByText("Enforce command guard")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create link" })).toBeDisabled();
  expect(
    screen.getByText(/Sharing routes are not implemented/),
  ).toBeVisible();
});
