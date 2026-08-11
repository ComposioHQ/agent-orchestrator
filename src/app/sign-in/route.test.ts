import { beforeEach, expect, it, vi } from "vitest";

const { getSignInUrl, redirect } = vi.hoisted(() => ({
  getSignInUrl: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@workos-inc/authkit-nextjs", () => ({ getSignInUrl }));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/cloud-config", () => ({
  cloudWebMode: () => "staging",
  workosRedirectUri: () => "http://localhost:3000/callback",
}));

import { GET } from "./route";

beforeEach(() => {
  getSignInUrl.mockReset();
  redirect.mockReset();
});

it("binds the WorkOS authorization request to the configured callback", async () => {
  getSignInUrl.mockResolvedValue("https://api.workos.com/authorize");

  await GET();

  expect(getSignInUrl).toHaveBeenCalledWith({
    redirectUri: "http://localhost:3000/callback",
    returnTo: "/app",
  });
  expect(redirect).toHaveBeenCalledWith("https://api.workos.com/authorize");
});
