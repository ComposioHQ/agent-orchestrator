import { describe, expect, it, vi, beforeEach } from "vitest";

// sessions/[id]/page.tsx is now a redirect-only server component.
// It redirects to /projects/:projectId/sessions/:id based on portfolio lookup.

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

vi.mock("@/lib/portfolio-services", () => ({
  getPortfolioServices: vi.fn().mockReturnValue({ portfolio: [] }),
  getCachedPortfolioSessions: vi.fn().mockResolvedValue([]),
}));

import { redirect } from "next/navigation";
import { getPortfolioServices, getCachedPortfolioSessions } from "@/lib/portfolio-services";
import LegacySessionPage from "./page";

beforeEach(() => {
  vi.mocked(redirect)
    .mockReset()
    .mockImplementation(((url: string): never => {
      throw new Error(`REDIRECT:${url}`);
    }) as unknown as typeof redirect);
  vi.mocked(getPortfolioServices)
    .mockReset()
    .mockReturnValue({ portfolio: [] } as ReturnType<typeof getPortfolioServices>);
  vi.mocked(getCachedPortfolioSessions).mockReset().mockResolvedValue([]);
});

describe("LegacySessionPage redirects", () => {
  it("redirects to /projects/:projectId/sessions/:id when session is found in portfolio", async () => {
    vi.mocked(getCachedPortfolioSessions).mockResolvedValue([
      {
        session: { id: "worker-1" },
        project: { id: "my-app" },
      },
    ] as Awaited<ReturnType<typeof getCachedPortfolioSessions>>);

    await LegacySessionPage({ params: Promise.resolve({ id: "worker-1" }) }).catch(() => {});

    expect(redirect).toHaveBeenCalledWith("/projects/my-app/sessions/worker-1");
  });

  it("redirects using session prefix when session is not in cached list", async () => {
    vi.mocked(getPortfolioServices).mockReturnValue({
      portfolio: [{ id: "my-app", sessionPrefix: "worker" }],
    } as ReturnType<typeof getPortfolioServices>);

    await LegacySessionPage({ params: Promise.resolve({ id: "worker-5" }) }).catch(() => {});

    expect(redirect).toHaveBeenCalledWith("/projects/my-app/sessions/worker-5");
  });

  it("redirects to / when nothing matches", async () => {
    await LegacySessionPage({ params: Promise.resolve({ id: "unknown-99" }) }).catch(() => {});

    expect(redirect).toHaveBeenCalledWith("/");
  });
});
