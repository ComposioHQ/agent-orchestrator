import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmptyState } from "@/components/EmptyState";

describe("EmptyState", () => {
  it("renders message text", () => {
    render(<EmptyState message="No sessions found" />);
    expect(screen.getByText("No sessions found")).toBeInTheDocument();
  });

  it("renders description when provided", () => {
    render(
      <EmptyState
        message="No sessions"
        description="Spawn an orchestrator to create sessions."
      />,
    );
    expect(screen.getByText("Spawn an orchestrator to create sessions.")).toBeInTheDocument();
  });

  it("renders icon when provided", () => {
    render(
      <EmptyState
        message="Empty"
        icon={<span data-testid="test-icon">icon</span>}
      />,
    );
    expect(screen.getByTestId("test-icon")).toBeInTheDocument();
  });

  it("renders action when provided", () => {
    render(
      <EmptyState
        message="No data"
        action={<button>Do something</button>}
      />,
    );
    expect(screen.getByRole("button", { name: "Do something" })).toBeInTheDocument();
  });

  it("does not render description when not provided", () => {
    const { container } = render(<EmptyState message="Just a message" />);
    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs).toHaveLength(1);
  });

  it("does not render action container when not provided", () => {
    const { container } = render(<EmptyState message="No action" />);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
});
