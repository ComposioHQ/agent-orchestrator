import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { ToastProvider, useToast } from "@/components/Toast";

// Helper component that exposes showToast via a button
function ToastTrigger({
  message = "Test message",
  variant,
}: {
  message?: string;
  variant?: "success" | "error" | "info";
}) {
  const { showToast } = useToast();
  return (
    <button onClick={() => showToast(message, variant)}>
      trigger
    </button>
  );
}

describe("ToastProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders children", () => {
    render(
      <ToastProvider>
        <span>child content</span>
      </ToastProvider>,
    );
    expect(screen.getByText("child content")).toBeInTheDocument();
  });

  it("renders a toast-container div", () => {
    const { container } = render(
      <ToastProvider>
        <span>hello</span>
      </ToastProvider>,
    );
    expect(container.querySelector(".toast-container")).toBeInTheDocument();
  });

  it("does not show a toast initially", () => {
    const { container } = render(
      <ToastProvider>
        <span>hello</span>
      </ToastProvider>,
    );
    expect(container.querySelector(".toast")).not.toBeInTheDocument();
  });
});

describe("useToast", () => {
  it("throws when used outside ToastProvider", () => {
    // Suppress console.error for this test since React logs the error
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    function BadComponent() {
      useToast();
      return null;
    }

    expect(() => render(<BadComponent />)).toThrow(
      "useToast must be used within a ToastProvider",
    );

    spy.mockRestore();
  });
});

describe("showToast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a toast with the correct message", () => {
    render(
      <ToastProvider>
        <ToastTrigger message="Hello world" />
      </ToastProvider>,
    );

    act(() => {
      screen.getByText("trigger").click();
    });

    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("defaults to info variant", () => {
    const { container } = render(
      <ToastProvider>
        <ToastTrigger message="Info toast" />
      </ToastProvider>,
    );

    act(() => {
      screen.getByText("trigger").click();
    });

    expect(container.querySelector(".toast--info")).toBeInTheDocument();
  });

  it("applies success variant class", () => {
    const { container } = render(
      <ToastProvider>
        <ToastTrigger message="Success!" variant="success" />
      </ToastProvider>,
    );

    act(() => {
      screen.getByText("trigger").click();
    });

    expect(container.querySelector(".toast--success")).toBeInTheDocument();
  });

  it("applies error variant class", () => {
    const { container } = render(
      <ToastProvider>
        <ToastTrigger message="Error!" variant="error" />
      </ToastProvider>,
    );

    act(() => {
      screen.getByText("trigger").click();
    });

    expect(container.querySelector(".toast--error")).toBeInTheDocument();
  });

  it("auto-hides after 3000ms timeout", () => {
    render(
      <ToastProvider>
        <ToastTrigger message="Disappearing" />
      </ToastProvider>,
    );

    act(() => {
      screen.getByText("trigger").click();
    });

    expect(screen.getByText("Disappearing")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(screen.queryByText("Disappearing")).not.toBeInTheDocument();
  });

  it("does not auto-hide before 3000ms", () => {
    render(
      <ToastProvider>
        <ToastTrigger message="Still here" />
      </ToastProvider>,
    );

    act(() => {
      screen.getByText("trigger").click();
    });

    act(() => {
      vi.advanceTimersByTime(2999);
    });

    expect(screen.getByText("Still here")).toBeInTheDocument();
  });

  it("resets timer when showToast is called again", () => {
    function MultiTrigger() {
      const { showToast } = useToast();
      return (
        <>
          <button onClick={() => showToast("First")}>first</button>
          <button onClick={() => showToast("Second")}>second</button>
        </>
      );
    }

    render(
      <ToastProvider>
        <MultiTrigger />
      </ToastProvider>,
    );

    // Show first toast
    act(() => {
      screen.getByText("first").click();
    });
    expect(screen.getByText("First")).toBeInTheDocument();

    // Advance 2 seconds, then show second toast (resets timer)
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    act(() => {
      screen.getByText("second").click();
    });
    expect(screen.getByText("Second")).toBeInTheDocument();
    expect(screen.queryByText("First")).not.toBeInTheDocument();

    // Advance 2 more seconds — second toast should still be visible
    // (only 2s since it was shown, timer was reset)
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText("Second")).toBeInTheDocument();

    // Advance another 1s to reach 3s total — should hide
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByText("Second")).not.toBeInTheDocument();
  });

  it("renders icon and message spans inside the toast", () => {
    const { container } = render(
      <ToastProvider>
        <ToastTrigger message="Structured toast" />
      </ToastProvider>,
    );

    act(() => {
      screen.getByText("trigger").click();
    });

    expect(container.querySelector(".toast__icon")).toBeInTheDocument();
    expect(container.querySelector(".toast__message")).toBeInTheDocument();
    expect(container.querySelector(".toast__message")?.textContent).toBe("Structured toast");
  });

  it("has correct accessibility attributes on the container", () => {
    const { container } = render(
      <ToastProvider>
        <ToastTrigger />
      </ToastProvider>,
    );

    const toastContainer = container.querySelector(".toast-container");
    expect(toastContainer?.getAttribute("role")).toBe("status");
    expect(toastContainer?.getAttribute("aria-live")).toBe("polite");
    expect(toastContainer?.getAttribute("aria-atomic")).toBe("true");
  });
});
