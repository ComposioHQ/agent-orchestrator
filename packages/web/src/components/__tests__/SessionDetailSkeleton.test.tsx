import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionDetailSkeleton } from "../SessionDetailSkeleton";

describe("SessionDetailSkeleton", () => {
  it("renders a stable page shell with header and terminal placeholders", () => {
    const { container } = render(<SessionDetailSkeleton />);

    // Header section with breadcrumb separator
    expect(screen.getByText("/")).toBeInTheDocument();

    // Should have the session-page-header class for layout stability
    expect(container.querySelector(".session-page-header")).toBeInTheDocument();

    // Should have multiple animated skeleton bones
    const bones = container.querySelectorAll(".animate-pulse");
    expect(bones.length).toBeGreaterThanOrEqual(4);
  });
});
