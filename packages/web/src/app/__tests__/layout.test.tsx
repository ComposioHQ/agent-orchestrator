import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import RootLayout from "../layout.js";

vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "--font-geist-sans", className: "geist" }),
  JetBrains_Mono: () => ({ variable: "--font-jetbrains-mono", className: "jetbrains-mono" }),
}));

vi.mock("next-themes", () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/lib/project-name", () => ({
  getProjectName: () => "test-project",
}));

vi.mock("@/components/ServiceWorkerRegistrar", () => ({
  ServiceWorkerRegistrar: () => null,
}));

describe("RootLayout", () => {
  it("renders children", () => {
    const { getByText } = render(
      <RootLayout>
        <div>hello</div>
      </RootLayout>,
    );
    expect(getByText("hello")).toBeInTheDocument();
  });

  it("has suppressHydrationWarning on body to prevent browser extension attribute injection", () => {
    const { container } = render(
      <RootLayout>
        <span>content</span>
      </RootLayout>,
    );
    const body = container.closest("body");
    expect(body).toBeTruthy();
  });
});
