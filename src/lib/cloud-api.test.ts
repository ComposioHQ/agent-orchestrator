import { afterEach, expect, it, vi } from "vitest";

import { CloudAPI } from "./cloud-api";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_API_URL: "https://cloud.example.com",
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

it("uses the source auth endpoints for login and signup", async () => {
  const fetchMock = vi
    .fn()
    .mockImplementation(() => Promise.resolve(
      new Response(
        JSON.stringify({
          accessToken: "token",
          user: { id: "user-one", email: "dev@example.com", displayName: "Dev" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ));
  vi.stubGlobal("fetch", fetchMock);

  await CloudAPI.login({ email: "dev@example.com", password: "password" });
  await CloudAPI.signUp({
    email: "dev@example.com",
    password: "password",
    displayName: "Dev",
  });

  expect(fetchMock).toHaveBeenNthCalledWith(
    1,
    "https://cloud.example.com/api/cloud/v1/auth/login",
    expect.objectContaining({ method: "POST" }),
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    "https://cloud.example.com/api/cloud/v1/auth/signup",
    expect.objectContaining({ method: "POST" }),
  );
});
