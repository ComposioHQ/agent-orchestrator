import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "../Terminal";

describe("Terminal", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          url: "http://localhost:14800/terminal?session=ao-77#token=demo-token",
          token: "demo-token",
        }),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("loads the iframe terminal URL and supports fullscreen toggling", async () => {
    const { container } = render(<Terminal sessionId="ao-77" />);

    await waitFor(() =>
      expect(screen.getByTitle("Terminal: ao-77")).toHaveAttribute(
        "src",
        "http://localhost:14800/terminal?session=ao-77#token=demo-token",
      ),
    );

    expect(fetch).toHaveBeenCalledWith(
      "/api/sessions/ao-77/terminal",
      { cache: "no-store" },
    );

    fireEvent.click(screen.getByRole("button", { name: "fullscreen" }));
    expect(container.firstChild).toHaveClass("fixed", "inset-0");
    expect(screen.getByRole("button", { name: "exit fullscreen" })).toBeInTheDocument();
  });
});
