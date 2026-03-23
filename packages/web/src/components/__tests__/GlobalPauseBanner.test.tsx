import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { GlobalPauseBanner } from "@/components/GlobalPauseBanner";
import type { GlobalPauseState } from "@/lib/types";

describe("GlobalPauseBanner", () => {
  const makeGlobalPause = (overrides: Partial<GlobalPauseState> = {}): GlobalPauseState => ({
    pausedUntil: new Date(Date.now() + 3600000).toISOString(),
    reason: "Model rate limit reached",
    sourceSessionId: "session-1",
    ...overrides,
  });

  it("renders pause reason", () => {
    render(
      <GlobalPauseBanner
        globalPause={makeGlobalPause()}
        resumeAtLabel={null}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText(/Orchestrator paused:/)).toBeInTheDocument();
    expect(screen.getByText(/Model rate limit reached/)).toBeInTheDocument();
  });

  it("renders resume time when provided", () => {
    render(
      <GlobalPauseBanner
        globalPause={makeGlobalPause()}
        resumeAtLabel="3/10/2026, 12:30:00 PM"
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText(/Resume after/)).toBeInTheDocument();
  });

  it("renders source session ID when provided", () => {
    render(
      <GlobalPauseBanner
        globalPause={makeGlobalPause({ sourceSessionId: "my-worker-42" })}
        resumeAtLabel={null}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText(/Source: my-worker-42/)).toBeInTheDocument();
  });

  it("does not render source session when absent", () => {
    render(
      <GlobalPauseBanner
        globalPause={makeGlobalPause({ sourceSessionId: undefined })}
        resumeAtLabel={null}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.queryByText(/Source:/)).not.toBeInTheDocument();
  });

  it("calls onDismiss when dismiss button is clicked", () => {
    const onDismiss = vi.fn();

    render(
      <GlobalPauseBanner
        globalPause={makeGlobalPause()}
        resumeAtLabel={null}
        onDismiss={onDismiss}
      />,
    );

    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
