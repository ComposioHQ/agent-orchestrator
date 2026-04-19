import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ToastProvider } from "../Toast";
import { CopyDebugBundleButton } from "../CopyDebugBundleButton";

const writeText = vi.fn(() => Promise.resolve());

describe("CopyDebugBundleButton", () => {
  beforeEach(() => {
    writeText.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          headers: { get: (name: string) => (name === "x-correlation-id" ? "corr-test" : null) },
          json: () => Promise.resolve({ overallStatus: "ok", projects: {} }),
        } as Response),
      ),
    );
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("copies observability JSON and shows success toast", async () => {
    render(
      <ToastProvider>
        <CopyDebugBundleButton projectId="my-app" />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Copy debug bundle for issue reports/i }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalled();
    });

    const written = JSON.parse(writeText.mock.calls[0][0] as string);
    expect(written.projectId).toBe("my-app");
    expect(written.correlationId).toBe("corr-test");
    expect(written.observability).toEqual({ overallStatus: "ok", projects: {} });

    await waitFor(() => {
      expect(screen.getByText(/Debug bundle copied to clipboard/i)).toBeInTheDocument();
    });
  });
});
