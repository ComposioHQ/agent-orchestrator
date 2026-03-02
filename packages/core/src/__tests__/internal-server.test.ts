import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import { createInternalServer } from "../internal-server.js";
import type { LifecycleManager } from "../types.js";

function makeLifecycle(
  checkFn = vi.fn().mockResolvedValue(undefined),
): LifecycleManager {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    getStates: vi.fn().mockReturnValue(new Map()),
    check: checkFn,
  };
}

async function post(
  port: number,
  path: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "POST" },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Start the server on port 0 (OS-assigned) and return the actual port */
async function listenOnRandomPort(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr === "object" && addr !== null) return addr.port;
  throw new Error("Could not determine server port");
}

describe("createInternalServer", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (s) =>
          new Promise<void>((resolve) => {
            s.close(() => resolve());
          }),
      ),
    );
    servers.length = 0;
  });

  it("calls lifecycleManager.check on POST /internal/check/:sessionId", async () => {
    const check = vi.fn().mockResolvedValue(undefined);
    const lifecycle = makeLifecycle(check);
    const server = createInternalServer(lifecycle);
    servers.push(server);
    const port = await listenOnRandomPort(server);

    const { status, body } = await post(port, "/internal/check/my-session-123");
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(check).toHaveBeenCalledWith("my-session-123");
  });

  it("returns 404 for unknown routes", async () => {
    const server = createInternalServer(makeLifecycle());
    servers.push(server);
    const port = await listenOnRandomPort(server);

    const { status } = await post(port, "/unknown");
    expect(status).toBe(404);
  });

  it("returns 200 on GET /internal/health", async () => {
    const server = createInternalServer(makeLifecycle());
    servers.push(server);
    const port = await listenOnRandomPort(server);

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
    expect(result.body).toMatchObject({ ok: true });
  });

  it("returns 500 when check() rejects", async () => {
    const check = vi.fn().mockRejectedValue(new Error("session not found"));
    const server = createInternalServer(makeLifecycle(check));
    servers.push(server);
    const port = await listenOnRandomPort(server);

    const { status, body } = await post(port, "/internal/check/bad-session");
    expect(status).toBe(500);
    expect(body).toEqual({ error: "session not found" });
  });
});
