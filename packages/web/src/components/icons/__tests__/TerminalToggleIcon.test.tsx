import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { TerminalToggleIcon } from "@/components/icons/TerminalToggleIcon";

describe("TerminalToggleIcon", () => {
  it("renders an svg with default size", () => {
    const { container } = render(<TerminalToggleIcon />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute("width")).toBe("14");
    expect(svg?.getAttribute("height")).toBe("14");
  });

  it("respects custom size", () => {
    const { container } = render(<TerminalToggleIcon size={18} />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("18");
    expect(svg?.getAttribute("height")).toBe("18");
  });
});
