/**
 * Codex App-Server JSON-RPC Client
 *
 * Manages a `codex app-server` subprocess and communicates via
 * newline-delimited JSON over stdin/stdout. Provides typed methods
 * for thread management, turn execution, and conversation resume.
 *
 * Protocol reference: Codex app-server developer guide
 * Implementation reference: codex-autorunner integrations/app_server/client.py
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { EventEmitter } from "node:events";

// =============================================================================
// Types
// =============================================================================

/** JSON-RPC request sent from client to server */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params: Record<string, unknown>;
}

/** JSON-RPC response from server */
export interface JsonRpcResponse {
  id: string;
  result?: Record<string, unknown>;
  error?: JsonRpcError;
}

/** JSON-RPC error object */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// =============================================================================
// Custom Error Classes
// =============================================================================

/** Base error class for all CodexAppServerClient errors */
export class CodexClientError extends Error {
  code: string;
  readonly retryable: boolean;

  constructor(message: string, code: string, retryable: boolean = false, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "CodexClientError";
    this.code = code;
    this.retryable = retryable;
    // Set the prototype explicitly for instanceof checks
    Object.setPrototypeOf(this, CodexClientError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      retryable: this.retryable,
      cause: this.cause,
    };
  }
}

/** Error thrown when the client is in an invalid state */
export class ClientStateError extends CodexClientError {
  constructor(message: string, cause?: unknown) {
    super(message, "INVALID_STATE", false, cause);
    this.name = "ClientStateError";
    Object.setPrototypeOf(this, ClientStateError.prototype);
  }
}

/** Error thrown when the client is closed */
export class ClientClosedError extends ClientStateError {
  constructor() {
    super("Client is closed and cannot accept new requests");
    this.code = "CLIENT_CLOSED";
    this.name = "ClientClosedError";
    Object.setPrototypeOf(this, ClientClosedError.prototype);
  }
}

/** Error thrown when the client is not initialized */
export class ClientNotInitializedError extends ClientStateError {
  constructor() {
    super("Client not initialized — call connect() first");
    this.code = "NOT_INITIALIZED";
    this.name = "ClientNotInitializedError";
    Object.setPrototypeOf(this, ClientNotInitializedError.prototype);
  }
}

/** Error thrown when connection is already in progress */
export class ClientConnectingError extends ClientStateError {
  constructor() {
    super("Client is already connecting");
    this.code = "ALREADY_CONNECTING";
    this.name = "ClientConnectingError";
    Object.setPrototypeOf(this, ClientConnectingError.prototype);
  }
}

/** Error thrown when a request times out */
export class RequestTimeoutError extends CodexClientError {
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(`Request ${method} timed out after ${timeoutMs}ms`, "REQUEST_TIMEOUT", true);
    this.method = method;
    this.timeoutMs = timeoutMs;
    this.name = "RequestTimeoutError";
    Object.setPrototypeOf(this, RequestTimeoutError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      method: this.method,
      timeoutMs: this.timeoutMs,
    };
  }
}

/** Error thrown when the server responds with a JSON-RPC error */
export class JsonRpcServerError extends CodexClientError {
  readonly jsonRpcCode: number;
  readonly jsonRpcData?: unknown;

  constructor(jsonRpcError: JsonRpcError) {
    super(
      `JSON-RPC error ${jsonRpcError.code}: ${jsonRpcError.message}`,
      "JSON_RPC_ERROR",
      isRetryableJsonRpcError(jsonRpcError.code),
      jsonRpcError.data,
    );
    this.jsonRpcCode = jsonRpcError.code;
    this.jsonRpcData = jsonRpcError.data;
    this.name = "JsonRpcServerError";
    Object.setPrototypeOf(this, JsonRpcServerError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      jsonRpcCode: this.jsonRpcCode,
      jsonRpcData: this.jsonRpcData,
    };
  }
}

/** Error thrown when the process fails to spawn or exits unexpectedly */
export class ProcessError extends CodexClientError {
  readonly exitCode: number | null;
  readonly signal: string | null;

  constructor(message: string, exitCode: number | null = null, signal: string | null = null, cause?: unknown) {
    super(message, "PROCESS_ERROR", false, cause);
    this.exitCode = exitCode;
    this.signal = signal;
    this.name = "ProcessError";
    Object.setPrototypeOf(this, ProcessError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      exitCode: this.exitCode,
      signal: this.signal,
    };
  }
}

