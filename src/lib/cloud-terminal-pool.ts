"use client";

import { CloudApiError } from "@aoagents/cloud-client";
import {
  browserCloudClient,
  browserTerminalUrl,
} from "@/lib/cloud-client";

export type CloudTerminalKind = "agent" | "workspace";
export type CloudTerminalConnectionState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export type CloudTerminalEvent =
  | { type: "state"; state: CloudTerminalConnectionState }
  | { type: "output"; data: Uint8Array }
  | { type: "reset" }
  | { type: "notice"; message: string };

type CloudClient = ReturnType<typeof browserCloudClient>;
type Listener = (event: CloudTerminalEvent) => void;

interface TerminalServerMessage {
  type: "output" | "error" | "reset" | "replay_complete" | "input_ack";
  data?: string;
  message?: string;
  sequence?: number;
  inputId?: string;
}

interface PendingInput {
  id: string;
  data: string;
  sentOn: WebSocket | null;
}

const maximumHistoryBytes = 4 << 20;
const reconnectMaxDelayMs = 30_000;
const idleCloseDelayMs = 60_000;
const minimumTerminalColumns = 20;
const minimumTerminalRows = 4;

class CloudTerminalConnection {
  private socket: WebSocket | null = null;
  private state: CloudTerminalConnectionState = "connecting";
  private listeners = new Set<Listener>();
  private history: Uint8Array[] = [];
  private historyBytes = 0;
  private lastSequence = 0;
  private reconnectTimer: number | undefined;
  private idleCloseTimer: number | undefined;
  private connectInFlight = false;
  private closed = false;
  private hasConnected = false;
  private retained = false;
  private retryAttempt = 0;
  private pendingInput: PendingInput[] = [];
  private nextInputId = 0;
  private size = { rows: 24, cols: 80 };
  private canOperate = true;

  constructor(
    private readonly client: CloudClient,
    private readonly organizationId: string,
    private readonly sessionId: string,
    private readonly kind: CloudTerminalKind,
  ) {
    window.addEventListener("online", this.reconnectNow);
    window.addEventListener("focus", this.reconnectNow);
    void this.connect();
  }

  subscribe(listener: Listener) {
    if (this.idleCloseTimer !== undefined) {
      window.clearTimeout(this.idleCloseTimer);
      this.idleCloseTimer = undefined;
    }
    this.listeners.add(listener);
    listener({ type: "state", state: this.state });
    for (const data of this.history) listener({ type: "output", data });
    return () => {
      this.listeners.delete(listener);
      this.scheduleIdleClose();
    };
  }

  setRetained(retained: boolean) {
    this.retained = retained;
    if (retained && this.idleCloseTimer !== undefined) {
      window.clearTimeout(this.idleCloseTimer);
      this.idleCloseTimer = undefined;
    }
    if (!retained) this.scheduleIdleClose();
  }

  sendInput(data: string) {
    if (!this.canOperate) return;
    if (this.pendingInput.length >= 256) return;
    const input: PendingInput = {
      id: `${Date.now().toString(36)}-${++this.nextInputId}`,
      data,
      sentOn: null,
    };
    this.pendingInput.push(input);
    this.flushPendingInput();
    if (this.socket?.readyState !== WebSocket.OPEN) this.reconnectNow();
  }

