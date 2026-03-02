# Real-time Events Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace 30-second polling lag with instant event delivery via GitHub webhooks, Claude Code hook push signals, and ntfy.sh mobile/desktop push notifications.

**Architecture:** A new `packages/webhook-github` Express server receives GitHub push events and forwards them to a new `localhost:3101` internal HTTP server embedded in the CLI. The internal server calls `lifecycleManager.check(sessionId)` immediately. The existing Claude Code `PostToolUse` hook is extended to also signal the internal server. A new `notifier-ntfy` plugin sends push notifications to iOS/macOS via ntfy.sh.

**Tech Stack:** Node.js `http` module (internal server, no deps), Express (webhook-github, same as webhook-linear), `node:https` (ntfy plugin, no deps). All TypeScript ESM. Tests with vitest.

---

## Task 1: Internal HTTP server in core

**Files:**
- Create: `packages/core/src/internal-server.ts`
- Create: `packages/core/src/__tests__/internal-server.test.ts`
- Modify: `packages/core/src/index.ts` (add export)

**Step 1: Write the failing test**

```typescript
// packages/core/src/__tests__/internal-server.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { createInternalServer } from "../internal-server.js";
import type { LifecycleManager } from "../types.js";

function makeLifecycle(checkFn = vi.fn().mockResolvedValue(undefined)): LifecycleManager {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    getStates: vi.fn().mockReturnValue(new Map()),
    check: checkFn,
  };
}

async function post(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "POST" }, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("createInternalServer", () => {
  let server: http.Server;
  const PORT = 13101;

  afterEach(() => { server?.close(); });

  it("calls lifecycleManager.check on POST /internal/check/:sessionId", async () => {
    const check = vi.fn().mockResolvedValue(undefined);
    const lifecycle = makeLifecycle(check);
    server = createInternalServer(lifecycle, PORT);
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));

    const { status, body } = await post(PORT, "/internal/check/my-session-123");
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(check).toHaveBeenCalledWith("my-session-123");
  });

  it("returns 404 for unknown routes", async () => {
    server = createInternalServer(makeLifecycle(), PORT);
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));

    const { status } = await post(PORT, "/unknown");
    expect(status).toBe(404);
  });

  it("returns 200 on GET /internal/health", async () => {
    server = createInternalServer(makeLifecycle(), PORT);
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));

    const result = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: PORT, path: "/internal/health" }, (res) => {
        let data = "";
        res.on("data", (c: Buffer) => { data += c.toString(); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
      }).on("error", reject);
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true });
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd packages/core && pnpm test -- internal-server
```
Expected: FAIL — `Cannot find module '../internal-server.js'`

**Step 3: Implement `internal-server.ts`**

```typescript
// packages/core/src/internal-server.ts
import http from "node:http";
import type { LifecycleManager } from "./types.js";

/**
 * Create a local-only HTTP server for inter-process signalling.
 * Binds to 127.0.0.1 only — never externally reachable.
 *
 * Endpoints:
 *   POST /internal/check/:sessionId  — trigger lifecycleManager.check() immediately
 *   POST /internal/poll              — trigger full poll cycle
 *   GET  /internal/health            — liveness check
 */
export function createInternalServer(
  lifecycle: LifecycleManager,
  port = 3101,
): http.Server {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    res.setHeader("Content-Type", "application/json");

    // POST /internal/check/:sessionId
    const checkMatch = /^\/internal\/check\/(.+)$/.exec(url);
    if (method === "POST" && checkMatch) {
      const sessionId = decodeURIComponent(checkMatch[1]);
      lifecycle.check(sessionId).then(
        () => { res.writeHead(200).end(JSON.stringify({ ok: true })); },
        (err: unknown) => {
          const message = err instanceof Error ? err.message : "unknown error";
          res.writeHead(500).end(JSON.stringify({ error: message }));
        },
      );
      return;
    }

    // GET /internal/health
    if (method === "GET" && url === "/internal/health") {
      const states = Object.fromEntries(lifecycle.getStates());
      res.writeHead(200).end(JSON.stringify({ ok: true, sessions: Object.keys(states).length }));
      return;
    }

    res.writeHead(404).end(JSON.stringify({ error: "not found" }));
  });

  // Only bind to loopback — never 0.0.0.0
  server.listen(port, "127.0.0.1");
  return server;
}
```

