import { EventEmitter } from "node:events";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type ReqHandler = (req: MockIncomingRequest, res: MockServerResponse) => Promise<void> | void;
type UpgradeHandler = (req: MockIncomingRequest, socket: MockDuplex, head: Buffer) => void;

type RequestBehavior = (req: MockClientRequest, responseCallback?: (res: MockProxyResponse) => void) => void;

let requestHandler: ReqHandler | undefined;
let upgradeHandler: UpgradeHandler | undefined;

const requestBehaviors: RequestBehavior[] = [];
const createdHttpRequests: MockClientRequest[] = [];
const ttydProcesses: MockChildProcess[] = [];
const tmuxProcesses: MockChildProcess[] = [];

class MockClientRequest extends EventEmitter {
  readonly onHandlers = new Map<string, (...args: unknown[]) => void>();

  readonly end = vi.fn(() => {
    for (const hook of this.endHooks) {
      hook();
    }
  });

  readonly destroy = vi.fn((_error?: unknown) => {
    this.destroyed = true;
  });

  destroyed = false;

  private readonly endHooks: Array<() => void> = [];

  override on(event: string, handler: (...args: unknown[]) => void): this {
    this.onHandlers.set(event, handler);
    return super.on(event, handler);
  }

  addEndHook(hook: () => void): void {
    this.endHooks.push(hook);
  }
}

class MockProxyResponse extends EventEmitter {
  readonly pipe = vi.fn();
  readonly resume = vi.fn();

  constructor(
    readonly statusCode: number,
    readonly headers: Record<string, string | string[] | undefined> = {},
    readonly statusMessage?: string,
  ) {
    super();
  }
}

class MockDuplex extends EventEmitter {
  destroyed = false;
  readonly writes: Array<string | Buffer> = [];

  readonly write = vi.fn((chunk: string | Buffer) => {
    this.writes.push(chunk);
    return true;
  });

  readonly end = vi.fn((chunk?: string | Buffer) => {
    if (chunk !== undefined) {
      this.writes.push(chunk);
    }
    this.destroyed = true;
    return this;
  });

  readonly destroy = vi.fn((_error?: unknown) => {
    this.destroyed = true;
    return this;
  });

  readonly pipe = vi.fn(() => this);
}

type MockChildProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function makeChildProcess(): MockChildProcess {
  const proc = new EventEmitter() as MockChildProcess;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

const createServerMock = vi.fn((handler: ReqHandler) => {
  requestHandler = handler;
  return {
    on: (event: string, callback: UpgradeHandler) => {
      if (event === "upgrade") {
        upgradeHandler = callback;
      }
      return undefined;
    },
    listen: (_port: number, callback?: () => void) => {
      callback?.();
    },
    close: (callback?: () => void) => {
      callback?.();
    },
  };
});

const requestMock = vi.fn((...args: unknown[]) => {
  const responseCallback =
    typeof args[1] === "function"
      ? (args[1] as (res: MockProxyResponse) => void)
      : undefined;
  const req = new MockClientRequest();
  createdHttpRequests.push(req);
  const behavior = requestBehaviors.shift();
  if (behavior) {
    behavior(req, responseCallback);
  }
  return req;
});

const spawnMock = vi.fn((command: string) => {
  const proc = makeChildProcess();
  if (command === "ttyd") {
    ttydProcesses.push(proc);
  } else {
    tmuxProcesses.push(proc);
  }
  return proc;
});

const observerRecordOperationMock = vi.fn();
const inferProjectIdMock = vi.fn(() => "project-from-test");

vi.mock("node:child_process", () => ({
  default: {
    spawn: spawnMock,
  },
  spawn: spawnMock,
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
  createObserverContext: vi.fn(() => ({
    config: { projectMap: {} },
    observer: { recordOperation: observerRecordOperationMock },
  })),
  inferProjectId: inferProjectIdMock,
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

type RequestEvent = "aborted" | "error";

interface MockIncomingRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  socket: { remoteAddress: string };
  on: ReturnType<typeof vi.fn>;
  pipe: ReturnType<typeof vi.fn>;
  emitEvent: (event: RequestEvent, value?: unknown) => void;
}

interface MockServerResponse {
  headers: Map<string, string>;
  statusCode: number;
  body: string;
  writableEnded: boolean;
  headersSent: boolean;
  setHeader: (name: string, value: string) => void;
  writeHead: (status: number, headers?: Record<string, string>) => void;
  end: (payload?: string) => void;
  destroy: ReturnType<typeof vi.fn>;
}

function makeRes(): MockServerResponse {
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

function makeReq(url: string, headers: Record<string, string> = {}): MockIncomingRequest {
  const listeners = new Map<RequestEvent, (...args: unknown[]) => void>();

  const req: MockIncomingRequest = {
    method: "GET",
    url,
    headers,
    socket: { remoteAddress: "127.0.0.1" },
    on: vi.fn((event: RequestEvent, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener);
      return req;
    }),
    pipe: vi.fn(),
    emitEvent(event: RequestEvent, value?: unknown) {
      listeners.get(event)?.(value);
    },
  };

  return req;
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

beforeAll(async () => {
  process.env.TERMINAL_PORT = "0";
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  await import("../terminal-websocket.js");
});

beforeEach(() => {
  verifyTerminalAccessMock.mockReset();
  verifyTerminalAccessNoRateLimitMock.mockReset();
  observerRecordOperationMock.mockReset();
  inferProjectIdMock.mockReset();
  inferProjectIdMock.mockReturnValue("project-from-test");
  requestBehaviors.length = 0;
  createdHttpRequests.length = 0;
  ttydProcesses.length = 0;
  tmuxProcesses.length = 0;
  spawnMock.mockReset();
  spawnMock.mockImplementation((command: string) => {
    const proc = makeChildProcess();
    if (command === "ttyd") {
      ttydProcesses.push(proc);
    } else {
      tmuxProcesses.push(proc);
    }
    return proc;
  });
});

describe("terminal-websocket server handlers", () => {
  it("returns 400 when /terminal is missing session query", async () => {
    const req = makeReq("/terminal");
    const res = makeRes();

    await requestHandler?.(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Missing session parameter");
    expect(observerRecordOperationMock).toHaveBeenCalled();
  });

  it("returns terminal URL using forwarded protocol when present", async () => {
    verifyTerminalAccessMock.mockReturnValue({});
    const req = makeReq("/terminal?session=ao-proto", {
      host: "dash.local:3000",
      "x-forwarded-proto": "https",
    });
    const res = makeRes();

    await requestHandler?.(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("https://dash.local:3000/terminal/ao-proto/");
  });

  it("falls back to http protocol when forwarded proto is empty", async () => {
    verifyTerminalAccessMock.mockReturnValue({});
    const req = makeReq("/terminal?session=ao-proto-fallback", {
      host: "localhost:3000",
      "x-forwarded-proto": "",
    });
    const res = makeRes();

    await requestHandler?.(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("http://localhost:3000/terminal/ao-proto-fallback/");
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

  it("returns 503 for non-auth verifier failure on proxied path", async () => {
    verifyTerminalAccessNoRateLimitMock.mockImplementation(() => {
      throw new Error("auth subsystem unavailable");
    });

    const req = makeReq("/terminal/ao-auth-fail/");
    const res = makeRes();

    await requestHandler?.(req, res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toContain("Terminal authorization unavailable");
  });

  it("proxies HTTP requests and handles downstream response errors", async () => {
    verifyTerminalAccessNoRateLimitMock.mockReturnValue({
      sessionId: "ao-proxy-http",
      tmuxSessionName: "tmux-proxy-http",
    });

    requestBehaviors.push((_req, responseCallback) => {
      _req.addEndHook(() => {
        responseCallback?.(new MockProxyResponse(200));
      });
    });

    const upstreamResponse = new MockProxyResponse(201, { "x-upstream": "ok" });
    requestBehaviors.push((_req, responseCallback) => {
      responseCallback?.(upstreamResponse);
    });

    const req = makeReq("/terminal/ao-proxy-http/?a=1", { cookie: "token=1" });
    const res = makeRes();
    await requestHandler?.(req, res);

    expect(res.statusCode).toBe(201);
    expect(req.pipe).toHaveBeenCalled();
    expect(upstreamResponse.pipe).toHaveBeenCalled();

    upstreamResponse.emit("error", new Error("response-stream-failure"));
    expect(res.destroy).toHaveBeenCalled();
  });

  it("returns 502 JSON when HTTP proxy request fails before response", async () => {
    verifyTerminalAccessNoRateLimitMock.mockReturnValue({
      sessionId: "ao-proxy-error-early",
      tmuxSessionName: "tmux-proxy-error-early",
    });

    requestBehaviors.push((req, responseCallback) => {
      req.addEndHook(() => {
        responseCallback?.(new MockProxyResponse(200));
      });
    });
    requestBehaviors.push(() => undefined);

    const req = makeReq("/terminal/ao-proxy-error-early/");
    const res = makeRes();
    await requestHandler?.(req, res);

    const proxyReq = createdHttpRequests[1];
    proxyReq.emit("error", new Error("proxy-http-failed"));

    expect(res.statusCode).toBe(502);
    expect(res.body).toContain("Terminal proxy failed");
  });

  it("destroys response when HTTP proxy request errors after headers were sent", async () => {
    verifyTerminalAccessNoRateLimitMock.mockReturnValue({
      sessionId: "ao-proxy-error-late",
      tmuxSessionName: "tmux-proxy-error-late",
    });

    requestBehaviors.push((req, responseCallback) => {
      req.addEndHook(() => {
        responseCallback?.(new MockProxyResponse(200));
      });
    });
    requestBehaviors.push((req, responseCallback) => {
      responseCallback?.(new MockProxyResponse(200));
      req.addEndHook(() => undefined);
    });

    const req = makeReq("/terminal/ao-proxy-error-late/");
    const res = makeRes();
    await requestHandler?.(req, res);

    const proxyReq = createdHttpRequests[1];
    proxyReq.emit("error", new Error("post-header-proxy-error"));

    expect(res.destroy).toHaveBeenCalled();
  });

  it("destroys upstream proxy request on client aborted and stream error", async () => {
    verifyTerminalAccessNoRateLimitMock.mockReturnValue({
      sessionId: "ao-abort",
      tmuxSessionName: "tmux-abort",
    });

    requestBehaviors.push((req, responseCallback) => {
      req.addEndHook(() => {
        responseCallback?.(new MockProxyResponse(200));
      });
    });
    requestBehaviors.push(() => undefined);

    const req = makeReq("/terminal/ao-abort/");
    const res = makeRes();
    await requestHandler?.(req, res);

    const proxyReq = createdHttpRequests[1];
    req.emitEvent("aborted");
    req.emitEvent("error", new Error("request-stream-error"));

    expect(proxyReq.destroy).toHaveBeenCalledTimes(2);
  });

  it("classifies startup errors from spawn and returns 503", async () => {
    verifyTerminalAccessNoRateLimitMock.mockReturnValue({
      sessionId: "ao-startup-error",
      tmuxSessionName: "tmux-startup-error",
    });
    spawnMock.mockImplementation((command: string) => {
      if (command === "ttyd") {
        throw new Error("Port exhaustion: reached maximum of 100 terminal instances");
      }
      const proc = makeChildProcess();
      tmuxProcesses.push(proc);
      return proc;
    });

    const req = makeReq("/terminal/ao-startup-error/");
    const res = makeRes();
    await requestHandler?.(req, res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toContain("Terminal capacity exhausted");
  });

  it("classifies terminal startup timeout failures", async () => {
    verifyTerminalAccessNoRateLimitMock.mockReturnValue({
      sessionId: "ao-timeout-error",
      tmuxSessionName: "tmux-timeout-error",
    });
    spawnMock.mockImplementation((command: string) => {
      if (command === "ttyd") {
        throw new Error("ttyd did not become ready within 3000ms");
      }
      const proc = makeChildProcess();
      tmuxProcesses.push(proc);
      return proc;
    });

    const req = makeReq("/terminal/ao-timeout-error/");
    const res = makeRes();
    await requestHandler?.(req, res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toContain("Terminal startup timed out");
  });

  it("classifies unknown startup failures as terminal unavailable", async () => {
    verifyTerminalAccessNoRateLimitMock.mockReturnValue({
      sessionId: "ao-generic-error",
      tmuxSessionName: "tmux-generic-error",
    });
    spawnMock.mockImplementation((command: string) => {
      if (command === "ttyd") {
        throw new Error("unknown startup issue");
      }
      const proc = makeChildProcess();
      tmuxProcesses.push(proc);
      return proc;
    });

    const req = makeReq("/terminal/ao-generic-error/");
    const res = makeRes();
    await requestHandler?.(req, res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toContain("Failed to start terminal");
  });

  it("captures tmux option process errors and ttyd process lifecycle events", async () => {
    verifyTerminalAccessNoRateLimitMock.mockReturnValue({
      sessionId: "ao-proc-events",
      tmuxSessionName: "tmux-proc-events",
    });
    requestBehaviors.push((req, responseCallback) => {
      req.addEndHook(() => {
        responseCallback?.(new MockProxyResponse(200));
      });
    });
    requestBehaviors.push(() => undefined);

    const req = makeReq("/terminal/ao-proc-events/");
    const res = makeRes();
    await requestHandler?.(req, res);

    tmuxProcesses[0]?.emit("error", new Error("mouse option failed"));
    tmuxProcesses[1]?.emit("error", new Error("status option failed"));

    expect(ttydProcesses).toHaveLength(1);
    ttydProcesses[0].emit("error", new Error("ttyd runtime failure"));
    ttydProcesses[0].emit("exit", 0);

    const healthReq = makeReq("/health");
    const healthRes = makeRes();
    await requestHandler?.(healthReq, healthRes);

    expect(healthRes.statusCode).toBe(200);
    expect(healthRes.body).toContain("totalErrors");
  });

  it("returns 200 from /health with metrics payload", async () => {
    const req = makeReq("/health");
    const res = makeRes();

    await requestHandler?.(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("metrics");
    expect(res.body).toContain("instances");
  });

  it("returns 404 for unknown paths", async () => {
    const req = makeReq("/does-not-exist");
    const res = makeRes();

    await requestHandler?.(req, res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toBe("Not found");
  });

  it("writes 404 upgrade response when session path is invalid", () => {
    const socket = new MockDuplex();

    upgradeHandler?.(makeReq("/not-terminal-path"), socket, Buffer.alloc(0));

    const response = String(socket.writes.at(-1));
    expect(response).toContain("404 Not Found");
  });

  it("writes 503 upgrade response for unexpected auth verifier errors", async () => {
    verifyTerminalAccessMock.mockImplementation(() => {
      throw new Error("auth infra unavailable");
    });

    const socket = new MockDuplex();
    upgradeHandler?.(makeReq("/terminal/ao-4/"), socket, Buffer.alloc(0));
    await flushAsync();

    const response = String(socket.writes.at(-1));
    expect(response).toContain("503 Service Unavailable");
    expect(response).toContain("Terminal authorization unavailable");
  });

  it("propagates TerminalAuthError in upgrade response with Retry-After", async () => {
    verifyTerminalAccessMock.mockImplementation(() => {
      throw new MockTerminalAuthError("Too many requests", 429, "rate_limited", 7);
    });

    const socket = new MockDuplex();
    upgradeHandler?.(makeReq("/terminal/ao-upgrade-auth/"), socket, Buffer.alloc(0));
    await flushAsync();

    const response = String(socket.writes.at(-1));
    expect(response).toContain("429 Too Many Requests");
    expect(response).toContain("Retry-After: 7");
  });

  it("returns terminal startup failures during websocket upgrade", async () => {
    verifyTerminalAccessMock.mockReturnValue({
      sessionId: "ao-upgrade-startup-fail",
      tmuxSessionName: "tmux-upgrade-startup-fail",
    });
    spawnMock.mockImplementation((command: string) => {
      if (command === "ttyd") {
        throw new Error("unknown upgrade startup failure");
      }
      const proc = makeChildProcess();
      tmuxProcesses.push(proc);
      return proc;
    });

    const socket = new MockDuplex();
    upgradeHandler?.(makeReq("/terminal/ao-upgrade-startup-fail/"), socket, Buffer.alloc(0));
    await flushAsync();

    const response = String(socket.writes.at(-1));
    expect(response).toContain("503 Service Unavailable");
    expect(response).toContain("Failed to start terminal");
  });

  it("proxies websocket upgrade and handles bidirectional socket events", async () => {
    verifyTerminalAccessMock.mockReturnValue({
      sessionId: "ao-upgrade-success",
      tmuxSessionName: "tmux-upgrade-success",
    });
    requestBehaviors.push((req, responseCallback) => {
      req.addEndHook(() => {
        responseCallback?.(new MockProxyResponse(200));
      });
    });
    requestBehaviors.push(() => undefined);

    const socket = new MockDuplex();
    const head = Buffer.from("client-head");
    upgradeHandler?.(makeReq("/terminal/ao-upgrade-success/", { upgrade: "websocket" }), socket, head);
    await flushAsync();

    const proxyReq = createdHttpRequests[1];
    const proxySocket = new MockDuplex();
    const proxyRes = new MockProxyResponse(101, {
      connection: "Upgrade",
      "sec-websocket-accept": "abc",
      "set-cookie": ["a=1", "b=2"],
      "x-ignore": undefined,
    }, "Switching Protocols");

    proxyReq.emit("upgrade", proxyRes, proxySocket, Buffer.from("proxy-head"));

    expect(String(socket.writes[0])).toContain("101 Switching Protocols");
    expect(proxySocket.write).toHaveBeenCalledWith(head);
    expect(proxySocket.pipe).toHaveBeenCalledWith(socket);
    expect(socket.pipe).toHaveBeenCalledWith(proxySocket);

    proxySocket.emit("error", new Error("upstream socket failure"));
    expect(socket.destroy).toHaveBeenCalled();

    socket.emit("error", new Error("client socket failure"));
    expect(proxySocket.destroy).toHaveBeenCalled();

    proxySocket.emit("close");
    socket.emit("close");
  });

  it("handles non-upgrade responses and request errors in websocket proxy", async () => {
    verifyTerminalAccessMock.mockReturnValue({
      sessionId: "ao-upgrade-response",
      tmuxSessionName: "tmux-upgrade-response",
    });
    requestBehaviors.push((req, responseCallback) => {
      req.addEndHook(() => {
        responseCallback?.(new MockProxyResponse(200));
      });
    });
    requestBehaviors.push(() => undefined);

    const socket = new MockDuplex();
    upgradeHandler?.(makeReq("/terminal/ao-upgrade-response/"), socket, Buffer.alloc(0));
    await flushAsync();

    const proxyReq = createdHttpRequests[1];
    const rejectedResponse = new MockProxyResponse(403, {}, "Forbidden");
    proxyReq.emit("response", rejectedResponse);

    const rejectPayload = String(socket.writes.at(-1));
    expect(rejectPayload).toContain("403 Forbidden");
    expect(rejectedResponse.resume).toHaveBeenCalled();

    proxyReq.emit("error", new Error("upgrade proxy request failed"));
    const errorPayload = String(socket.writes.at(-1));
    expect(errorPayload).toContain("502 Service Unavailable");
    expect(errorPayload).toContain("Terminal proxy failed");
  });

  it("ignores websocket proxy request errors after successful upgrade", async () => {
    verifyTerminalAccessMock.mockReturnValue({
      sessionId: "ao-upgrade-error-ignore",
      tmuxSessionName: "tmux-upgrade-error-ignore",
    });
    requestBehaviors.push((req, responseCallback) => {
      req.addEndHook(() => {
        responseCallback?.(new MockProxyResponse(200));
      });
    });
    requestBehaviors.push(() => undefined);

    const socket = new MockDuplex();
    upgradeHandler?.(makeReq("/terminal/ao-upgrade-error-ignore/"), socket, Buffer.alloc(0));
    await flushAsync();

    const proxyReq = createdHttpRequests[1];
    const proxySocket = new MockDuplex();
    proxyReq.emit("upgrade", new MockProxyResponse(101, {}), proxySocket, Buffer.alloc(0));
    const writeCountBeforeError = socket.writes.length;

    proxyReq.emit("error", new Error("late upgrade error"));

    expect(socket.writes.length).toBe(writeCountBeforeError);
  });
});
