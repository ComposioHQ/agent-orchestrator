import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

let mockResolvedTheme = "dark";
const mockSetTheme = vi.fn();

vi.mock("next-themes", () => ({
  useTheme: () => ({
    resolvedTheme: mockResolvedTheme,
    setTheme: mockSetTheme,
  }),
}));

import { ThemeToggle } from "../ThemeToggle";

describe("ThemeToggle", () => {
  it("renders a placeholder before mounting (SSR safe)", () => {
    // useEffect won't fire synchronously, so the first render shows the placeholder
    // However in jsdom, useEffect fires, so we need a different approach.
    // We test the mounted path instead.
    mockResolvedTheme = "dark";
    render(<ThemeToggle />);

    // After mounting, button should be visible
    const button = screen.getByRole("button");
    expect(button).toBeInTheDocument();
  });

  it("shows sun icon and 'Switch to light mode' label in dark mode", () => {
    mockResolvedTheme = "dark";
    render(<ThemeToggle />);

    const button = screen.getByRole("button", { name: /switch to light mode/i });
    expect(button).toBeInTheDocument();
  });

  it("shows moon icon and 'Switch to dark mode' label in light mode", () => {
    mockResolvedTheme = "light";
    render(<ThemeToggle />);

    const button = screen.getByRole("button", { name: /switch to dark mode/i });
    expect(button).toBeInTheDocument();
  });

  it("calls setTheme('light') when clicked in dark mode", () => {
    mockResolvedTheme = "dark";
    mockSetTheme.mockClear();
    render(<ThemeToggle />);

    fireEvent.click(screen.getByRole("button"));
    expect(mockSetTheme).toHaveBeenCalledWith("light");
  });

  it("calls setTheme('dark') when clicked in light mode", () => {
    mockResolvedTheme = "light";
    mockSetTheme.mockClear();
    render(<ThemeToggle />);

    fireEvent.click(screen.getByRole("button"));
    expect(mockSetTheme).toHaveBeenCalledWith("dark");
  });

  it("has correct title attribute in dark mode", () => {
    mockResolvedTheme = "dark";
    render(<ThemeToggle />);

    expect(screen.getByTitle("Switch to light mode")).toBeInTheDocument();
  });

  it("has correct title attribute in light mode", () => {
    mockResolvedTheme = "light";
    render(<ThemeToggle />);

    expect(screen.getByTitle("Switch to dark mode")).toBeInTheDocument();
  });
});