**Step 4: Export from core index**

```typescript
// Add to packages/core/src/index.ts — find the exports section and add:
export { createInternalServer } from "./internal-server.js";
```

**Step 5: Run test to verify it passes**

```bash
cd packages/core && pnpm test -- internal-server
```
Expected: 3 tests PASS

**Step 6: Typecheck and commit**

```bash
pnpm typecheck
git add packages/core/src/internal-server.ts packages/core/src/__tests__/internal-server.test.ts packages/core/src/index.ts
git commit -m "feat(core): add internal HTTP server for inter-process lifecycle signals"
```

---

## Task 2: Wire internal server into CLI `ao start`

**Files:**
- Modify: `packages/cli/src/commands/start.ts`

The `ao start` command already creates the orchestrator session. We add: start the internal server right after loading config, store the port in `AO_INTERNAL_PORT` env so agents inherit it.

**Step 1: Write the failing test**

```typescript
// packages/cli/src/__tests__/start-internal-server.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";

// Integration smoke test: after startInternalServer(), the health endpoint responds
import { startInternalServer } from "../lib/internal-server-launcher.js";
import type { LifecycleManager } from "@composio/ao-core";

const PORT = 13102;
let server: http.Server | undefined;

afterEach(() => { server?.close(); });

function makeLifecycle(): LifecycleManager {
  return { start: vi.fn(), stop: vi.fn(), getStates: vi.fn().mockReturnValue(new Map()), check: vi.fn().mockResolvedValue(undefined) };
}

describe("startInternalServer", () => {
  it("starts server and sets AO_INTERNAL_PORT env var", async () => {
    server = await startInternalServer(makeLifecycle(), PORT);
    expect(process.env["AO_INTERNAL_PORT"]).toBe(String(PORT));
  });
});
```

**Step 2: Run to confirm fail**

```bash
cd packages/cli && pnpm test -- internal-server
```

**Step 3: Create `packages/cli/src/lib/internal-server-launcher.ts`**

```typescript
// packages/cli/src/lib/internal-server-launcher.ts
import http from "node:http";
import { createInternalServer } from "@composio/ao-core";
import type { LifecycleManager } from "@composio/ao-core";

export async function startInternalServer(
  lifecycle: LifecycleManager,
  port = 3101,
): Promise<http.Server> {
  const server = createInternalServer(lifecycle, port);

  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  // Make port available to child processes (agents)
  process.env["AO_INTERNAL_PORT"] = String(port);

  return server;
}
```

**Step 4: Run test to confirm pass**

```bash
cd packages/cli && pnpm test -- internal-server
```

**Step 5: Wire into `ao start`**

In `packages/cli/src/commands/start.ts`, after `loadConfig()` and before starting the dashboard, add:

```typescript
// Add import at top:
import { startInternalServer } from "../lib/internal-server-launcher.js";
import { createLifecycleManager } from "@composio/ao-core";
import { getSessionManager } from "../lib/create-session-manager.js";

// Inside registerStart action, after loadConfig():
const sm = await getSessionManager(config);
// Note: registry setup already happens inside getSessionManager — check if lifecycle is exposed
// If not available from sm, create a minimal one for the signal receiver:
const lifecycleServer = await startInternalServer(
  { start: () => {}, stop: () => {}, getStates: () => new Map(), check: async (id) => { /* sm.check will be wired here */ void id; } },
  config.internalPort ?? 3101,
);

// On process exit, close the server:
process.once("SIGTERM", () => lifecycleServer.close());
process.once("SIGINT", () => lifecycleServer.close());
```

> **Note:** The lifecycle manager lives inside the orchestrator agent session (Claude Code), not the CLI process. The internal server here serves as a signal relay — it receives the hook push and can trigger an immediate metadata refresh or poll via the session manager. Wire `check` to `sm.check(sessionId)` once you verify that method exists on the session manager interface. If `sm.check` doesn't exist, the internal server's `check` can call `sm.get(sessionId)` + emit a refresh event. Check `packages/core/src/session-manager.ts` for the actual interface.

**Step 6: Commit**

