import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProjectMetric } from "@/components/ProjectMetric";

describe("ProjectMetric", () => {
  it("renders label and value", () => {
    render(<ProjectMetric label="Merge" value={3} tone="var(--color-status-ready)" />);

    expect(screen.getByText("Merge")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("applies tone as inline color style", () => {
    render(<ProjectMetric label="Respond" value={1} tone="var(--color-status-error)" />);

    const valueEl = screen.getByText("1");
    expect(valueEl).toHaveStyle({ color: "var(--color-status-error)" });
  });

  it("renders zero value", () => {
    render(<ProjectMetric label="Working" value={0} tone="var(--color-status-working)" />);

    expect(screen.getByText("0")).toBeInTheDocument();
  });
});