  resize(rows: number, cols: number) {
    // Collapsing tabs and animated panels briefly report near-zero geometry.
    // Sending that transient size makes full-screen TUIs redraw one character
    // per line even after the panel becomes visible again.
    if (
      !Number.isInteger(rows) ||
      !Number.isInteger(cols) ||
      rows < minimumTerminalRows ||
      cols < minimumTerminalColumns
    ) {
      return;
    }
    this.size = { rows, cols };
    this.sendResize();
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer !== undefined) {
      window.clearTimeout(this.reconnectTimer);
    }
    if (this.idleCloseTimer !== undefined) {
      window.clearTimeout(this.idleCloseTimer);
    }
    window.removeEventListener("online", this.reconnectNow);
    window.removeEventListener("focus", this.reconnectNow);
    this.socket?.close();
    this.socket = null;
    this.listeners.clear();
  }

  private emit(event: CloudTerminalEvent) {
    for (const listener of this.listeners) listener(event);
  }

  private setState(state: CloudTerminalConnectionState) {
    if (this.hasConnected && state !== "connected") return;
    this.state = state;
    this.emit({ type: "state", state });
  }

  private connect = async () => {
    if (
      this.closed ||
      this.connectInFlight ||
      this.socket?.readyState === WebSocket.OPEN ||
      this.socket?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }

    this.connectInFlight = true;
    this.setState("connecting");
    const abortController = new AbortController();
    try {
      const { ticket, scopes } = await this.client.createTerminalTicket(
        this.organizationId,
        this.sessionId,
        this.kind,
        { signal: abortController.signal },
      );
      this.canOperate = !scopes || scopes.includes("terminal:operate");
      if (this.closed) return;

      const socket = new WebSocket(
        browserTerminalUrl(ticket, this.lastSequence, this.kind),
      );
      socket.binaryType = "arraybuffer";
      this.socket = socket;
      let failureHandled = false;
      const reconnectOnce = (state: CloudTerminalConnectionState) => {
        if (this.socket !== socket || this.closed || failureHandled) return;
        failureHandled = true;
        this.socket = null;
        this.setState(state);
        this.scheduleReconnect();
      };

      socket.addEventListener("open", () => {
        if (this.socket !== socket || this.closed) return;
        this.retryAttempt = 0;
        this.hasConnected = true;
        this.setState("connected");
        this.sendResize();
        this.flushPendingInput();
      });
      socket.addEventListener("message", async (event) => {
        if (this.socket !== socket || this.closed) return;
        if (typeof event.data === "string") {
          let message: TerminalServerMessage;
          try {
            message = JSON.parse(event.data) as TerminalServerMessage;
          } catch {
            return;
          }
          this.lastSequence = Math.max(this.lastSequence, message.sequence ?? 0);
          if (message.type === "input_ack" && message.inputId) {
            this.pendingInput = this.pendingInput.filter(
              (input) => input.id !== message.inputId,
            );
            return;
          }
          if (message.type === "reset") {
            this.lastSequence = 0;
            this.resetReplayBuffer();
            return;
          }
          if (message.type === "error") {
            this.emit({
              type: "notice",
              message: message.message ?? "Terminal command could not be queued.",
            });
            return;
          }
          if (message.type !== "output" || !message.data) return;
          const data = base64ToBytes(message.data);
          this.pushHistory(data);
          this.emit({ type: "output", data });
          return;
        }
        // Compatibility for an older API replica during a rolling deploy.
        const data = await terminalMessageBytes(event.data);
        if (data) {
          this.pushHistory(data);
          this.emit({ type: "output", data });
        }
      });
      socket.addEventListener("close", (event) => {
        if (event.code === 1008) {
          if (this.socket !== socket || this.closed || failureHandled) return;
          failureHandled = true;
          this.socket = null;
          this.setState("error");
          this.emit({
            type: "notice",
            message:
              event.reason || "Terminal process is unavailable in this VM.",
          });
          this.scheduleReconnect();
          return;
        }
        if (event.code === 1000) {
          this.emit({
            type: "notice",
            message:
              this.kind === "agent"
                ? "Agent terminal stream closed. Reconnecting..."
                : "Terminal stream closed. Reconnecting...",
          });
        }
        reconnectOnce("disconnected");
      });
      socket.addEventListener("error", () => {
        if (this.socket === socket && !this.closed) this.setState("error");
      });
    } catch (cause) {
      if (!this.closed && !abortController.signal.aborted) {
        this.setState("error");
        this.emit({
          type: "notice",
          message:
            cause instanceof Error ? cause.message : "Could not open terminal.",
        });
        if (
          cause instanceof CloudApiError &&
          cause.status === 403
        ) {
          return;
        }
        this.scheduleReconnect();
      }
    } finally {
      this.connectInFlight = false;
    }
  };

  private flushPendingInput() {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    for (const input of this.pendingInput) {
      if (input.sentOn === socket) continue;
      socket.send(
        JSON.stringify({ type: "input", inputId: input.id, data: input.data }),
      );
      input.sentOn = socket;
    }
  }

  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer !== undefined) return;
    const backoff = Math.min(
      1_000 * 2 ** this.retryAttempt,
      reconnectMaxDelayMs,
    );
    this.retryAttempt += 1;
    const jitter = backoff * (0.75 + Math.random() * 0.5);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, jitter);
  }

  private reconnectNow = () => {
    if (this.socket?.readyState === WebSocket.OPEN || this.closed) return;
    if (this.reconnectTimer !== undefined) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    void this.connect();
  };

  private sendResize() {
    if (!this.canOperate || this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(
      JSON.stringify({
        type: "resize",
        columns: this.size.cols,
        rows: this.size.rows,
      }),
    );
  }

  private resetReplayBuffer() {
    this.history = [];
    this.historyBytes = 0;
    this.emit({ type: "reset" });
  }

  private pushHistory(data: Uint8Array) {
    this.history.push(data);
    this.historyBytes += data.byteLength;
    while (this.historyBytes > maximumHistoryBytes && this.history.length > 1) {
      this.historyBytes -= this.history.shift()?.byteLength ?? 0;
    }
  }

  private scheduleIdleClose() {
    if (
      this.retained ||
      this.listeners.size > 0 ||
      this.idleCloseTimer !== undefined
    ) {
      return;
    }
    this.idleCloseTimer = window.setTimeout(() => {
      this.idleCloseTimer = undefined;
      if (!this.retained && this.listeners.size === 0) {
        deleteCloudTerminalConnection(
          this.organizationId,
          this.sessionId,
          this.kind,
        );
      }
    }, idleCloseDelayMs);
  }
}

