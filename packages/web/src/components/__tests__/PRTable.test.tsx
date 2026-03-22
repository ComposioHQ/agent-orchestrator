import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PRTable } from "@/components/PRTable";
import { makePR } from "@/__tests__/helpers";

describe("PRTable", () => {
  it("renders nothing when openPRs is empty", () => {
    const { container } = render(<PRTable openPRs={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a table with PR rows", () => {
    const prs = [makePR({ number: 42, title: "Fix bug" }), makePR({ number: 43, title: "Add feature" })];
    render(<PRTable openPRs={prs} />);

    expect(screen.getByText("Pull Requests")).toBeInTheDocument();
    expect(screen.getByText("#42")).toBeInTheDocument();
    expect(screen.getByText("#43")).toBeInTheDocument();
  });
});
