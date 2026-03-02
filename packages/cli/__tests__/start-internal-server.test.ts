import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import { startInternalServer } from "../src/lib/internal-server-launcher.js";
import type { SessionManager } from "@composio/ao-core";

let server: http.Server | undefined;
const originalEnv = process.env["AO_INTERNAL_PORT"];

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  // Restore original env
  if (originalEnv === undefined) {
    delete process.env["AO_INTERNAL_PORT"];
  } else {
    process.env["AO_INTERNAL_PORT"] = originalEnv;
  }
});

function makeSessionManager(): SessionManager {
  return {
    spawn: vi.fn(),
    spawnOrchestrator: vi.fn(),
    restore: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    kill: vi.fn(),
    cleanup: vi.fn(),
    send: vi.fn(),
  };
}

describe("startInternalServer", () => {
  it("starts server and sets AO_INTERNAL_PORT env var", async () => {
    // Use port 0 to get an OS-assigned port
    const sm = makeSessionManager();
    server = await startInternalServer(sm, 0);
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(process.env["AO_INTERNAL_PORT"]).toBe(String(port));
  });

  it("health endpoint responds", async () => {
    const sm = makeSessionManager();
    server = await startInternalServer(sm, 0);
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const result = await new Promise<{ status: number; body: unknown }>(
      (resolve, reject) => {
        http
          .get(
            { host: "127.0.0.1", port, path: "/internal/health" },
            (res) => {
              let data = "";
              res.on("data", (c: Buffer) => {
                data += c.toString();
              });
              res.on("end", () =>
                resolve({
                  status: res.statusCode ?? 0,
                  body: JSON.parse(data),
                }),
              );
            },
          )
          .on("error", reject);
      },
    );
    expect(result.status).toBe(200);
  });

  it("check endpoint calls sessionManager.get()", async () => {
    const sm = makeSessionManager();
    server = await startInternalServer(sm, 0);
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/internal/check/test-session",
          method: "POST",
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve());
        },
      );
      req.on("error", reject);
      req.end();
    });

    expect(sm.get).toHaveBeenCalledWith("test-session");
  });
});
