import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";

import { CloudBoardDemo } from "./page";

it("recreates the desktop sidebar and command menu", () => {
  render(<CloudBoardDemo />);

  expect(screen.getByText("Agent Orchestrator")).toBeVisible();
  expect(screen.getByRole("button", { name: "Search" })).toHaveTextContent("⌘ K");
  expect(screen.getByText("Projects")).toBeVisible();
  expect(screen.getByRole("button", { name: "Settings" })).toBeVisible();

  fireEvent.keyDown(window, { key: "k", metaKey: true });
  expect(screen.getByRole("dialog", { name: "Command menu" })).toBeInTheDocument();
});

it("opens settings from the sidebar footer", () => {
  render(<CloudBoardDemo />);

  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
});

it("switches workspaces from the sidebar and omits the old cloud footer button", () => {
  render(<CloudBoardDemo />);

  const sidebar = screen.getByRole("complementary");
  const workspaceSwitcher = within(sidebar).getByRole("button", {
    name: "Switch workspace",
  });

  expect(workspaceSwitcher).toHaveTextContent("Personal workspace");
  expect(
    within(sidebar).queryByRole("button", { name: "AO Cloud" }),
  ).not.toBeInTheDocument();

  fireEvent.click(workspaceSwitcher);
  expect(screen.getByRole("menu", { name: "Workspaces" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("menuitemradio", { name: /AO Team/ }));
  expect(workspaceSwitcher).toHaveTextContent("AO Team");
  expect(workspaceSwitcher).toHaveAttribute("aria-expanded", "false");
});

it("frames the board in the desktop shell and renders the project topbar", () => {
  render(<CloudBoardDemo />);

  expect(screen.getByTestId("cloud-main-shell")).toHaveClass("p-[6px]");
  expect(screen.getByRole("banner", { name: "Project toolbar" })).toHaveClass(
    "h-12",
  );
  expect(
    screen.getByRole("heading", { name: "Cloud platform" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "New task" })).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Open orchestrator" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Notifications" })).toBeVisible();
});

it("uses the desktop typography and title case for board columns", () => {
  render(<CloudBoardDemo />);

  for (const title of ["Working", "Needs you", "In review", "Ready to merge"]) {
    expect(screen.getByRole("heading", { name: title })).toHaveClass(
      "tracking-[-0.01em]",
    );
  }
  expect(screen.getByTestId("cloud-board-demo")).toHaveClass("font-sans");
});

it("uses the desktop surface and neutral border on every board card", () => {
  render(<CloudBoardDemo />);

  for (const card of screen.getAllByTestId("cloud-board-session-card")) {
    expect(card).toHaveClass(
      "border-[var(--border)]",
      "bg-[var(--color-bg-secondary)]",
    );
  }
});

it("does not show an activity dot in the orchestrator button", () => {
  render(<CloudBoardDemo />);

  const orchestratorButton = screen.getByRole("button", {
    name: "Open orchestrator",
  });
  expect(
    within(orchestratorButton).queryByTestId("orchestrator-activity-indicator"),
  ).not.toBeInTheDocument();
  expect(orchestratorButton).toHaveClass("h-9", "py-2.5");
});
