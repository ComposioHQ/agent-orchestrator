import { expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  cookieValue: undefined as string | undefined,
  redirect: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (mocks.cookieValue ? { value: mocks.cookieValue } : undefined),
  }),
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/cloud-config", () => ({
  cloudApiBaseUrl: () => "http://127.0.0.1:8081",
  cloudWebMode: () => "local",
  localAuthCookie: "ao_cloud_local_session",
}));

import CloudEntryPage from "./page";

beforeEach(() => {
  mocks.cookieValue = undefined;
  mocks.redirect.mockReset();
  vi.restoreAllMocks();
});

it("shows local sign-in when there is no durable session cookie", async () => {
  const page = await CloudEntryPage();

  expect(mocks.redirect).not.toHaveBeenCalled();
  expect(page.props.mode).toBe("local");
});

it("opens the workspace when the persisted local session remains valid", async () => {
  mocks.cookieValue = "persisted-token";
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(null, { status: 200 }));

  await CloudEntryPage();

  expect(fetchMock).toHaveBeenCalledWith(
    "http://127.0.0.1:8081/api/cloud/v1/me",
    expect.objectContaining({
      headers: { Authorization: "Bearer persisted-token" },
      cache: "no-store",
    }),
  );
  expect(mocks.redirect).toHaveBeenCalledWith("/app");
});