/** Error thrown when stdin is not writable */
export class StdioError extends CodexClientError {
  constructor(message: string) {
    super(message, "STDIO_ERROR", false);
    this.name = "StdioError";
    Object.setPrototypeOf(this, StdioError.prototype);
  }
}

/** Determine if a JSON-RPC error code indicates a retryable error */
function isRetryableJsonRpcError(code: number): boolean {
  // JSON-RPC spec error codes:
  // -32700: Parse error (not retryable)
  // -32600: Invalid Request (not retryable)
  // -32601: Method not found (not retryable)
  // -32602: Invalid params (not retryable)
  // -32603: Internal error (retryable - server-side issue)
  // -32099 to -32000: Server error (retryable)
  return code === -32603 || (code >= -32099 && code <= -32000);
}

/** JSON-RPC notification from server (no id) */
export interface JsonRpcNotification {
  method: string;
  params: Record<string, unknown>;
}

/** Approval request from server (has id + method + params) */
export interface JsonRpcApprovalRequest {
  id: string | number;
  method: string;
  params: Record<string, unknown>;
}

/** Parsed message from the server — could be response, notification, or approval request */
type ServerMessage = JsonRpcResponse | JsonRpcNotification | JsonRpcApprovalRequest;

/** Callback for server notifications */
export type NotificationHandler = (method: string, params: Record<string, unknown>) => void;

/** Callback for approval requests */
export type ApprovalHandler = (
  id: string | number,
  method: string,
  params: Record<string, unknown>,
) => Promise<ApprovalDecision>;

/** Approval decision values */
export type ApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel";

/** Options for creating a CodexAppServerClient */
export interface AppServerClientOptions {
  /** Path to codex binary (default: "codex") */
  binaryPath?: string;
  /** Working directory for the app-server process */
  cwd?: string;
  /** Environment variables for the process */
  env?: Record<string, string>;
  /** Timeout for requests in ms (default: 60000) */
  requestTimeout?: number;
  /** Handler for server notifications */
  onNotification?: NotificationHandler;
  /** Handler for approval requests (auto-accepts if not provided) */
  onApproval?: ApprovalHandler;
}

/** Thread start parameters */
export interface ThreadStartParams {
  model?: string;
  modelProvider?: string;
  cwd?: string;
  /** Codex approval policy: untrusted (ask for all), on-request, or never */
  approvalPolicy?: "untrusted" | "on-request" | "never";
  /** Codex sandbox mode */
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** Personality/instruction preset */
  personality?: string;
}

/** Turn start parameters */
export interface TurnStartParams {
  threadId: string;
  input: string;
  cwd?: string;
  model?: string;
}

/** Pending request waiting for a response */
interface PendingRequest {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// =============================================================================
// Client Implementation
// =============================================================================

/**
 * JSON-RPC client for Codex's app-server mode.
 *
 * Usage:
 * ```ts
 * const client = new CodexAppServerClient({ cwd: "/my/project" });
 * await client.connect();
 *
 * const thread = await client.threadStart({ model: "o3-mini" });
 * const turn = await client.turnStart({ threadId: thread.id, input: "Fix the bug" });
 *
 * await client.close();
 * ```
 */
export class CodexAppServerClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private pending = new Map<string, PendingRequest>();
  private initialized = false;
  private closed = false;
  private connecting = false;

  private readonly binaryPath: string;
  private readonly cwd: string | undefined;
  private readonly env: Record<string, string> | undefined;
  private readonly requestTimeout: number;
  private readonly onNotification: NotificationHandler | undefined;
  private readonly onApproval: ApprovalHandler | undefined;

  constructor(options: AppServerClientOptions = {}) {
    super();
    this.binaryPath = options.binaryPath ?? "codex";
    this.cwd = options.cwd;
    this.env = options.env;
    this.requestTimeout = options.requestTimeout ?? 60_000;
    this.onNotification = options.onNotification;
    this.onApproval = options.onApproval;
  }

  /** Whether the client is connected and initialized */
  get isConnected(): boolean {
    return this.initialized && !this.closed && this.process !== null;
  }

