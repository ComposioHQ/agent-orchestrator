import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SkeletonBlock, EmptyState, ErrorState } from "../Skeleton";

describe("SkeletonBlock", () => {
  it("renders a div with animate-pulse", () => {
    const { container } = render(<SkeletonBlock className="h-4 w-32" />);
    const el = container.firstChild as HTMLElement;
    expect(el.tagName).toBe("DIV");
    expect(el.className).toContain("animate-pulse");
    expect(el.className).toContain("h-4");
  });
});

describe("EmptyState", () => {
  it("renders the default message", () => {
    render(<EmptyState />);
    expect(screen.getByText(/No sessions running/i)).toBeInTheDocument();
    expect(screen.getByText("ao start")).toBeInTheDocument();
  });

  it("renders a custom message", () => {
    render(<EmptyState message="Nothing here yet." />);
    expect(screen.getByText("Nothing here yet.")).toBeInTheDocument();
  });
});

describe("ErrorState", () => {
  it("renders the error message", () => {
    render(<ErrorState message="Failed to load session" />);
    expect(screen.getByText("Failed to load session")).toBeInTheDocument();
  });

  it("renders a retry button and calls onRetry when clicked", () => {
    const onRetry = vi.fn();
    render(<ErrorState message="Oops" onRetry={onRetry} />);
    const btn = screen.getByRole("button", { name: /retry/i });
    fireEvent.click(btn);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("does not render retry button when onRetry is not provided", () => {
    render(<ErrorState message="Oops" />);
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });
});
