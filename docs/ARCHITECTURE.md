# Agent Orchestrator — Technical Architecture

This document explains how the various parts of the Agent Orchestrator communicate with each other, highlighting where HTTP, WebSocket, and SSE are used.

---

## System Overview

```mermaid
graph TB
    subgraph Browser["Browser / Dashboard"]
        UI["React Dashboard\n(Next.js App Router)"]
        SSEClient["EventSource\nuseSessionEvents()"]
        MuxClient["WebSocket Client\nMuxProvider"]
        XTerm["xterm.js\nTerminal UI"]
    end

    subgraph NextJS["Next.js Server — :3000"]
        AppRouter["App Router\n(React SSR)"]
        subgraph HTTPAPI["HTTP REST API  /api/*"]
            Sessions["GET /api/sessions\nGET /api/sessions/:id\nPOST /api/sessions/:id/message\nPOST /api/sessions/:id/restore\nPOST /api/sessions/:id/kill\nPOST /api/spawn"]
            Projects["GET /api/projects\nGET /api/agents\nGET /api/orchestrators"]
            Files["GET /api/sessions/:id/files\nGET /api/sessions/:id/diff/**"]
            PRs["GET /api/issues\nGET /api/backlog\nPOST /api/prs/:id/merge"]
            Misc["POST /api/verify\nPOST /api/setup-labels\nPOST /api/webhooks/**\nGET /api/observability"]
        end
        SSERoute["GET /api/events\n(SSE stream)"]
        SessionMgr["Session Manager\n(core)"]
    end

    subgraph MuxServer["Terminal WS Server — :14801"]
        MuxWS["WebSocket /mux\n(multiplexed)"]
        TermMgr["TerminalManager\n(node-pty)"]
        SessBcast["SessionBroadcaster\n(polls /api/events)"]
    end

    subgraph Agents["AI Agents (per session)"]
        ClaudeCode["Claude Code\n(tmux window)"]
        Codex["Codex\n(tmux window)"]
        Aider["Aider\n(tmux window)"]
        OpenCode["OpenCode\n(tmux window)"]
    end

    subgraph External["External Services"]
        GitHub["GitHub API\n(PRs, Issues, CI)"]
        Linear["Linear API\n(Issues)"]
        GitLab["GitLab API"]
    end

    %% Browser → Next.js HTTP
    UI -- "HTTP GET/POST" --> HTTPAPI
    SSEClient -- "SSE  GET /api/events" --> SSERoute
    MuxClient -- "WebSocket  ws://:14801/mux" --> MuxWS

    %% xterm.js ↔ Mux
    XTerm <-- "terminal frames\n{ch:terminal, type:data}" --> MuxClient

    %% SSE internal polling
    SSERoute -- "polls every 3s" --> SessionMgr
    SessionMgr -- "reads flat files\n~/.agent-orchestrator/" --> SessionMgr

    %% Mux server ↔ Agents (PTY)
    MuxWS --> TermMgr
    TermMgr -- "PTY read/write\nnode-pty" --> ClaudeCode
    TermMgr -- "PTY read/write" --> Codex
    TermMgr -- "PTY read/write" --> Aider
    TermMgr -- "PTY read/write" --> OpenCode

    %% Mux server ↔ Next.js (session patches)
    SessBcast -- "SSE  GET /api/events" --> SSERoute
    SessBcast -- "broadcasts patches\n{ch:sessions}" --> MuxWS

    %% Mux auto-recovery
    TermMgr -- "POST /api/sessions/:id/restore\n(auto-recovery)" --> Sessions

    %% Next.js ↔ External
    Sessions -- "GitHub / GitLab / Linear\nREST API calls" --> External
    PRs -- "GitHub REST API" --> GitHub

    %% Webhooks inbound
    GitHub -- "POST /api/webhooks/**" --> Misc
    GitLab -- "POST /api/webhooks/**" --> Misc
```

---

## Communication Channels

### 1. HTTP / REST — `/api/*` on port 3000

