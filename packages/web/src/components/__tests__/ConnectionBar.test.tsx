import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConnectionBar } from "@/components/ConnectionBar";

describe("ConnectionBar", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders null when status is connected", () => {
    const { container } = render(<ConnectionBar status="connected" />);
    expect(container.innerHTML).toBe("");
  });

  it("renders a button when status is disconnected", () => {
    render(<ConnectionBar status="disconnected" />);
    const button = screen.getByRole("button");
    expect(button).toBeInTheDocument();
    expect(button.textContent).toContain("Offline");
    expect(button.textContent).toContain("tap to retry");
  });

  it("has the correct CSS class when disconnected", () => {
    render(<ConnectionBar status="disconnected" />);
    const button = screen.getByRole("button");
    expect(button.className).toContain("connection-bar--disconnected");
  });

  it("has assertive aria-live when disconnected", () => {
    render(<ConnectionBar status="disconnected" />);
    const button = screen.getByRole("button");
    expect(button.getAttribute("aria-live")).toBe("assertive");
    expect(button.getAttribute("aria-atomic")).toBe("true");
  });

  it("triggers window.location.reload on button click", () => {
    // Mock window.location.reload
    const reloadMock = vi.fn();
    Object.defineProperty(window, "location", {
      writable: true,
      value: { ...window.location, reload: reloadMock },
    });

    render(<ConnectionBar status="disconnected" />);
    fireEvent.click(screen.getByRole("button"));
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it("renders a div with status role when reconnecting", () => {
    render(<ConnectionBar status="reconnecting" />);
    const statusEl = screen.getByRole("status");
    expect(statusEl).toBeInTheDocument();
    expect(statusEl.tagName).toBe("DIV");
  });

  it("shows 'Reconnecting' text when reconnecting", () => {
    render(<ConnectionBar status="reconnecting" />);
    expect(screen.getByText(/Reconnecting/)).toBeInTheDocument();
  });

  it("has the correct CSS class when reconnecting", () => {
    render(<ConnectionBar status="reconnecting" />);
    const statusEl = screen.getByRole("status");
    expect(statusEl.className).toContain("connection-bar--reconnecting");
  });

  it("has polite aria-live when reconnecting", () => {
    render(<ConnectionBar status="reconnecting" />);
    const statusEl = screen.getByRole("status");
    expect(statusEl.getAttribute("aria-live")).toBe("polite");
    expect(statusEl.getAttribute("aria-atomic")).toBe("true");
  });
});