  /**
   * Spawn the app-server process and perform the initialization handshake.
   * Must be called before any other method.
   */
  async connect(): Promise<void> {
    if (this.closed) throw new ClientClosedError();
    if (this.initialized) throw new ClientStateError("Client is already connected");
    if (this.connecting) throw new ClientConnectingError();

    this.connecting = true;

    try {
      this.process = spawn(this.binaryPath, ["app-server"], {
        cwd: this.cwd,
        env: this.env ? { ...process.env, ...this.env } : undefined,
        stdio: ["pipe", "pipe", "pipe"],
      });

      if (!this.process.stdout || !this.process.stdin) {
        throw new StdioError("Failed to open stdio pipes for codex app-server");
      }

      // Drain stderr to prevent the child process from blocking when
      // the pipe buffer fills up.
      this.process.stderr?.resume();

      // Set up line-based reading from stdout
      this.readline = createInterface({ input: this.process.stdout });
      this.readline.on("line", (line) => this.handleLine(line));

      // Handle process exit
      this.process.once("exit", (code, signal) => {
        this.handleProcessExit(code, signal);
      });

      this.process.once("error", (err) => {
        this.handleProcessError(err);
      });

      await this.initialize();
    } catch (err) {
      this.connecting = false;
      await this.close();
      // Reset closed flag so the client can retry connect() after a
      // transient handshake failure. The guard on line 172 ensures
      // this.closed is always false when we reach this point.
      this.closed = false;
      // Wrap non-CodexClientError errors
      if (!(err instanceof CodexClientError)) {
        throw new ProcessError(
          `Failed to connect to codex app-server: ${err instanceof Error ? err.message : String(err)}`,
          null,
          null,
          err,
        );
      }
      throw err;
    }

    this.connecting = false;
  }

  /**
   * Gracefully close the app-server process.
   * Sends SIGTERM first, then SIGKILL after timeout.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.initialized = false;

    // Reject all pending requests
    const closedError = new ClientClosedError();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(closedError);
      this.pending.delete(id);
    }

    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }

    if (this.process && this.process.exitCode === null) {
      const proc = this.process;

      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // Already dead
          }
          resolve();
        }, 5_000);

        proc.once("exit", () => {
          clearTimeout(killTimer);
          resolve();
        });

        try {
          proc.kill("SIGTERM");
        } catch {
          clearTimeout(killTimer);
          resolve();
        }
      });
    }

    this.process = null;
  }

  // ---------------------------------------------------------------------------
  // Thread Management
  // ---------------------------------------------------------------------------

  /** Create a new conversation thread */
  async threadStart(params: ThreadStartParams = {}): Promise<Record<string, unknown>> {
    return this.sendRequest("thread/start", { ...params });
  }

  /** Resume an existing conversation thread by ID */
  async threadResume(threadId: string): Promise<Record<string, unknown>> {
    return this.sendRequest("thread/resume", { threadId });
  }

