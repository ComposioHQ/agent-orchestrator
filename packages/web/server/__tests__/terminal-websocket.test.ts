import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type ReqHandler = (req: any, res: any) => Promise<void> | void;
type UpgradeHandler = (req: any, socket: any, head: Buffer) => void;

let requestHandler: ReqHandler | undefined;
let upgradeHandler: UpgradeHandler | undefined;

const createServerMock = vi.fn((handler: ReqHandler) => {
  requestHandler = handler;
  return {
    on: (event: string, callback: UpgradeHandler) => {
      if (event === "upgrade") {
        upgradeHandler = callback;
      }
    },
    listen: (_port: number, callback?: () => void) => {
      callback?.();
    },
    close: (callback?: () => void) => {
      callback?.();
    },
  };
});

const requestMock = vi.fn(() => ({
  on: vi.fn(),
  end: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock("node:http", () => ({
  default: {
    createServer: createServerMock,
    request: requestMock,
  },
  createServer: createServerMock,
  request: requestMock,
}));

vi.mock("@composio/ao-core", () => ({
  createCorrelationId: vi.fn(() => "corr-test"),
}));

vi.mock("../tmux-utils.js", () => ({
  findTmux: vi.fn(() => "tmux"),
}));

vi.mock("../terminal-observability.js", () => ({
  createObserverContext: vi.fn(() => ({ config: {}, observer: null })),
  inferProjectId: vi.fn(() => undefined),
}));

const verifyTerminalAccessMock = vi.fn();
const verifyTerminalAccessNoRateLimitMock = vi.fn();

class MockTerminalAuthError extends Error {
  statusCode: number;
  code: string;
  retryAfterSeconds?: number;

  constructor(message: string, statusCode: number, code: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "TerminalAuthError";
    this.statusCode = statusCode;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

vi.mock("../terminal-auth.js", () => ({
  TerminalAuthError: MockTerminalAuthError,
  verifyTerminalAccess: verifyTerminalAccessMock,
  verifyTerminalAccessNoRateLimit: verifyTerminalAccessNoRateLimitMock,
}));

function makeRes() {
  return {
    headers: new Map<string, string>(),
    statusCode: 0,
    body: "",
    writableEnded: false,
    headersSent: false,
    setHeader(name: string, value: string) {
      this.headers.set(name, value);
    },
    writeHead(status: number, headers?: Record<string, string>) {
      this.statusCode = status;
      this.headersSent = true;
      if (headers) {
        for (const [key, value] of Object.entries(headers)) {
          this.headers.set(key, value);
        }
      }
    },
    end(payload?: string) {
      this.writableEnded = true;
      this.body = payload ?? "";
    },
    destroy: vi.fn(),
  };
}

function makeReq(url: string, headers: Record<string, string> = {}) {
  return {
    method: "GET",
    url,
    headers,
    socket: { remoteAddress: "127.0.0.1" },
    on: vi.fn(),
    pipe: vi.fn(),
  };
}

beforeAll(async () => {
  process.env.TERMINAL_PORT = "0";
  await import("../terminal-websocket.js");
});

beforeEach(() => {
  verifyTerminalAccessMock.mockReset();
  verifyTerminalAccessNoRateLimitMock.mockReset();
});

describe("terminal-websocket server handlers", () => {
  it("returns 400 when /terminal is missing session query", async () => {
    const req = makeReq("/terminal");
    const res = makeRes();

    await requestHandler?.(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Missing session parameter");
  });

  it("propagates TerminalAuthError and Retry-After on /terminal", async () => {
    verifyTerminalAccessMock.mockImplementation(() => {
      throw new MockTerminalAuthError("Too many requests", 429, "rate_limited", 5);
    });

    const req = makeReq("/terminal?session=ao-1", { cookie: "x=y" });
    const res = makeRes();

    await requestHandler?.(req, res);

    expect(res.statusCode).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(res.body).toContain("Too many requests");
  });

  it("returns 503 for non-auth verifier errors on /terminal", async () => {
    verifyTerminalAccessMock.mockImplementation(() => {
      throw new Error("backend down");
    });

    const req = makeReq("/terminal?session=ao-2");
    const res = makeRes();

    await requestHandler?.(req, res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toContain("Terminal authorization unavailable");
  });

  it("returns 200 from /health with metrics payload", async () => {
    const req = makeReq("/health");
    const res = makeRes();

    await requestHandler?.(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("metrics");
    expect(res.body).toContain("instances");
  });

  it("returns 401 on proxied /terminal/:id path auth failure", async () => {
    verifyTerminalAccessNoRateLimitMock.mockImplementation(() => {
      throw new MockTerminalAuthError("Missing terminal token", 401, "auth_required");
    });

    const req = makeReq("/terminal/ao-3/");
    const res = makeRes();

    await requestHandler?.(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toContain("Missing terminal token");
  });

  it("writes 404 upgrade response when session path is invalid", () => {
    const socket = {
      endPayload: "",
      end(payload: string) {
        this.endPayload = payload;
      },
    };

    upgradeHandler?.(makeReq("/not-terminal-path"), socket, Buffer.alloc(0));

    expect(socket.endPayload).toContain("404 Not Found");
  });

  it("writes 503 upgrade response for unexpected auth verifier errors", () => {
    verifyTerminalAccessMock.mockImplementation(() => {
      throw new Error("auth infra unavailable");
    });

    const socket = {
      endPayload: "",
      destroyed: false,
      end(payload: string) {
        this.endPayload = payload;
      },
      destroy() {
        this.destroyed = true;
      },
    };

    upgradeHandler?.(makeReq("/terminal/ao-4/"), socket, Buffer.alloc(0));

    expect(socket.endPayload).toContain("503 Service Unavailable");
    expect(socket.endPayload).toContain("Terminal authorization unavailable");
  });
});