Used for all request-response interactions. The browser calls these directly; the CLI also uses them.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/sessions` | GET | List all sessions (with PR / issue metadata) |
| `/api/sessions/light` | GET | Lightweight session list (minimal fields) |
| `/api/sessions/patches` | GET | Ultra-light patches (id, status, activity) — consumed by the Mux server |
| `/api/sessions/:id` | GET | Full session detail |
| `/api/sessions/:id/message` | POST | Send a message/command to a live agent |
| `/api/sessions/:id/restore` | POST | Respawn a terminated session |
| `/api/sessions/:id/kill` | POST | Terminate a running session |
| `/api/sessions/:id/files` | GET | Browse workspace files |
| `/api/sessions/:id/diff/**` | GET | File diff view |
| `/api/sessions/:id/sub-sessions` | GET / POST | List / create sub-sessions (forked agents) |
| `/api/spawn` | POST | Spawn a new agent session |
| `/api/projects` | GET | List configured projects |
| `/api/agents` | GET | List registered agent plugins |
| `/api/issues` | GET | Fetch backlog issues |
| `/api/backlog` | GET | Backlog summary |
| `/api/prs/:id/merge` | POST | Merge a PR |
| `/api/observability` | GET | Health and metrics summary |
| `/api/verify` | POST | Verify environment setup |
| `/api/setup-labels` | POST | Set up GitHub labels |
| `/api/webhooks/**` | POST | Inbound webhooks from GitHub / GitLab |

---

### 2. Server-Sent Events (SSE) — `GET /api/events`

A **unidirectional push stream** from server to browser. Used for real-time session status updates without polling from the client.

```mermaid
sequenceDiagram
    participant Browser
    participant SSE as GET /api/events
    participant SM as SessionManager

    Browser->>SSE: GET /api/events (EventSource)
    SSE-->>Browser: :heartbeat (every 15s)

    loop every 3s
        SSE->>SM: list sessions
        SM-->>SSE: session array
        SSE-->>Browser: data: {"type":"snapshot","sessions":[...]}
    end

    Browser->>Browser: useSessionEvents() merges snapshot\ninto React state
```

**Event payload shape:**
```json
{
  "type": "snapshot",
  "correlationId": "sse-abc123",
  "emittedAt": "2025-04-15T10:00:00Z",
  "sessions": [
    { "id": "sess-1", "status": "working", "activity": "active", "attentionLevel": "low" }
  ],
  "terminals": [
    { "id": "term-1", "tmuxName": "standalone-1", "alive": true }
  ]
}
```

**Client hook:** `useSessionEvents()` in `packages/web/src/hooks/useSessionEvents.ts`
- Opens an `EventSource` to `/api/events`
- On membership change (sessions added/removed) it fires a full `GET /api/sessions` fetch
- Falls back to Mux session patches when the Mux WebSocket is connected

The Mux server's `SessionBroadcaster` also consumes this same SSE endpoint to relay session patches to all connected WebSocket clients.

---

### 3. WebSocket (Multiplexed) — `ws://localhost:14801/mux`

A **bidirectional multiplexed channel** running on a separate Node.js process. It carries two independent sub-channels over a single connection:

- **`terminal` channel** — raw PTY I/O for xterm.js
- **`sessions` channel** — session patch broadcasts (forwarded from SSE)

```mermaid
sequenceDiagram
    participant XTerm as xterm.js
    participant MuxClient as MuxProvider (browser)
    participant MuxWS as WS Server :14801/mux
    participant PTY as node-pty (tmux)
    participant Next as Next.js :3000

    MuxClient->>MuxWS: connect ws://localhost:14801/mux

    Note over MuxClient,MuxWS: Open a terminal
    MuxClient->>MuxWS: {ch:"terminal", id:"sess-1", type:"open"}
    MuxWS->>PTY: spawn / attach tmux PTY
    MuxWS-->>MuxClient: {ch:"terminal", id:"sess-1", type:"opened"}

    Note over MuxClient,MuxWS: Terminal I/O
    XTerm->>MuxClient: user keystrokes
    MuxClient->>MuxWS: {ch:"terminal", id:"sess-1", type:"data", data:"ls\r"}
    MuxWS->>PTY: write to PTY
    PTY-->>MuxWS: output bytes
    MuxWS-->>MuxClient: {ch:"terminal", id:"sess-1", type:"data", data:"file1 file2\r\n"}
    MuxClient-->>XTerm: render output

    Note over MuxClient,MuxWS: Resize
    MuxClient->>MuxWS: {ch:"terminal", id:"sess-1", type:"resize", cols:220, rows:50}
    MuxWS->>PTY: resize PTY

    Note over MuxWS,Next: Auto-recovery (session dead)
    MuxWS->>Next: POST /api/sessions/sess-1/restore
    Next-->>MuxWS: 200 OK
    MuxWS->>PTY: reattach to new tmux session

    Note over MuxClient,MuxWS: Session patches
    MuxClient->>MuxWS: {ch:"subscribe", topics:["sessions"]}
    MuxWS-->>MuxClient: {ch:"sessions", type:"snapshot", sessions:[...]}
```

**Message types:**

| Direction | Channel | Type | Payload |
|-----------|---------|------|---------|
| Client→Server | `terminal` | `open` | `{ id }` |
| Client→Server | `terminal` | `data` | `{ id, data: string }` |
| Client→Server | `terminal` | `resize` | `{ id, cols, rows }` |
| Client→Server | `terminal` | `close` | `{ id }` |
| Client→Server | `subscribe` | — | `{ topics: ["sessions"] }` |
| Client→Server | `system` | `ping` | — |
| Server→Client | `terminal` | `opened` | `{ id }` |
| Server→Client | `terminal` | `data` | `{ id, data: string }` |
| Server→Client | `terminal` | `exited` | `{ id, code }` |
| Server→Client | `terminal` | `error` | `{ id, message }` |
| Server→Client | `sessions` | `snapshot` | `{ sessions: SessionPatch[] }` |
| Server→Client | `system` | `pong` | — |

---

## Process Map

```mermaid
graph LR
    subgraph Host
        CLI["ao CLI\n(packages/cli)"]
        Next["Next.js\npackages/web — :3000"]
        MuxSrv["Terminal WS Server\npackages/web/server — :14801"]
    end

    subgraph Storage["Flat-file Storage"]
        Sessions2["~/.agent-orchestrator/\n{hash}-{project}/\n  sessions/{id}  ← key-value\n  worktrees/{id}/\n  archive/{id}_{ts}/"]
    end

    CLI -- "pnpm ao start\nspawns both servers" --> Next
    CLI -- "spawns" --> MuxSrv
    Next -- "reads / writes" --> Sessions2
    MuxSrv -- "HTTP calls to recover sessions" --> Next
    MuxSrv -- "SSE subscription" --> Next
```

The CLI (`ao start`) is the entry point. It forks two long-running processes:
- **Next.js** on `:3000` — serves the dashboard and all REST/SSE routes
- **Terminal WS server** on `:14801` — handles multiplexed WebSocket + PTY management

Both processes share no in-memory state; coordination happens through flat files in `~/.agent-orchestrator/` and HTTP calls from the Mux server back to Next.js.

---

## Data Flow Summary

| Scenario | Protocol | Path |
|----------|----------|------|
| Load dashboard | HTTP GET | Browser → `:3000/` (SSR page) |
| List sessions | HTTP GET | Browser → `:3000/api/sessions` |
| Spawn new agent | HTTP POST | Browser → `:3000/api/spawn` |
| Send message to agent | HTTP POST | Browser → `:3000/api/sessions/:id/message` |
| Real-time status updates | SSE | Browser ← `:3000/api/events` (push, 3s interval) |
| Terminal output / input | WebSocket | Browser ↔ `:14801/mux` (bidirectional) |
| Mux watches session state | SSE | `:14801` ← `:3000/api/events` (server-to-server) |
| Mux restores dead session | HTTP POST | `:14801` → `:3000/api/sessions/:id/restore` |
| GitHub notifies of CI / PR | HTTP POST | GitHub → `:3000/api/webhooks/github` |
| CLI queries sessions | HTTP GET | `ao` CLI → `:3000/api/sessions` |
