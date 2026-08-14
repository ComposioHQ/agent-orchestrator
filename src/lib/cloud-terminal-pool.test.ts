import { afterEach, expect, it, vi } from "vitest";

import {
  clearCloudTerminalConnections,
  ensureCloudTerminalConnection,
} from "./cloud-terminal-pool";

afterEach(() => {
  clearCloudTerminalConnections();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