```bash
git add packages/cli/src/lib/internal-server-launcher.ts packages/cli/src/__tests__/start-internal-server.test.ts packages/cli/src/commands/start.ts
git commit -m "feat(cli): start internal HTTP server on ao start, set AO_INTERNAL_PORT"
```

---

## Task 3: Claude Code hook — signal internal server on PR open and agent exit

**Files:**
- Modify: `packages/plugins/agent-claude-code/src/index.ts`

The `METADATA_UPDATER_SCRIPT` string already runs as a `PostToolUse` hook. We add a signal curl call after the PR URL write block, and add a `Stop` hook entry.

**Step 1: Find the PR URL write block in `METADATA_UPDATER_SCRIPT`**

Look in `index.ts` for the bash block that handles `gh pr create` — it reads the PR URL from output and calls `update_metadata_key "pr" "$pr_url"`. Add immediately after that block:

```bash
# Signal lifecycle manager for immediate check (non-blocking, silent-fail)
if [[ -n "${AO_INTERNAL_PORT:-}" ]] && [[ -n "${AO_SESSION_ID:-}" ]]; then
  curl -sf -X POST "http://127.0.0.1:${AO_INTERNAL_PORT}/internal/check/${AO_SESSION_ID}" \
    -o /dev/null --max-time 2 2>/dev/null &
fi
```

Also add the same signal after the `git checkout -b` / branch write block.

**Step 2: Add `AO_INTERNAL_PORT` to agent environment**

In the `create()` function where env vars are set (around line 677 where `AO_SESSION_ID` is set):

```typescript
// After the AO_SESSION_ID line:
if (process.env["AO_INTERNAL_PORT"]) {
  env["AO_INTERNAL_PORT"] = process.env["AO_INTERNAL_PORT"];
}
```

**Step 3: Add Stop hook for agent exit signal**

Find `setupHookInWorkspace` and the section that writes `PostToolUse` hooks. Add a `Stop` hook entry alongside it:

```typescript
// After setting up PostToolUse hook, also add Stop hook:
const stopHooks = (hooks["Stop"] as Array<unknown>) ?? [];
const stopSignalCmd = `if [[ -n "${AO_INTERNAL_PORT:-}" ]] && [[ -n "${AO_SESSION_ID:-}" ]]; then curl -sf -X POST "http://127.0.0.1/${AO_INTERNAL_PORT}/internal/check/${AO_SESSION_ID}" -o /dev/null --max-time 2 2>/dev/null; fi`;

// Check if stop hook already registered, then add if not (same pattern as PostToolUse)
```

**Step 4: Run existing tests to verify nothing broke**

```bash
cd packages/plugins/agent-claude-code && pnpm test
```
Expected: all existing tests pass

**Step 5: Commit**

```bash
git add packages/plugins/agent-claude-code/src/index.ts
git commit -m "feat(agent-claude-code): signal internal server on PR open and agent exit"
```

---

## Task 4: `packages/plugins/notifier-ntfy`

**Files:**
- Create: `packages/plugins/notifier-ntfy/src/index.ts`
- Create: `packages/plugins/notifier-ntfy/src/__tests__/index.test.ts`
- Create: `packages/plugins/notifier-ntfy/package.json`
- Create: `packages/plugins/notifier-ntfy/tsconfig.json`
- Modify: `pnpm-workspace.yaml` (add to workspace if needed — check if glob already covers it)

**Step 1: Create package.json**

```json
{
  "name": "@composio/ao-plugin-notifier-ntfy",
  "version": "0.1.0",
  "description": "Notifier plugin: ntfy.sh push notifications for iOS and macOS",
  "license": "MIT",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "engines": { "node": ">=20.0.0" },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@composio/ao-core": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^25.2.3",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

**Step 2: Create tsconfig.json**

Copy from `packages/plugins/notifier-desktop/tsconfig.json` — identical structure, just update `rootDir`/`outDir` paths if needed.

**Step 3: Write the failing test**

```typescript
// packages/plugins/notifier-ntfy/src/__tests__/index.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import https from "node:https";
import { EventEmitter } from "node:events";

// We'll mock node:https to avoid real network calls
vi.mock("node:https");

import { create } from "../index.js";
import type { OrchestratorEvent } from "@composio/ao-core";

