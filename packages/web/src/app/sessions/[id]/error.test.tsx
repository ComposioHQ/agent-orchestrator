import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    ...props
  }: React.PropsWithChildren<React.AnchorHTMLAttributes<HTMLAnchorElement>>) => (
    <a {...props}>{children}</a>
  ),
}));

import SessionError from "./error";

describe("Session error boundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    refresh.mockClear();
  });

  it("retries with reset and router refresh", () => {
    const reset = vi.fn();

    render(<SessionError error={new Error("HTTP 500")} reset={reset} />);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(reset).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("shows a session-specific message", () => {
    render(<SessionError error={new Error("HTTP 500")} reset={vi.fn()} />);

    expect(
      screen.getByText(
        "The server returned an internal error while loading this session. Try re-fetching the session data.",
      ),
    ).toBeInTheDocument();
  });
});