const connections = new Map<string, CloudTerminalConnection>();

export function ensureCloudTerminalConnection(
  client: CloudClient,
  organizationId: string,
  sessionId: string,
  kind: CloudTerminalKind = "agent",
) {
  const key = connectionKey(organizationId, sessionId, kind);
  const existing = connections.get(key);
  if (existing) return existing;
  const connection = new CloudTerminalConnection(
    client,
    organizationId,
    sessionId,
    kind,
  );
  connections.set(key, connection);
  return connection;
}

export function clearCloudTerminalConnections() {
  for (const connection of connections.values()) connection.close();
  connections.clear();
}

export function retainCloudSessionConnections(
  client: CloudClient,
  organizationId: string,
  sessionIds: readonly string[],
) {
  const retainedKeys = new Set<string>();
  for (const sessionId of sessionIds) {
    // Keep harness output warm in the background. A workspace terminal is an
    // interactive shell with its own server-side terminal slot, so creating it
    // eagerly would consume the second slot before the inspector mounts and
    // make the visible shell's reconnect fail.
    const key = connectionKey(organizationId, sessionId, "agent");
    retainedKeys.add(key);
    ensureCloudTerminalConnection(
      client,
      organizationId,
      sessionId,
      "agent",
    ).setRetained(true);
  }

  for (const [key, connection] of connections) {
    connection.setRetained(retainedKeys.has(key));
  }
}

function deleteCloudTerminalConnection(
  organizationId: string,
  sessionId: string,
  kind: CloudTerminalKind,
) {
  const key = connectionKey(organizationId, sessionId, kind);
  const connection = connections.get(key);
  if (!connection) return;
  connection.close();
  connections.delete(key);
}

function connectionKey(
  organizationId: string,
  sessionId: string,
  kind: CloudTerminalKind,
) {
  return `${organizationId}:${sessionId}:${kind}`;
}

async function terminalMessageBytes(data: unknown): Promise<Uint8Array | null> {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  return null;
}

function base64ToBytes(value: string) {
  const binary = window.atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