  /** List threads (with optional cursor-based pagination) */
  async threadList(cursor?: string, limit?: number): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = {};
    if (cursor) params["cursor"] = cursor;
    if (limit !== undefined) params["limit"] = limit;
    return this.sendRequest("thread/list", params);
  }

  /** Archive a thread */
  async threadArchive(threadId: string): Promise<Record<string, unknown>> {
    return this.sendRequest("thread/archive", { threadId });
  }

  // ---------------------------------------------------------------------------
  // Turn Management
  // ---------------------------------------------------------------------------

  /** Start a new turn (send a message to the agent) */
  async turnStart(params: TurnStartParams): Promise<Record<string, unknown>> {
    return this.sendRequest("turn/start", {
      threadId: params.threadId,
      input: [{ type: "text", text: params.input }],
      ...(params.cwd ? { cwd: params.cwd } : {}),
      ...(params.model ? { model: params.model } : {}),
    });
  }

  /** Interrupt a running turn */
  async turnInterrupt(threadId: string, turnId: string): Promise<Record<string, unknown>> {
    return this.sendRequest("turn/interrupt", { threadId, turnId });
  }

  // ---------------------------------------------------------------------------
  // Model Discovery
  // ---------------------------------------------------------------------------

  /** List available models */
  async modelList(cursor?: string, limit?: number): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = {};
    if (cursor) params["cursor"] = cursor;
    if (limit !== undefined) params["limit"] = limit;
    return this.sendRequest("model/list", params);
  }

  // ---------------------------------------------------------------------------
  // Low-level Protocol
  // ---------------------------------------------------------------------------

  /** Send a JSON-RPC request and wait for the response */
  async sendRequest(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (!this.initialized && method !== "initialize") {
      throw new ClientNotInitializedError();
    }
    if (this.closed) throw new ClientClosedError();
    if (!this.process?.stdin?.writable) {
      throw new StdioError("stdin not writable — process may have exited");
    }

    const id = randomUUID();
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RequestTimeoutError(method, this.requestTimeout));
      }, this.requestTimeout);

      this.pending.set(id, { resolve, reject, timer });
      this.writeLine(JSON.stringify(request));
    });
  }

  /** Send a JSON-RPC notification (no response expected) */
  sendNotification(method: string, params: Record<string, unknown> = {}): void {
    if (this.closed) return;
    if (!this.process?.stdin?.writable) return;

    this.writeLine(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  /** Respond to an approval request from the server */
  sendApprovalResponse(id: string | number, decision: ApprovalDecision): void {
    if (this.closed) return;
    if (!this.process?.stdin?.writable) return;

    this.writeLine(JSON.stringify({ jsonrpc: "2.0", id, result: { decision } }));
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async initialize(): Promise<void> {
    const result = await this.sendRequest("initialize", {
      clientInfo: {
        name: "ao-agent-codex",
        title: "Agent Orchestrator — Codex Plugin",
        version: "0.1.1",
      },
    });

    // Send the initialized notification to complete the handshake
    this.sendNotification("initialized", {});
    this.initialized = true;
    this.emit("connected", result);
  }

  private writeLine(line: string): void {
    if (!this.process?.stdin?.writable) return;
    this.process.stdin.write(line + "\n");
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: ServerMessage;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
      msg = parsed as ServerMessage;
    } catch {
      // Skip malformed lines
      return;
    }

    // Classify the message
    if ("id" in msg && msg.id !== undefined) {
      const id = String(msg.id);

      // Check if this is a response to a pending request
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        clearTimeout(pending.timer);

        if ("error" in msg && msg.error) {
          pending.reject(new JsonRpcServerError(msg.error));
        } else {
          pending.resolve((msg as JsonRpcResponse).result ?? {});
        }
        return;
      }

      // If not a pending response, it's a server-initiated request (approval)
      if ("method" in msg && typeof msg.method === "string") {
        this.handleApprovalRequest(msg as JsonRpcApprovalRequest);
        return;
      }
    }

    // Notification (no id, has method)
    if ("method" in msg && typeof msg.method === "string" && !("id" in msg)) {
      const notification = msg as JsonRpcNotification;
      this.emit("notification", notification.method, notification.params);
      if (this.onNotification) {
        this.onNotification(notification.method, notification.params);
      }
    }
  }

  private async handleApprovalRequest(request: JsonRpcApprovalRequest): Promise<void> {
    try {
      this.emit("approval", request.id, request.method, request.params);

      if (this.onApproval) {
        const decision = await this.onApproval(request.id, request.method, request.params);
        this.sendApprovalResponse(request.id, decision);
      } else {
        // Default: auto-accept all approvals
        this.sendApprovalResponse(request.id, "accept");
      }
    } catch {
      // On any error (listener throw or handler rejection), decline the request
      this.sendApprovalResponse(request.id, "decline");
    }
  }

  private handleProcessExit(code: number | null, signal: string | null): void {
    this.initialized = false;

    // Close readline to release the event listener on the closed stdout stream
    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }

    // Reject all pending requests
    const processError = new ProcessError(
      `codex app-server exited (code=${code}, signal=${signal})`,
      code,
      signal,
    );
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(processError);
      this.pending.delete(id);
    }

    this.emit("exit", code, signal);
  }

  private handleProcessError(err: Error): void {
    this.initialized = false;

    // Close readline to release the event listener on the closed stdout stream
    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }

    // Reject all pending requests before emitting "error" — emit("error")
    // with no listeners throws synchronously, which would skip cleanup.
    const processError = new ProcessError(
      `Process error: ${err.message}`,
      null,
      null,
      err,
    );
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(processError);
      this.pending.delete(id);
    }

    this.emit("error", processError);
  }
}
