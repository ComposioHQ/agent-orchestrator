import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { StopAllButton } from "../StopAllButton";

beforeEach(() => {
  global.fetch = vi.fn();
});

describe("StopAllButton", () => {
  it("renders nothing when sessionCount is 0", () => {
    const { container } = render(<StopAllButton sessionCount={0} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders button when sessionCount > 0", () => {
    render(<StopAllButton sessionCount={3} />);
    expect(screen.getByText("Stop All")).toBeInTheDocument();
  });

  it("shows confirmation on first click", () => {
    render(<StopAllButton sessionCount={3} />);
    fireEvent.click(screen.getByText("Stop All"));
    expect(screen.getByText("Stop all 3")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
  });

  it("calls API on confirm click", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(JSON.stringify({ killed: ["s1", "s2"], skipped: [], errors: [] }), {
        status: 200,
      }),
    );
    const onComplete = vi.fn();

    render(<StopAllButton sessionCount={2} onComplete={onComplete} />);

    // First click — enter confirmation
    fireEvent.click(screen.getByText("Stop All"));
    // Second click — confirm
    fireEvent.click(screen.getByText("Stop all 2"));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/sessions/kill-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    });

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalled();
    });
  });

  it("hides confirmation on cancel", () => {
    render(<StopAllButton sessionCount={3} />);
    fireEvent.click(screen.getByText("Stop All"));
    expect(screen.getByText("Cancel")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.getByText("Stop All")).toBeInTheDocument();
    expect(screen.queryByText("Cancel")).not.toBeInTheDocument();
  });

  it("handles API failure gracefully", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: "Server error" }), { status: 500 }),
    );

    render(<StopAllButton sessionCount={1} />);
    fireEvent.click(screen.getByText("Stop All"));
    fireEvent.click(screen.getByText("Stop all 1"));

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalled();
    });

    // Should return to normal state after failure
    await waitFor(() => {
      expect(screen.getByText("Stop All")).toBeInTheDocument();
    });

    consoleSpy.mockRestore();
  });
});
