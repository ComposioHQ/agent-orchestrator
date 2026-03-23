import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RateLimitBanner } from "@/components/RateLimitBanner";

describe("RateLimitBanner", () => {
  it("renders rate limit warning message", () => {
    render(<RateLimitBanner onDismiss={vi.fn()} />);

    expect(screen.getByText(/GitHub API rate limited/)).toBeInTheDocument();
  });

  it("calls onDismiss when dismiss button is clicked", () => {
    const onDismiss = vi.fn();

    render(<RateLimitBanner onDismiss={onDismiss} />);

    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
