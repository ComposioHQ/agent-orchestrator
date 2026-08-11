import { afterEach, expect, it, vi } from "vitest";

const authkitMiddleware = vi.hoisted(() => vi.fn((options) => options));

vi.mock("@workos-inc/authkit-nextjs", () => ({ authkitMiddleware }));

afterEach(() => {
  vi.resetModules();
  authkitMiddleware.mockClear();
  delete process.env.NEXT_PUBLIC_AO_AUTH_MODE;
  delete process.env.NEXT_PUBLIC_WEB_URL;
  delete process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI;
});

it("provides AuthKit a callback derived from the web origin", async () => {
  process.env.NEXT_PUBLIC_AO_AUTH_MODE = "workos";
  process.env.NEXT_PUBLIC_WEB_URL = "https://cloud.example.com";

  await import("./proxy");

  expect(authkitMiddleware).toHaveBeenCalledWith({
    redirectUri: "https://cloud.example.com/callback",
  });
});

it("honors an explicit WorkOS redirect URI", async () => {
  process.env.NEXT_PUBLIC_AO_AUTH_MODE = "workos";
  process.env.NEXT_PUBLIC_WEB_URL = "https://cloud.example.com";
  process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI =
    "https://auth.example.com/workos/callback";

  await import("./proxy");

  expect(authkitMiddleware).toHaveBeenCalledWith({
    redirectUri: "https://auth.example.com/workos/callback",
  });
});

it("does not initialize AuthKit middleware in local auth mode", async () => {
  process.env.NEXT_PUBLIC_AO_AUTH_MODE = "local";

  await import("./proxy");

  expect(authkitMiddleware).not.toHaveBeenCalled();
});
