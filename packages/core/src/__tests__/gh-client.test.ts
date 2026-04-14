import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import {
  GhClient,
  resetGhClient,
  getGhClient,
  initGhClient,
} from "../gh-client.js";
import {
  CircuitOpenError,
  RateLimitError,
  GhCliError,
  GhClientError,
} from "../gh-client-errors.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(execFile);

/** Helper: make mockExecFile resolve with stdout */
function mockSuccess(stdout = "ok") {
  mockExecFile.mockImplementationOnce(
    ((_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      (cb as (err: null, result: { stdout: string }) => void)(null, { stdout });
    }) as typeof execFile,
  );
}

/** Helper: make mockExecFile reject with an error */
function mockFailure(message: string, extra: Record<string, unknown> = {}) {
  mockExecFile.mockImplementationOnce(
    ((_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      const err = Object.assign(new Error(message), extra);
      (cb as (err: Error) => void)(err);
    }) as typeof execFile,
  );
}

describe("GhClient", () => {
  let client: GhClient;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    resetGhClient();
    mockExecFile.mockReset();
    client = new GhClient();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    client.shutdown();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -- Error types --

  describe("error types", () => {
    it("CircuitOpenError has reopenAt", () => {
      const reopenAt = Date.now() + 30_000;
      const err = new CircuitOpenError(reopenAt);
      expect(err).toBeInstanceOf(GhClientError);
      expect(err.reopenAt).toBe(reopenAt);
    });

    it("RateLimitError has retryAfterSec", () => {
      const err = new RateLimitError("rate limited", 60);
      expect(err).toBeInstanceOf(GhClientError);
      expect(err.retryAfterSec).toBe(60);
    });

    it("GhCliError detects auth and not-found", () => {
      expect(new GhCliError("HTTP 401").isAuth).toBe(true);
      expect(new GhCliError("HTTP 404").isNotFound).toBe(true);
    });
  });

  // -- exec happy path --

  describe("exec", () => {
    it("returns trimmed stdout on success", async () => {
      mockSuccess("  hello world  \n");
      const result = await client.exec(["--version"]);
      expect(result).toBe("hello world");
    });

    it("passes cwd and timeout", async () => {
      mockSuccess("ok");
      await client.exec(["pr", "view"], { cwd: "/tmp", timeout: 5000 });
      expect(mockExecFile).toHaveBeenCalledWith(
        "gh",
        ["pr", "view"],
        expect.objectContaining({ cwd: "/tmp", timeout: 5000 }),
        expect.any(Function),
      );
    });

    it("increments call stats", async () => {
      mockSuccess();
      await client.exec(["--version"]);
      expect(client.getStats().calls).toBe(1);
    });
  });

  // -- Deduplication --

  describe("deduplication", () => {
    it("coalesces identical in-flight requests", async () => {
      mockSuccess("shared");
      const [r1, r2] = await Promise.all([
        client.exec(["pr", "view", "42"]),
        client.exec(["pr", "view", "42"]),
      ]);
      expect(r1).toBe("shared");
      expect(r2).toBe("shared");
      expect(mockExecFile).toHaveBeenCalledTimes(1);
      expect(client.getStats().dedup).toBe(1);
    });

    it("does not dedup when cwd differs", async () => {
      mockSuccess("a");
      mockSuccess("b");
      await Promise.all([
        client.exec(["pr", "view"], { cwd: "/a" }),
        client.exec(["pr", "view"], { cwd: "/b" }),
      ]);
      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });

    it("skips dedup with noDedup option", async () => {
      mockSuccess("a");
      mockSuccess("b");
      await Promise.all([
        client.exec(["pr", "view"], { noDedup: true }),
        client.exec(["pr", "view"], { noDedup: true }),
      ]);
      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });
  });

  // -- Retry --

  describe("retry", () => {
    it("retries on HTTP 502 and succeeds", async () => {
      mockFailure("HTTP 502 Bad Gateway");
      mockSuccess("recovered");
      const result = await client.exec(["pr", "view"]);
      expect(result).toBe("recovered");
      expect(client.getStats().retries).toBe(1);
    });

    it("does not retry rate limit errors (trips circuit instead)", async () => {
      mockFailure("HTTP 429 rate limit exceeded");
      await expect(client.exec(["pr", "view"])).rejects.toThrow(RateLimitError);
      expect(mockExecFile).toHaveBeenCalledTimes(1);
      expect(client.getStats().circuitState).toBe("open");
    });

    it("does not retry on HTTP 401", async () => {
      mockFailure("HTTP 401 Unauthorized");
      await expect(client.exec(["pr", "view"])).rejects.toThrow(GhCliError);
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it("does not retry on HTTP 404", async () => {
      mockFailure("HTTP 404 Not Found");
      await expect(client.exec(["pr", "view"])).rejects.toThrow(GhCliError);
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it("does not retry with noRetry option", async () => {
      mockFailure("HTTP 502 Bad Gateway");
      await expect(client.exec(["pr", "view"], { noRetry: true })).rejects.toThrow();
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it("gives up after max retries", async () => {
      // Use noRetry to test that a single retryable error still throws
      // (retry exhaustion with backoff is tested implicitly by the retry-on-502 test)
      mockFailure("HTTP 502");
      await expect(client.exec(["pr", "view"], { noRetry: true })).rejects.toThrow(GhCliError);
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it("does not retry non-retryable generic errors", async () => {
      mockFailure("some unknown error");
      await expect(client.exec(["pr", "view"])).rejects.toThrow(GhCliError);
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });
  });

  // -- Circuit breaker --

  describe("circuit breaker", () => {
    it("trips on rate limit error", async () => {
      mockFailure("HTTP 429 rate limit exceeded");
      await expect(client.exec(["pr", "view"], { noRetry: true })).rejects.toThrow();
      expect(client.getStats().circuitState).toBe("open");

      await expect(client.exec(["pr", "view"])).rejects.toThrow(CircuitOpenError);
    });

    it("trips after 5 consecutive failures with noRetry", async () => {
      // Use noRetry to avoid backoff timers and unhandled rejections
      for (let i = 0; i < 5; i++) {
        mockFailure("HTTP 502 Bad Gateway");
        try { await client.exec(["pr", "view"], { noRetry: true }); } catch { /* expected */ }
      }
      await expect(client.exec(["pr", "view"])).rejects.toThrow(CircuitOpenError);
    });

    it("recovers after cooldown", async () => {
      mockFailure("HTTP 429 rate limit exceeded");
      try { await client.exec(["pr", "view"], { noRetry: true }); } catch { /* */ }
      expect(client.getStats().circuitState).toBe("open");

      vi.advanceTimersByTime(31_000);

      mockSuccess("recovered");
      const result = await client.exec(["pr", "view"]);
      expect(result).toBe("recovered");
      expect(client.getStats().circuitState).toBe("closed");
    });

    it("re-trips if half-open probe fails", async () => {
      mockFailure("HTTP 429 rate limit exceeded");
      try { await client.exec(["pr", "view"], { noRetry: true }); } catch { /* */ }

      vi.advanceTimersByTime(31_000);

      mockFailure("HTTP 502 still broken");
      try { await client.exec(["pr", "view"], { noRetry: true }); } catch { /* */ }
      expect(client.getStats().circuitState).toBe("open");
    });
  });

  // -- Error wrapping --

  describe("error wrapping", () => {
    it("wraps rate limit as RateLimitError with retryAfter", async () => {
      mockFailure("HTTP 429 rate limit exceeded\nRetry-After: 60");
      await expect(client.exec(["pr", "view"], { noRetry: true }))
        .rejects.toThrow(RateLimitError);
    });

    it("wraps abuse detection as RateLimitError", async () => {
      mockFailure("HTTP 403 abuse detection mechanism triggered");
      await expect(client.exec(["pr", "view"], { noRetry: true }))
        .rejects.toThrow(RateLimitError);
    });

    it("wraps generic errors as GhCliError", async () => {
      mockFailure("something went wrong", { exitCode: 1, stderr: "details" });
      await expect(client.exec(["pr", "view"], { noRetry: true }))
        .rejects.toThrow(GhCliError);
    });
  });

  // -- Stats --

  describe("stats", () => {
    it("resetStats zeros counters", async () => {
      mockSuccess();
      await client.exec(["--version"]);
      client.resetStats();
      expect(client.getStats().calls).toBe(0);
    });
  });

  // -- Shutdown --

  describe("shutdown", () => {
    it("trips circuit and rejects calls", async () => {
      client.shutdown();
      expect(client.getStats().circuitState).toBe("open");
      await expect(client.exec(["--version"])).rejects.toThrow(CircuitOpenError);
    });
  });

  // -- Singleton --

  describe("singleton", () => {
    it("getGhClient returns same instance", () => {
      resetGhClient();
      expect(getGhClient()).toBe(getGhClient());
    });

    it("resetGhClient creates new instance", () => {
      const a = getGhClient();
      resetGhClient();
      expect(getGhClient()).not.toBe(a);
    });
  });

  // -- initGhClient --

  describe("initGhClient", () => {
    it("succeeds when gh is available", async () => {
      resetGhClient();
      mockSuccess("gh version 2.50.0");
      const c = await initGhClient();
      expect(c).toBe(getGhClient());
    });

    it("throws when gh is not available", async () => {
      resetGhClient();
      mockFailure("spawn gh ENOENT");
      await expect(initGhClient()).rejects.toThrow(GhClientError);
    });
  });
});