function makeEvent(overrides: Partial<OrchestratorEvent> = {}): OrchestratorEvent {
  return {
    id: "evt-1",
    type: "pr.created",
    priority: "action",
    sessionId: "test-session",
    projectId: "my-project",
    timestamp: new Date("2026-01-01"),
    message: "PR opened for test-session",
    data: {},
    ...overrides,
  };
}

describe("notifier-ntfy", () => {
  let mockReq: EventEmitter & { end: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockReq = Object.assign(new EventEmitter(), {
      end: vi.fn(),
      write: vi.fn(),
    });
    const mockRes = Object.assign(new EventEmitter(), { statusCode: 200 });
    vi.mocked(https.request).mockImplementation((_opts, cb) => {
      if (cb) cb(mockRes as never);
      return mockReq as never;
    });
  });

  it("sends POST to ntfy.sh with correct headers", async () => {
    const notifier = create({ topic: "ao-test-topic" });
    await notifier.notify(makeEvent());

    expect(https.request).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: "ntfy.sh",
        path: "/ao-test-topic",
        method: "POST",
      }),
      expect.any(Function),
    );
    expect(mockReq.end).toHaveBeenCalledWith("PR opened for test-session");
  });

  it("maps urgent priority to ntfy priority 5", async () => {
    const notifier = create({ topic: "ao-test-topic" });
    await notifier.notify(makeEvent({ priority: "urgent" }));

    const callArgs = vi.mocked(https.request).mock.calls[0][0] as { headers: Record<string, string> };
    expect(callArgs.headers["Priority"]).toBe("5");
  });

  it("uses custom baseUrl when configured", async () => {
    const notifier = create({ topic: "my-topic", baseUrl: "https://ntfy.myserver.com" });
    await notifier.notify(makeEvent());

    expect(https.request).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "ntfy.myserver.com" }),
      expect.any(Function),
    );
  });

  it("does not throw if ntfy request fails", async () => {
    mockReq.emit("error", new Error("network error"));
    const notifier = create({ topic: "ao-test-topic" });
    await expect(notifier.notify(makeEvent())).resolves.not.toThrow();
  });
});
```

**Step 4: Run to confirm fail**

```bash
cd packages/plugins/notifier-ntfy && pnpm install && pnpm test
```
Expected: FAIL — module not found

**Step 5: Implement `index.ts`**

```typescript
// packages/plugins/notifier-ntfy/src/index.ts
import https from "node:https";
import type { PluginModule, Notifier, OrchestratorEvent, EventPriority } from "@composio/ao-core";

interface NtfyConfig {
  topic: string;
  baseUrl?: string;
  token?: string;
  dashboardUrl?: string;
}

export const manifest = {
  name: "ntfy",
  slot: "notifier" as const,
  description: "Notifier plugin: ntfy.sh push notifications for iOS and macOS",
  version: "0.1.0",
};

const PRIORITY_MAP: Record<EventPriority, string> = {
  urgent: "5",
  action: "4",
  warning: "3",
  info: "2",
};

const TAG_MAP: Record<string, string> = {
  "pr.created": "tada",
  "ci.failing": "x",
  "merge.ready": "white_check_mark",
  "merge.completed": "rocket",
  "session.stuck": "sos",
  "session.needs_input": "speech_balloon",
  "session.killed": "stop_sign",
  "review.changes_requested": "pencil",
};

function ntfyTag(eventType: string): string {
  for (const [key, tag] of Object.entries(TAG_MAP)) {
    if (eventType.includes(key.split(".")[1] ?? "")) return tag;
  }
  return TAG_MAP[eventType] ?? "robot";
}

