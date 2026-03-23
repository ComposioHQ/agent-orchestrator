import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ActivityDisplay } from "@/components/ActivityDisplay";

describe("ActivityDisplay", () => {
  it("renders the label text", () => {
    render(<ActivityDisplay activity="active" label="Active" color="var(--color-status-working)" />);
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("renders with null activity", () => {
    render(<ActivityDisplay activity={null} label="unknown" color="var(--color-text-muted)" />);
    expect(screen.getByText("unknown")).toBeInTheDocument();
  });

  it("applies dynamic color via style attribute", () => {
    const { container } = render(
      <ActivityDisplay activity="blocked" label="Blocked" color="var(--color-status-error)" />,
    );
    const badge = container.firstChild as HTMLElement;
    expect(badge.style.background).toContain("color-mix");
    expect(badge.style.border).toContain("color-mix");
  });
});
