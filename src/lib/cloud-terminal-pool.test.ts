import { CloudApiError } from "@aoagents/cloud-client";
import { afterEach, expect, it, vi } from "vitest";

import {
  clearCloudTerminalConnections,
  ensureCloudTerminalConnection,
  retainCloudSessionConnections,
} from "./cloud-terminal-pool";

afterEach(() => {
  clearCloudTerminalConnections();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("keeps harness streams warm without eagerly consuming workspace terminal slots", async () => {
  class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly instances: FakeWebSocket[] = [];

    readyState = FakeWebSocket.CONNECTING;
    close = vi.fn();

    constructor() {
      FakeWebSocket.instances.push(this);
    }

    addEventListener() {}
  }

  vi.stubGlobal("WebSocket", FakeWebSocket);
  const client = {
    createTerminalTicket: vi
      .fn()
      .mockImplementation(
        (_organizationId: string, sessionId: string, kind: string) =>
          Promise.resolve({ ticket: `${sessionId}-${kind}` }),
      ),
  };

  retainCloudSessionConnections(client as never, "org-one", [
    "session-one",
    "session-two",
  ]);

  await vi.waitFor(() =>
    expect(client.createTerminalTicket).toHaveBeenCalledTimes(2),
  );
  expect(client.createTerminalTicket.mock.calls).toEqual(
    expect.arrayContaining([
      ["org-one", "session-one", "agent", expect.any(Object)],
      ["org-one", "session-two", "agent", expect.any(Object)],
    ]),
  );
  expect(client.createTerminalTicket).not.toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    "workspace",
    expect.anything(),
  );
});

it("does not forward transient collapsed-pane dimensions to the PTY", async () => {
  class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static instance: FakeWebSocket;

    readyState = FakeWebSocket.CONNECTING;
    send = vi.fn();
    close = vi.fn();
    private readonly listeners = new Map<string, EventListener[]>();

    constructor() {
      FakeWebSocket.instance = this;
    }

    addEventListener(type: string, listener: EventListener) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    open() {
      this.readyState = FakeWebSocket.OPEN;
      for (const listener of this.listeners.get("open") ?? []) {
        listener(new Event("open"));
      }
    }

    message(data: string) {
      for (const listener of this.listeners.get("message") ?? []) {
        listener({ data } as MessageEvent);
      }
    }
  }

  vi.stubGlobal("WebSocket", FakeWebSocket);
  const client = {
    createTerminalTicket: vi.fn().mockResolvedValue({ ticket: "ticket-one" }),
  };
  const connection = ensureCloudTerminalConnection(
    client as never,
    "org-one",
    "session-one",
  );
  connection.resize(1, 2);
  await vi.waitFor(() => expect(FakeWebSocket.instance).toBeDefined());
  FakeWebSocket.instance.open();

  expect(FakeWebSocket.instance.send).not.toHaveBeenCalled();
  FakeWebSocket.instance.message(JSON.stringify({ type: "ready" }));

  expect(FakeWebSocket.instance.send).toHaveBeenLastCalledWith(
    JSON.stringify({ type: "resize", columns: 80, rows: 24 }),
  );

  connection.resize(40, 120);
  connection.resize(0, 0);
  expect(FakeWebSocket.instance.send).toHaveBeenLastCalledWith(
    JSON.stringify({ type: "resize", columns: 120, rows: 40 }),
  );
  expect(FakeWebSocket.instance.send).toHaveBeenCalledTimes(2);
});

