import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}));

vi.mock("@/components/DirectTerminal", () => ({
  DirectTerminal: ({
    sessionId,
    startFullscreen,
  }: {
    sessionId: string;
    startFullscreen: boolean;
  }) => (
    <div data-testid="direct-terminal">
      {sessionId}:{String(startFullscreen)}
    </div>
  ),
}));

describe("TestDirectPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the default direct terminal clipboard instructions", async () => {
    searchParams = new URLSearchParams();
    const { default: TestDirectPage } = await import("./page");

    render(<TestDirectPage />);

    await waitFor(() => {
      expect(screen.getByText("DirectTerminal Test - XDA Clipboard Support")).toBeInTheDocument();
    });
    expect(screen.getByText("Testing:")).toBeInTheDocument();
    expect(screen.getByText("ao-orchestrator")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId("direct-terminal")).toHaveTextContent("ao-orchestrator:false");
    });
  });

  it("passes session and fullscreen params to the terminal", async () => {
    searchParams = new URLSearchParams("session=ao-20&fullscreen=true");
    const { default: TestDirectPage } = await import("./page");

    render(<TestDirectPage />);

    await waitFor(() => {
      expect(screen.getByTestId("direct-terminal")).toHaveTextContent("ao-20:true");
    });
    expect(screen.getByText(/clipboard works without iTerm2 attachment/i)).toBeInTheDocument();
  });
});
