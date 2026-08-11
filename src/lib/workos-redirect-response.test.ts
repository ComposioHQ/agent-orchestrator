import { describe, expect, it } from "vitest";

import { workOSRedirectResponse } from "./workos-redirect-response";

describe("workOSRedirectResponse", () => {
  it("returns a no-store redirect interstitial", async () => {
    const response = workOSRedirectResponse("https://auth.example.com/start?a=1&b=2");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const body = await response.text();
    expect(body).toContain("Opening secure sign-in");
    expect(body).toContain("https://auth.example.com/start?a=1&amp;b=2");
  });
});
