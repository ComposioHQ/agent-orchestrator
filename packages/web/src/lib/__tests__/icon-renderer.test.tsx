import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { stringToHue, sanitizeIconName, renderIconElement } from "@/lib/icon-renderer";

// ── stringToHue ─────────────────────────────────────────────────────

describe("stringToHue", () => {
  it("returns the same hue for the same string", () => {
    const hue1 = stringToHue("my-project");
    const hue2 = stringToHue("my-project");
    expect(hue1).toBe(hue2);
  });

  it("returns a number in the range [0, 360)", () => {
    const inputs = ["", "a", "hello world", "very-long-project-name-12345", "!!!"];
    for (const input of inputs) {
      const hue = stringToHue(input);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it("returns different hues for different strings", () => {
    const hueA = stringToHue("project-alpha");
    const hueB = stringToHue("project-beta");
    expect(hueA).not.toBe(hueB);
  });

  it("handles empty string without throwing", () => {
    expect(() => stringToHue("")).not.toThrow();
    expect(typeof stringToHue("")).toBe("number");
  });

  it("returns 0 for empty string (hash is 0)", () => {
    expect(stringToHue("")).toBe(0);
  });
});

// ── sanitizeIconName ────────────────────────────────────────────────

describe("sanitizeIconName", () => {
  it("removes special characters", () => {
    expect(sanitizeIconName("my@project!#$")).toBe("myproject");
  });

  it("preserves word characters, spaces, and hyphens", () => {
    expect(sanitizeIconName("my project-name_1")).toBe("my project-name_1");
  });

  it("caps length at 50 characters", () => {
    const longName = "a".repeat(100);
    expect(sanitizeIconName(longName)).toHaveLength(50);
  });

  it("returns 'AO' for empty string", () => {
    expect(sanitizeIconName("")).toBe("AO");
  });

  it("returns 'AO' when all characters are special", () => {
    expect(sanitizeIconName("@#$%^&*()")).toBe("AO");
  });

  it("preserves a name that needs no sanitization", () => {
    expect(sanitizeIconName("clean-name")).toBe("clean-name");
  });
});

// ── renderIconElement ───────────────────────────────────────────────

describe("renderIconElement", () => {
  it("returns a valid React element", () => {
    const element = renderIconElement(32, "TestProject");
    expect(element).toBeTruthy();
    expect(typeof element).toBe("object");
  });

  it("renders the first letter of the name uppercased", () => {
    const { container } = render(renderIconElement(32, "hello"));
    expect(container.textContent).toBe("H");
  });

  it("renders 'A' when name is empty", () => {
    const { container } = render(renderIconElement(32, ""));
    expect(container.textContent).toBe("A");
  });

  it("applies correct size dimensions", () => {
    const { container } = render(renderIconElement(48, "test"));
    const div = container.firstElementChild as HTMLElement;
    expect(div.style.width).toBe("48px");
    expect(div.style.height).toBe("48px");
  });

  it("computes border radius as 19% of size", () => {
    const { container } = render(renderIconElement(100, "test"));
    const div = container.firstElementChild as HTMLElement;
    expect(div.style.borderRadius).toBe("19px");
  });

  it("computes font size as 62.5% of size", () => {
    const { container } = render(renderIconElement(80, "test"));
    const div = container.firstElementChild as HTMLElement;
    expect(div.style.fontSize).toBe("50px");
  });

  it("applies a non-empty background style derived from the name", () => {
    const { container } = render(renderIconElement(32, "alpha"));
    const div = container.firstElementChild as HTMLElement;
    // jsdom converts hsl(...) to rgb(...), so just verify a background is set
    expect(div.style.background).toBeTruthy();
    expect(div.style.background).toMatch(/rgb/);
  });

  it("produces different background colors for different names", () => {
    const { container: c1 } = render(renderIconElement(32, "alpha"));
    const { container: c2 } = render(renderIconElement(32, "beta"));
    const bg1 = (c1.firstElementChild as HTMLElement).style.background;
    const bg2 = (c2.firstElementChild as HTMLElement).style.background;
    expect(bg1).not.toBe(bg2);
  });
});
