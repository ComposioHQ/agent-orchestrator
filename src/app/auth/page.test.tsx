import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { CloudEntryClient } from "../CloudEntryClient";

vi.mock("./PrismLogoGrid", () => ({
  PrismLogoGrid: () => (
    <div role="img" aria-label="Agent Orchestrator square grid" />
  ),
}));

it("offers direct Cloud entry for hosted staging", () => {
  render(<CloudEntryClient mode="staging" />);

  expect(
    screen.getByRole("link", { name: "Continue to Cloud" }),
  ).toHaveAttribute("href", "/sign-in");
  expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
});

it("uses email and password only in local development mode", () => {
  render(<CloudEntryClient mode="local" />);

  expect(screen.getByLabelText("Email")).toBeVisible();
  expect(screen.getByLabelText("Password")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Sign in locally" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("link", { name: "Continue to Cloud" }),
  ).not.toBeInTheDocument();
});

it("renders the parity auth surface when the preview flag is enabled", () => {
  render(<CloudEntryClient mode="local" nextUi />);

  expect(screen.getByText("Agent Orchestrator")).toBeVisible();
  expect(screen.getByRole("heading", { name: /Your agents/i })).toBeVisible();
  expect(screen.getByRole("button", { name: "Sign in locally" })).toBeVisible();
  expect(screen.getByRole("img", { name: "Agent Orchestrator square grid" })).toBeVisible();
});
