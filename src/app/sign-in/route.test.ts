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

function request(returnTo = "") {
  const url = new URL("http://localhost:3000/sign-in");
  if (returnTo) url.searchParams.set("returnTo", returnTo);
  return { nextUrl: url } as never;
}

beforeEach(() => {
  getSignInUrl.mockReset();
  redirect.mockReset();
});

it("binds the WorkOS authorization request to the configured callback", async () => {
  getSignInUrl.mockResolvedValue("https://api.workos.com/authorize");

  await GET(request());

  expect(getSignInUrl).toHaveBeenCalledWith({
    redirectUri: "http://localhost:3000/callback",
    returnTo: "/app",
  });
  expect(redirect).toHaveBeenCalledWith("https://api.workos.com/authorize");
});

it("preserves a same-origin shared-session return path", async () => {
  getSignInUrl.mockResolvedValue("https://api.workos.com/authorize");

  await GET(request("/app?shareOrg=org-1&share=secret-token"));

  expect(getSignInUrl).toHaveBeenCalledWith({
    redirectUri: "http://localhost:3000/callback",
    returnTo: "/app?shareOrg=org-1&share=secret-token",
  });
});

it("rejects an external return path", async () => {
  getSignInUrl.mockResolvedValue("https://api.workos.com/authorize");

  await GET(request("https://attacker.example/app"));

  expect(getSignInUrl).toHaveBeenCalledWith({
    redirectUri: "http://localhost:3000/callback",
    returnTo: "/app",
  });
});
