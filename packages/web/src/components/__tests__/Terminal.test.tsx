import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Terminal } from "../Terminal";

beforeEach(() => {
  vi.restoreAllMocks();
  // Mock window.location
  Object.defineProperty(window, "location", {
    value: { protocol: "http:", hostname: "localhost" },
    writable: true,
  });
});

describe("Terminal", () => {
  it("renders connecting state initially", () => {
    global.fetch = vi.fn(() => new Promise(() => {})); // never resolves
    render(<Terminal sessionId="ses-1" />);

    expect(screen.getByText("ses-1")).toBeInTheDocument();
    expect(screen.getByText("Connecting...")).toBeInTheDocument();
  });

  it("shows connected state after successful fetch", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ url: "http://localhost:14800/ws/ses-1" }),
    });

    render(<Terminal sessionId="ses-1" />);

    await waitFor(() => {
      expect(screen.getByText("Connected")).toBeInTheDocument();
    });

    // Should render iframe
    const iframe = screen.getByTitle("Terminal: ses-1");
    expect(iframe).toBeInTheDocument();
    expect(iframe).toHaveAttribute("src", "http://localhost:14800/ws/ses-1");
  });

  it("shows error state on fetch failure", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    render(<Terminal sessionId="ses-1" />);

    await waitFor(() => {
      // Error text appears in both status bar and content area
      const errorMessages = screen.getAllByText("Failed to connect to terminal server");
      expect(errorMessages.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("shows error state on non-ok response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    render(<Terminal sessionId="ses-1" />);

    await waitFor(() => {
      const errorMessages = screen.getAllByText("Failed to connect to terminal server");
      expect(errorMessages.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("toggles fullscreen on button click", () => {
    global.fetch = vi.fn(() => new Promise(() => {}));

    render(<Terminal sessionId="ses-1" />);

    const button = screen.getByText("fullscreen");
    fireEvent.click(button);
    expect(screen.getByText("exit fullscreen")).toBeInTheDocument();

    fireEvent.click(screen.getByText("exit fullscreen"));
    expect(screen.getByText("fullscreen")).toBeInTheDocument();
  });

  it("encodes sessionId in fetch URL", () => {
    const fetchMock = vi.fn(() => new Promise(() => {}));
    global.fetch = fetchMock;

    render(<Terminal sessionId="ses/special chars" />);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("ses%2Fspecial%20chars"),
    );
  });

  it("uses NEXT_PUBLIC_TERMINAL_PORT env variable", () => {
    const originalEnv = process.env.NEXT_PUBLIC_TERMINAL_PORT;
    process.env.NEXT_PUBLIC_TERMINAL_PORT = "9999";
    const fetchMock = vi.fn(() => new Promise(() => {}));
    global.fetch = fetchMock;

    render(<Terminal sessionId="ses-1" />);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(":9999/"),
    );

    // Restore
    if (originalEnv !== undefined) {
      process.env.NEXT_PUBLIC_TERMINAL_PORT = originalEnv;
    } else {
      delete process.env.NEXT_PUBLIC_TERMINAL_PORT;
    }
  });

  it("shows error message in both status and content areas", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("fail"));

    render(<Terminal sessionId="ses-1" />);

    await waitFor(() => {
      // Error message appears in both status bar text and content placeholder
      const msgs = screen.getAllByText("Failed to connect to terminal server");
      expect(msgs).toHaveLength(2);
    });
  });

  it("shows placeholder message when not connected and no error", () => {
    global.fetch = vi.fn(() => new Promise(() => {}));
    render(<Terminal sessionId="ses-1" />);

    expect(screen.getByText("Connecting to terminal...")).toBeInTheDocument();
  });

  it("shows Connected text when connected", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ url: "http://localhost:14800/ws/test" }),
    });

    render(<Terminal sessionId="test" />);

    await waitFor(() => {
      expect(screen.getByText("Connected")).toBeInTheDocument();
    });
  });

  it("renders iframe with correct sandbox attributes", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ url: "http://localhost:14800/ws/ses-1" }),
    });

    render(<Terminal sessionId="ses-1" />);

    await waitFor(() => {
      const iframe = screen.getByTitle("Terminal: ses-1");
      expect(iframe).toHaveAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups");
      expect(iframe).toHaveAttribute("allow", "clipboard-read; clipboard-write");
    });
  });
});
