import { afterEach, expect, it, vi } from "vitest";

import {
  clearCloudTerminalConnections,
  ensureCloudTerminalConnection,
} from "./cloud-terminal-pool";

afterEach(() => {
  clearCloudTerminalConnections();
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