it("does not send input or resize frames for a read-only terminal ticket", async () => {
  class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static instance: FakeWebSocket;

    readyState = FakeWebSocket.CONNECTING;
    send = vi.fn();
    close = vi.fn();
    private readonly listeners = new Map<string, EventListener[]>();

    constructor() {
      FakeWebSocket.instance = this;
    }

    addEventListener(type: string, listener: EventListener) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    open() {
      this.readyState = FakeWebSocket.OPEN;
      for (const listener of this.listeners.get("open") ?? []) {
        listener(new Event("open"));
      }
    }
  }

  vi.stubGlobal("WebSocket", FakeWebSocket);
  const client = {
    createTerminalTicket: vi.fn().mockResolvedValue({
      ticket: "read-only-ticket",
      scopes: ["terminal:read"],
    }),
  };
  const connection = ensureCloudTerminalConnection(
    client as never,
    "shared-org",
    "shared-session",
  );

  await vi.waitFor(() => expect(FakeWebSocket.instance).toBeDefined());
  FakeWebSocket.instance.open();
  connection.resize(40, 120);
  connection.sendInput("whoami\n");

  expect(FakeWebSocket.instance.send).not.toHaveBeenCalled();
});

it("resumes an agent terminal after the last received sequence", async () => {
  class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    static readonly instances: FakeWebSocket[] = [];

    readonly url: string;
    readyState = FakeWebSocket.CONNECTING;
    send = vi.fn();
    private readonly listeners = new Map<string, EventListener[]>();

    constructor(url: string) {
      this.url = url;
      FakeWebSocket.instances.push(this);
    }

    addEventListener(type: string, listener: EventListener) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    close() {
      this.readyState = FakeWebSocket.CLOSED;
      this.dispatch("close", { code: 1000, reason: "" } as CloseEvent);
    }

    message(data: string) {
      this.dispatch("message", { data } as MessageEvent);
    }

    disconnect() {
      this.readyState = FakeWebSocket.CLOSED;
      this.dispatch("close", { code: 1006, reason: "" } as CloseEvent);
    }

    private dispatch(type: string, event: Event) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.spyOn(window, "setTimeout").mockImplementation((handler) => {
    queueMicrotask(() => {
      if (typeof handler === "function") handler();
    });
    return 1 as unknown as ReturnType<typeof window.setTimeout>;
  });
  const client = {
    createTerminalTicket: vi
      .fn()
      .mockResolvedValueOnce({ ticket: "ticket-one" })
      .mockResolvedValueOnce({ ticket: "ticket-two" }),
  };

  ensureCloudTerminalConnection(
    client as never,
    "org-one",
    "session-one",
  );
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  FakeWebSocket.instances[0].message(
    JSON.stringify({
      type: "output",
      sequence: 7,
      data: window.btoa("terminal output"),
    }),
  );
  FakeWebSocket.instances[0].disconnect();

  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
  expect(FakeWebSocket.instances[1].url).toContain("ticket=ticket-two");
  expect(FakeWebSocket.instances[1].url).toContain("after=7");
  expect(FakeWebSocket.instances[1].url).toContain("protocol=2");
});

