import type * as cryptoModule from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockTimingSafeEqual = vi.fn();

describe("api-auth", () => {
  beforeEach(() => {
    vi.resetModules();
    mockTimingSafeEqual.mockReset();
    mockTimingSafeEqual.mockReturnValue(true);
  });

  it("uses timingSafeEqual for bearer token comparison", async () => {
    mockTimingSafeEqual.mockReturnValueOnce(false);

    vi.doMock("node:crypto", async (importOriginal) => {
      const actual = await importOriginal<typeof cryptoModule>();
      return {
        ...actual,
        timingSafeEqual: mockTimingSafeEqual,
      };
    });

    const { checkAuth } = await import("../api-auth");
    const result = checkAuth(
      new Request("http://localhost/api/ao/status", {
        headers: { authorization: "Bearer secret-tokem" },
      }),
      "secret-token",
    );

    expect(result?.status).toBe(401);
    expect(mockTimingSafeEqual).toHaveBeenCalledTimes(1);
  });
});