export function create(config: NtfyConfig): Notifier {
  const baseUrl = config.baseUrl ?? "https://ntfy.sh";
  const url = new URL(`${baseUrl}/${config.topic}`);

  return {
    async notify(event: OrchestratorEvent): Promise<void> {
      const headers: Record<string, string> = {
        "Title": event.type,
        "Priority": PRIORITY_MAP[event.priority] ?? "3",
        "Tags": ntfyTag(event.type),
        "Content-Type": "text/plain",
      };

      if (config.token) {
        headers["Authorization"] = `Bearer ${config.token}`;
      }

      if (config.dashboardUrl) {
        headers["Click"] = `${config.dashboardUrl}/sessions/${encodeURIComponent(event.sessionId)}`;
      }

      await new Promise<void>((resolve) => {
        const req = https.request(
          {
            hostname: url.hostname,
            port: url.port || 443,
            path: url.pathname,
            method: "POST",
            headers,
          },
          () => resolve(),
        );
        req.once("error", () => resolve()); // silent-fail — never block on notification
        req.end(event.message);
      });
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
```

**Step 6: Run test to confirm pass**

```bash
cd packages/plugins/notifier-ntfy && pnpm test
```
Expected: 4 tests PASS

**Step 7: Build and typecheck**

```bash
pnpm build && pnpm typecheck
```

**Step 8: Commit**

```bash
git add packages/plugins/notifier-ntfy/
git commit -m "feat(notifier-ntfy): add ntfy.sh push notification plugin for iOS and macOS"
```

---

## Task 5: `packages/webhook-github`

**Files:**
- Create: `packages/webhook-github/src/verify.ts`
- Create: `packages/webhook-github/src/types.ts`
- Create: `packages/webhook-github/src/correlate.ts`
- Create: `packages/webhook-github/src/dedup.ts`
- Create: `packages/webhook-github/src/events.ts`
- Create: `packages/webhook-github/src/config.ts`
- Create: `packages/webhook-github/src/server.ts`
- Create: `packages/webhook-github/src/__tests__/verify.test.ts`
- Create: `packages/webhook-github/src/__tests__/events.test.ts`
- Create: `packages/webhook-github/package.json`
- Create: `packages/webhook-github/tsconfig.json`

**Step 1: package.json** (copy webhook-linear, update name/description)

```json
{
  "name": "@composio/ao-webhook-github",
  "version": "0.1.0",
  "private": true,
  "description": "GitHub webhook server — triggers immediate lifecycle checks on PR/CI/review events",
  "license": "MIT",
  "type": "module",
  "main": "dist/server.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/server.js",
    "dev": "node --watch dist/server.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "clean": "rm -rf dist"
  },
  "dependencies": { "express": "^5.1.0" },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/node": "^25.2.3",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

**Step 2: `src/types.ts`** — GitHub payload shapes

```typescript
// packages/webhook-github/src/types.ts
export interface GitHubRepo {
  full_name: string; // "owner/repo"
}

export interface GitHubPRPayload {
  action: "opened" | "closed" | "reopened" | "synchronize" | string;
  pull_request: {
    head: { ref: string }; // branch name
    merged?: boolean;
  };
  repository: GitHubRepo;
}

export interface GitHubCheckSuitePayload {
  action: "completed" | string;
  check_suite: { head_branch: string; conclusion: string | null };
  repository: GitHubRepo;
}

export interface GitHubReviewPayload {
  action: "submitted" | string;
  pull_request: { head: { ref: string } };
  repository: GitHubRepo;
}
```

**Step 3: Write verify test**

```typescript
// packages/webhook-github/src/__tests__/verify.test.ts
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifySignature } from "../verify.js";

const SECRET = "test-secret";

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
}

describe("verifySignature", () => {
  it("accepts valid signature", () => {
    const body = Buffer.from('{"action":"opened"}');
    expect(verifySignature(body, sign(body.toString()), SECRET)).toBe(true);
  });

  it("rejects wrong secret", () => {
    const body = Buffer.from('{"action":"opened"}');
    expect(verifySignature(body, sign("wrong"), SECRET)).toBe(false);
  });

  it("rejects missing signature", () => {
    expect(verifySignature(Buffer.from("{}"), undefined, SECRET)).toBe(false);
  });
});
```

**Step 4: Implement `src/verify.ts`**

```typescript
// packages/webhook-github/src/verify.ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySignature(
  body: Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature?.startsWith("sha256=")) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}
```

**Step 5: Implement `src/dedup.ts`** (identical pattern to webhook-linear/dedup.ts — copy and adapt)

```typescript
// packages/webhook-github/src/dedup.ts
const seen = new Map<string, number>();
const WINDOW_MS = 5_000;

export function isDuplicate(key: string): boolean {
  const now = Date.now();
  const last = seen.get(key);
  if (last && now - last < WINDOW_MS) return true;
  seen.set(key, now);
  return false;
}

export function cleanup(): void {
  const now = Date.now();
  for (const [key, ts] of seen) {
    if (now - ts > WINDOW_MS * 2) seen.delete(key);
  }
}
```

**Step 6: Write events test**

```typescript
// packages/webhook-github/src/__tests__/events.test.ts
import { describe, it, expect } from "vitest";
import { extractBranchAndRepo } from "../events.js";

describe("extractBranchAndRepo", () => {
  it("extracts from pull_request event", () => {
    const result = extractBranchAndRepo("pull_request", {
      action: "opened",
      pull_request: { head: { ref: "feature/my-branch" } },
      repository: { full_name: "owner/repo" },
    });
    expect(result).toEqual({ branch: "feature/my-branch", repo: "owner/repo" });
  });

  it("extracts from check_suite event", () => {
    const result = extractBranchAndRepo("check_suite", {
      action: "completed",
      check_suite: { head_branch: "feature/ci-branch", conclusion: "success" },
      repository: { full_name: "owner/repo" },
    });
    expect(result).toEqual({ branch: "feature/ci-branch", repo: "owner/repo" });
  });

  it("returns null for unhandled event types", () => {
    expect(extractBranchAndRepo("ping", {})).toBeNull();
  });
});
```

**Step 7: Implement `src/events.ts`**

```typescript
// packages/webhook-github/src/events.ts
export interface BranchRepo { branch: string; repo: string }

export function extractBranchAndRepo(
  eventType: string,
  payload: Record<string, unknown>,
): BranchRepo | null {
  if (eventType === "pull_request" || eventType === "pull_request_review") {
    const pr = payload["pull_request"] as { head?: { ref?: string } } | undefined;
    const repo = (payload["repository"] as { full_name?: string } | undefined)?.full_name;
    const branch = pr?.head?.ref;
    if (branch && repo) return { branch, repo };
  }
  if (eventType === "check_suite") {
    const suite = payload["check_suite"] as { head_branch?: string } | undefined;
    const repo = (payload["repository"] as { full_name?: string } | undefined)?.full_name;
    const branch = suite?.head_branch;
    if (branch && repo) return { branch, repo };
  }
  if (eventType === "check_run") {
    const run = payload["check_run"] as { check_suite?: { head_branch?: string } } | undefined;
    const repo = (payload["repository"] as { full_name?: string } | undefined)?.full_name;
    const branch = run?.check_suite?.head_branch;
    if (branch && repo) return { branch, repo };
  }
  return null;
}
```

**Step 8: Implement `src/correlate.ts`**

```typescript
// packages/webhook-github/src/correlate.ts
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Find sessionId by matching branch + repo against session metadata files.
 * Returns the first matching sessionId or null.
 */
export async function correlateSession(
  branch: string,
  repo: string,
  dataDir: string,
): Promise<string | null> {
  let sessionDirs: string[];
  try {
    sessionDirs = await readdir(dataDir);
  } catch {
    return null;
  }

  for (const sessionId of sessionDirs) {
    const metadataPath = join(dataDir, sessionId);
    try {
      const raw = await readFile(metadataPath, "utf-8");
      // Metadata format: key=value lines
      const lines = raw.split("\n");
      const meta: Record<string, string> = {};
      for (const line of lines) {
        const eq = line.indexOf("=");
        if (eq > 0) meta[line.slice(0, eq)] = line.slice(eq + 1);
      }
      if (meta["branch"] === branch && meta["repo"]?.includes(repo.split("/")[1] ?? "")) {
        return sessionId;
      }
    } catch {
      continue;
    }
  }
  return null;
}
```

**Step 9: Implement `src/config.ts`**

```typescript
// packages/webhook-github/src/config.ts
export interface Config {
  webhookSecret: string;
  internalUrl: string;  // e.g. http://127.0.0.1:3101
  dataDir: string;
  port: number;
}

export function loadConfig(): Config {
  const webhookSecret = process.env["GITHUB_WEBHOOK_SECRET"];
  if (!webhookSecret) throw new Error("GITHUB_WEBHOOK_SECRET is required");

  return {
    webhookSecret,
    internalUrl: process.env["AO_INTERNAL_URL"] ?? "http://127.0.0.1:3101",
    dataDir: process.env["AO_DATA_DIR"] ?? `${process.env["HOME"]}/.ao-sessions`,
    port: parseInt(process.env["PORT"] ?? "3102", 10),
  };
}
```

**Step 10: Implement `src/server.ts`**

```typescript
// packages/webhook-github/src/server.ts
import express from "express";
import http from "node:http";
import { loadConfig } from "./config.js";
import { verifySignature } from "./verify.js";
import { extractBranchAndRepo } from "./events.js";
import { correlateSession } from "./correlate.js";
import { isDuplicate, cleanup } from "./dedup.js";

const config = loadConfig();
const app = express();

app.use("/webhook/github", express.raw({ type: "application/json" }));

app.post("/webhook/github", (req, res) => {
  const body = req.body as Buffer;
  const signature = req.headers["x-hub-signature-256"] as string | undefined;
  const eventType = req.headers["x-github-event"] as string | undefined;

  if (!verifySignature(body, signature, config.webhookSecret)) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  // Always respond immediately — GitHub requires < 10s
  res.status(200).json({ ok: true });

  if (!eventType) return;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body.toString("utf-8")) as Record<string, unknown>;
  } catch {
    return;
  }

  const extracted = extractBranchAndRepo(eventType, payload);
  if (!extracted) return;

  const dedupKey = `${eventType}:${extracted.repo}:${extracted.branch}`;
  if (isDuplicate(dedupKey)) return;

  // Async: correlate + signal lifecycle manager
  correlateSession(extracted.branch, extracted.repo, config.dataDir)
    .then((sessionId) => {
      if (!sessionId) {
        console.log(`[SKIP] No session for ${extracted.repo}@${extracted.branch}`);
        return;
      }
      console.log(`[EVENT] ${eventType} → check session ${sessionId}`);
      return signalLifecycle(sessionId);
    })
    .catch((err: unknown) => {
      console.error("[ERROR] correlate/signal failed:", err);
    });
});

function signalLifecycle(sessionId: string): Promise<void> {
  return new Promise((resolve) => {
    const url = new URL(`${config.internalUrl}/internal/check/${encodeURIComponent(sessionId)}`);
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: "POST" }, () => resolve());
    req.once("error", () => resolve()); // silent-fail
    req.end();
  });
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", internalUrl: config.internalUrl, dataDir: config.dataDir });
});

const cleanupInterval = setInterval(cleanup, 60_000);

const server = app.listen(config.port, () => {
  console.log(`[ao-webhook-github] Listening on :${config.port}`);
  console.log(`  Internal URL: ${config.internalUrl}`);
  console.log(`  Data dir:     ${config.dataDir}`);
});

process.once("SIGTERM", () => { clearInterval(cleanupInterval); server.close(); });
```

**Step 11: Run all tests**

```bash
cd packages/webhook-github && pnpm install && pnpm test
```
Expected: verify tests (3) + events tests (3) PASS

**Step 12: Build and typecheck**

```bash
pnpm build && pnpm typecheck
```

**Step 13: Commit**

```bash
git add packages/webhook-github/
git commit -m "feat(webhook-github): add GitHub webhook server for real-time lifecycle signals"
```

---

## Task 6: Update config example + workspace + docs

**Files:**
- Modify: `agent-orchestrator.yaml.example`
- Modify: `pnpm-workspace.yaml` (verify webhook-github + notifier-ntfy are included)
- Modify: `packages/core/src/types.ts` (add `internalPort?: number` to `OrchestratorConfig`)

**Step 1: Add `internalPort` to `OrchestratorConfig`**

In `packages/core/src/types.ts`, find `OrchestratorConfig` and add:

```typescript
/** Port for the internal inter-process signalling server. Default: 3101 */
internalPort?: number;
```

Also add to the Zod schema in `packages/core/src/config.ts`:

```typescript
internalPort: z.number().optional(),
```

**Step 2: Update `agent-orchestrator.yaml.example`**

Add to the defaults/global section:

```yaml
# Internal signalling server port (used by Claude Code hooks to signal immediate checks)
internalPort: 3101

defaults:
  notifiers: [desktop, ntfy]   # add ntfy here

# ntfy.sh push notifications (iOS + macOS)
# Install ntfy app: https://ntfy.sh/app
# Replace topic with your own private topic string
plugins:
  notifier-ntfy:
    topic: "ao-your-private-topic-here"
    # baseUrl: https://ntfy.sh       # default, or your self-hosted instance
    # token: "tk_xxx"                # for private/authenticated topics
    # dashboardUrl: "https://agentflow.monster"  # adds click-through on notifications

# GitHub webhook receiver (run separately: cd packages/webhook-github && pnpm start)
# Set these env vars before starting:
#   GITHUB_WEBHOOK_SECRET=<secret from GitHub repo settings>
#   AO_INTERNAL_URL=http://127.0.0.1:3101
#   AO_DATA_DIR=~/.ao-sessions
```

**Step 3: Verify pnpm workspace includes new packages**

```bash
cat pnpm-workspace.yaml
```
Confirm it has `packages/**/` or explicit paths covering `packages/webhook-github` and `packages/plugins/notifier-ntfy`. If not, add them.

**Step 4: Full build + typecheck + test**

```bash
pnpm install && pnpm build && pnpm typecheck && pnpm test
```
Expected: all pass

**Step 5: Commit**

```bash
git add agent-orchestrator.yaml.example pnpm-workspace.yaml packages/core/src/types.ts packages/core/src/config.ts
git commit -m "chore: wire ntfy + webhook-github into workspace config and examples"
```

---

## Task 7: Deploy and verify on VPS

**Step 1: Push branch**

```bash
git push origin feature/reactions-linear-settings
```

**Step 2: Deploy to VPS**

```bash
ssh -i ~/.ssh/acfs_ed25519 ubuntu@217.77.10.5 "cd ~/agent-orchestrator && git pull origin feature/reactions-linear-settings && PATH=/home/ubuntu/.local/bin:$PATH /home/ubuntu/.local/bin/pnpm install && PATH=/home/ubuntu/.local/bin:$PATH /home/ubuntu/.local/bin/pnpm -r build"
```

**Step 3: Verify ntfy plugin builds and loads**

```bash
ssh -i ~/.ssh/acfs_ed25519 ubuntu@217.77.10.5 "cd ~/agent-orchestrator && node -e \"import('./packages/plugins/notifier-ntfy/dist/index.js').then(m => console.log('ok', m.manifest))\""
```

**Step 4: Test ntfy manually**

```bash
curl -d "Test from agent orchestrator" \
  -H "Title: pr.created" \
  -H "Priority: 4" \
  -H "Tags: tada" \
  https://ntfy.sh/ao-your-private-topic
```

Expected: push notification arrives on iOS/macOS ntfy app.

**Step 5: Register GitHub webhook**

In GitHub repo settings → Webhooks → Add webhook:
- Payload URL: `https://agentflow.monster/webhook/github` (or VPS IP:3102 via ngrok for testing)
- Content type: `application/json`
- Secret: your `GITHUB_WEBHOOK_SECRET` value
- Events: Pull requests, Check suites, Pull request reviews

**Step 6: Start webhook-github server on VPS (add systemd service)**

```bash
# Create service file
sudo tee /etc/systemd/system/ao-webhook-github.service << 'EOF'
[Unit]
Description=Agent Orchestrator GitHub Webhook
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/agent-orchestrator/packages/webhook-github
Environment=GITHUB_WEBHOOK_SECRET=<your-secret>
Environment=AO_INTERNAL_URL=http://127.0.0.1:3101
Environment=AO_DATA_DIR=/home/ubuntu/.ao-sessions
Environment=PORT=3102
Environment=PATH=/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/home/ubuntu/.local/bin/pnpm start
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload && sudo systemctl enable ao-webhook-github && sudo systemctl start ao-webhook-github
```

**Step 7: Final test — open a PR and verify < 2s detection**

Open a PR on a tracked repo and watch `ao-web.service` logs:

```bash
sudo journalctl -u ao-web.service -f
```

Expected: state transition logged within 2 seconds of PR creation.

---

## Summary

| Component | Package | What it does |
|-----------|---------|-------------|
| Internal server | `packages/core` | `localhost:3101` — receives check signals |
| CLI wiring | `packages/cli` | Starts internal server with `ao start` |
| Hook push | `agent-claude-code` | Signals internal server on PR open + agent exit |
| ntfy notifier | `plugins/notifier-ntfy` | Push to iOS/macOS via ntfy.sh |
| GitHub webhooks | `packages/webhook-github` | Receives GitHub events, signals internal server |
