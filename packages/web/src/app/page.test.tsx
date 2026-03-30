import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import Home from "@/app/page";

const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect,
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/",
}));

vi.mock("@/components/PortfolioPage", () => ({
  PortfolioPage: () => <div>portfolio stub</div>,
}));

vi.mock("@/lib/portfolio-services", () => ({
  getPortfolioServices: vi.fn(() => ({
    portfolio: [
      {
        id: "solo",
        name: "Solo Project",
        degraded: false,
      },
    ],
  })),
  getCachedPortfolioSessions: vi.fn(async () => []),
}));

vi.mock("@/lib/services", () => ({
  getServices: vi.fn(async () => ({ registry: null })),
  getSCM: vi.fn(),
}));

describe("app/page", () => {
  beforeEach(() => {
    redirect.mockClear();
  });

  it("renders the portfolio home without redirecting single-project users", async () => {
    render(await Home());

    expect(redirect).not.toHaveBeenCalled();
    expect(screen.getByText("portfolio stub")).toBeInTheDocument();
  });
});
