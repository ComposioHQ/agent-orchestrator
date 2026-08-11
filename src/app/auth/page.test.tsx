import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { CloudEntryClient } from "../CloudEntryClient";

vi.mock("./PrismLogoGrid", () => ({
  PrismLogoGrid: () => (
    <div role="img" aria-label="Agent Orchestrator square grid" />
  ),
}));

it("offers WorkOS as the hosted staging entry action", () => {
  render(<CloudEntryClient mode="staging" />);

  expect(
    screen.getByRole("link", { name: "Continue with WorkOS" }),
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
    screen.queryByRole("link", { name: "Continue with WorkOS" }),
  ).not.toBeInTheDocument();
});
