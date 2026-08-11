import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import CloudEntryPage from "./page";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, replace: vi.fn() }),
}));

vi.mock("./AuthProvider", () => ({
  useAuth: () => ({ status: "unauthenticated" }),
}));

vi.mock("./PrismLogoGrid", () => ({
  PrismLogoGrid: () => (
    <div role="img" aria-label="Agent Orchestrator square grid" />
  ),
}));

it("offers WorkOS as the only cloud entry action", () => {
  render(<CloudEntryPage />);

  const buttons = screen.getAllByRole("button");
  expect(buttons).toHaveLength(1);
  expect(buttons[0]).toHaveAccessibleName("Continue to Cloud");
  expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();

  fireEvent.click(buttons[0]);
  expect(mocks.push).toHaveBeenCalledWith("/app");
});
