import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { ServiceWorkerRegistrar } from "@/components/ServiceWorkerRegistrar";

describe("ServiceWorkerRegistrar", () => {
  let originalDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.restoreAllMocks();
    originalDescriptor = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
  });

  afterEach(() => {
    // Restore the original serviceWorker property
    if (originalDescriptor) {
      Object.defineProperty(navigator, "serviceWorker", originalDescriptor);
    } else {
      // If there was no own property, delete any we defined
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (navigator as Record<string, unknown>).serviceWorker;
    }
  });

  it("renders null (no visible output)", () => {
    // Provide a mock so it doesn't crash
    const registerMock = vi.fn().mockResolvedValue({});
    Object.defineProperty(navigator, "serviceWorker", {
      value: { register: registerMock },
      writable: true,
      configurable: true,
    });

    const { container } = render(<ServiceWorkerRegistrar />);
    expect(container.innerHTML).toBe("");
  });

  it("calls navigator.serviceWorker.register with /sw.js", () => {
    const registerMock = vi.fn().mockResolvedValue({});
    Object.defineProperty(navigator, "serviceWorker", {
      value: { register: registerMock },
      writable: true,
      configurable: true,
    });

    render(<ServiceWorkerRegistrar />);

    expect(registerMock).toHaveBeenCalledWith("/sw.js");
    expect(registerMock).toHaveBeenCalledTimes(1);
  });

  it("does not call register when serviceWorker is not in navigator", () => {
    // Remove serviceWorker from navigator entirely so "serviceWorker" in navigator is false
    Object.defineProperty(navigator, "serviceWorker", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    // Now delete it so the `in` check is false
    delete (navigator as Record<string, unknown>).serviceWorker;

    // Should not throw
    expect(() => render(<ServiceWorkerRegistrar />)).not.toThrow();
  });

  it("handles registration failure gracefully", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const registerMock = vi.fn().mockRejectedValue(new Error("SW failed"));
    Object.defineProperty(navigator, "serviceWorker", {
      value: { register: registerMock },
      writable: true,
      configurable: true,
    });

    render(<ServiceWorkerRegistrar />);

    // The error will be handled asynchronously
    expect(registerMock).toHaveBeenCalledWith("/sw.js");

    // Wait for the rejection handler to run
    await vi.waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Service worker registration failed:",
        expect.any(Error),
      );
    });

    consoleErrorSpy.mockRestore();
  });
});