it("retries unacknowledged input once after reconnect", async () => {
  class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    static readonly instances: FakeWebSocket[] = [];

    readyState = FakeWebSocket.CONNECTING;
    send = vi.fn();
    private readonly listeners = new Map<string, EventListener[]>();

    constructor() {
      FakeWebSocket.instances.push(this);
    }

    addEventListener(type: string, listener: EventListener) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    open() {
      this.readyState = FakeWebSocket.OPEN;
      this.dispatch("open", new Event("open"));
    }

    disconnect() {
      this.readyState = FakeWebSocket.CLOSED;
      this.dispatch("close", { code: 1006, reason: "" } as CloseEvent);
    }

    message(data: string) {
      this.dispatch("message", { data } as MessageEvent);
    }

    close() {
      this.readyState = FakeWebSocket.CLOSED;
    }

    private dispatch(type: string, event: Event) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.spyOn(window, "setTimeout").mockImplementation((handler) => {
    queueMicrotask(() => {
      if (typeof handler === "function") handler();
    });
    return 1 as unknown as ReturnType<typeof window.setTimeout>;
  });
  const client = {
    createTerminalTicket: vi
      .fn()
      .mockResolvedValueOnce({ ticket: "ticket-one" })
      .mockResolvedValueOnce({ ticket: "ticket-two" })
      .mockResolvedValueOnce({ ticket: "ticket-three" }),
  };
  const connection = ensureCloudTerminalConnection(
    client as never,
    "org-one",
    "session-one",
  );
  const states: string[] = [];
  connection.subscribe((event) => {
    if (event.type === "state") states.push(event.state);
  });

  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  FakeWebSocket.instances[0].open();
  FakeWebSocket.instances[0].message(JSON.stringify({ type: "ready" }));
  connection.sendInput("finish the PR\r");
  const firstInput = FakeWebSocket.instances[0].send.mock.calls.find(
    ([value]) => JSON.parse(value as string).type === "input",
  )?.[0] as string;
  expect(firstInput).toBeTruthy();

  FakeWebSocket.instances[0].disconnect();
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
  expect(states).toContain("disconnected");
  expect(states).not.toContain("error");
  FakeWebSocket.instances[1].open();
  FakeWebSocket.instances[1].message(JSON.stringify({ type: "ready" }));
  expect(FakeWebSocket.instances[1].send).toHaveBeenCalledWith(firstInput);

  const inputId = JSON.parse(firstInput).inputId as string;
  FakeWebSocket.instances[1].message(
    JSON.stringify({ type: "input_ack", inputId }),
  );
  FakeWebSocket.instances[1].disconnect();
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(3));
  FakeWebSocket.instances[2].open();
  expect(FakeWebSocket.instances[2].send).not.toHaveBeenCalledWith(firstInput);
});

it("keeps retrying while a resumed VM terminal process becomes available", async () => {
  class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    static readonly instances: FakeWebSocket[] = [];

    readyState = FakeWebSocket.CONNECTING;
    private readonly listeners = new Map<string, EventListener[]>();

    constructor() {
      FakeWebSocket.instances.push(this);
    }

    addEventListener(type: string, listener: EventListener) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    unavailable() {
      for (const listener of this.listeners.get("close") ?? []) {
        listener({ code: 1008, reason: "terminal process unavailable" } as CloseEvent);
      }
    }

    close() {}
  }

  vi.stubGlobal("WebSocket", FakeWebSocket);
  const client = {
    createTerminalTicket: vi
      .fn()
      .mockResolvedValueOnce({ ticket: "ticket-one" })
      .mockResolvedValueOnce({ ticket: "ticket-two" }),
  };

  ensureCloudTerminalConnection(
    client as never,
    "org-one",
    "session-one",
  );
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  vi.spyOn(window, "setTimeout").mockImplementation((handler) => {
    queueMicrotask(() => {
      if (typeof handler === "function") handler();
    });
    return 1 as unknown as ReturnType<typeof window.setTimeout>;
  });
  FakeWebSocket.instances[0].unavailable();

  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
  expect(client.createTerminalTicket).toHaveBeenCalledTimes(2);
});

it("reports an unavailable worker as waking and retries only the terminal ticket", async () => {
  class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly instances: FakeWebSocket[] = [];

    readyState = FakeWebSocket.CONNECTING;

    constructor() {
      FakeWebSocket.instances.push(this);
    }

    addEventListener() {}
    close() {}
  }

  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  const client = {
    createTerminalTicket: vi
      .fn()
      .mockRejectedValueOnce(new CloudApiError(409, {
        error: "worker_unavailable",
        code: "WORKER_UNAVAILABLE",
        message: "The session worker is not connected.",
        requestId: "request-1",
      }))
      .mockResolvedValueOnce({ ticket: "resumed-ticket" }),
  };
  const connection = ensureCloudTerminalConnection(
    client as never,
    "org-one",
    "session-one",
    "workspace",
  );
  const states: string[] = [];
  connection.subscribe((event) => {
    if (event.type === "state") states.push(event.state);
  });

  await vi.waitFor(() => expect(client.createTerminalTicket).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(states).toContain("waking"));
  expect(states).not.toContain("error");

  await vi.advanceTimersByTimeAsync(1_000);
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  expect(client.createTerminalTicket).toHaveBeenCalledTimes(2);
});
