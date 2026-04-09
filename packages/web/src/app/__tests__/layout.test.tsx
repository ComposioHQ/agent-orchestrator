import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import RootLayout from "../layout.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
    // suppressHydrationWarning is a React prop — it doesn't become a DOM attribute,
    // so we assert its presence in the source to guard against accidental removal.
    const src = readFileSync(resolve(__dirname, "../layout.tsx"), "utf-8");
    expect(src).toMatch(/<body[^>]*suppressHydrationWarning/);
  });
});
