import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import SessionLoading from "./loading";

describe("SessionLoading", () => {
  it("renders the skeleton shell with a stable header placeholder", () => {
    const { container } = render(<SessionLoading />);
    expect(container.querySelector(".session-page-header")).toBeInTheDocument();
  });

  it("renders animated skeleton bones instead of a spinner", () => {
    const { container } = render(<SessionLoading />);
    const bones = container.querySelectorAll(".animate-pulse");
    expect(bones.length).toBeGreaterThanOrEqual(4);
    expect(container.querySelector(".animate-spin")).not.toBeInTheDocument();
  });
});
