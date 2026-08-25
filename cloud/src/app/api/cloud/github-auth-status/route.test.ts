import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withAuth: vi.fn(),
}));

vi.mock("@workos-inc/authkit-nextjs", () => ({
  withAuth: mocks.withAuth,
}));

import { GET } from "./route";

beforeEach(() => {
  mocks.withAuth.mockReset();
});

it("reports whether a hosted identity is available without returning 401", async () => {
  mocks.withAuth.mockResolvedValue({ user: null, accessToken: undefined });
  const disconnected = await GET();
  expect(disconnected.status).toBe(200);
  await expect(disconnected.json()).resolves.toEqual({ authenticated: false });

  mocks.withAuth.mockResolvedValue({
    user: { id: "user-1" },
    accessToken: "workos-token",
  });
  const connected = await GET();
  expect(connected.status).toBe(200);
  await expect(connected.json()).resolves.toEqual({ authenticated: true });
});
