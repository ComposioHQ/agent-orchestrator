# Feature Plan: CLI Sub-Sessions, Optional Agent + Prompt, Base Prompt Docs

**Issue:** (link when filed)  
**Branch:** (TBD, e.g. `feat/cli-sub-sessions-agent`)  
**Status:** Pending  

---

## Goals

1. **CLI parity** — Expose sub-session create / list / kill (and optional restore) via `ao session sub …`, matching dashboard/API capabilities.
2. **Optional agent in sub-sessions** — When creating a sub-session, **`--agent` is optional**:
   - **Omitted:** Same as today: tmux session in the parent worktree with a **plain shell** (no agent CLI auto-started).
   - **Set:** Start the named **agent plugin’s launch command** in that tmux session (same worktree as the parent AO session), analogous to `ao spawn` but scoped to a sub-session identity (`{parent}-t{n}`).
3. **Optional intro prompt** — When `--agent` is set, support **`--prompt <text>`** (same semantics as `ao spawn --prompt`): session-specific instructions passed into `getLaunchCommand` / prompt composition for **that** sub-session only.
4. **Primary agent guidance** — Extend **`BASE_AGENT_PROMPT`** (and keep `buildPrompt` layering honest) so the **primary** session agent knows sub-sessions exist, how to create them (CLI), and when shell-only vs agent-backed tabs are appropriate.

---

## Terminology (delta from prior sub-session plan)

| Term | Definition |
|------|------------|
| **Shell sub-session** | Additional tmux session sharing the parent worktree; **no** `agent` in metadata; `launchCommand` was empty at create time. |
| **Agent sub-session** | Additional tmux session with **`agent`** (and optionally **`userPrompt` / intro**) persisted in metadata; created with a non-empty agent launch command. |

Primary sub-session remains the main AO agent; it is not created through `session sub`.

---

## Problem Summary

- Sub-sessions are only manageable from the **dashboard API** today; **CLI users and primary agents** have no documented, scriptable path.
- All non-primary subs are **shell-only**; users cannot spin up a **second agent** (e.g. codex in one tab, claude-code in another) without a new AO session.
- The **base orchestrator prompt** does not mention sub-sessions, so the primary agent may not know it can delegate to extra terminals or agents.

---

## Proposed Approach

### 1. Metadata & types

Extend sub-session metadata (flat key=value) when the sub-session runs an agent:

| Key | When |
|-----|------|
| `agent` | Optional; plugin name when this sub-session runs an agent CLI. |
| `introPrompt` or reuse `userPrompt` | Optional; only meaningful when `agent` is set (align naming with `SessionSpawnConfig.prompt` → stored shape TBD). |

**Recommendation:** Persist `agent` only when set; store intro text under a single key (e.g. `introPrompt`) to avoid colliding with unrelated metadata, and map to the same `userPrompt` field in `buildPrompt`-equivalent path for that launch.

**`SubSession` type** (`packages/core/src/types.ts`): add optional `agent?: string` (and optionally `introPrompt?: string`) for `listSubSessions` / API responses.

**`createSubSession` signature** (conceptual):

```typescript
createSubSession(
  sessionId: SessionId,
  options?: { agent?: string; prompt?: string },
): Promise<SubSession>;
```

Rules:

- If `options?.agent` is missing or empty → **shell sub-session** (current behavior: `launchCommand: ""`).
- If `options?.agent` is set → validate `registry.get("agent", name)`, resolve plugins, build **`getLaunchCommand`** with a config similar to spawn (same worktree, **sub-session id** as `sessionId` in agent config where appropriate, **`prompt` / `userPrompt`** from options).
- **`options?.prompt`** allowed **only when `agent` is set**; if `agent` unset, ignore prompt or reject with a clear error (prefer **reject** to avoid silent confusion).

### 2. Core implementation (`session-manager.ts`)

- **`createSubSession`**: branch on `options?.agent`; shell path unchanged; agent path calls `plugins.agent.getLaunchCommand` + `getEnvironment` with a **SubSessionLaunchConfig**-shaped object (new small type or reuse/extend spawn’s shape with `sessionId = subSessionId`, `issueId` typically undefined unless we add `--issue` later).
- **Persistence**: `writeMetadata` / `updateMetadata` includes `agent` and intro key when agent path; omit when shell-only.
- **`restoreTerminalSubSession`**: if metadata has `agent`, recreate using stored agent + stored intro (re-resolve launch command); if shell-only, keep empty launch command.
- **`killSubSession` / cascade / `list` filter**: unchanged conceptually; ensure agent-specific cleanup (e.g. OpenCode) is considered in a follow-up if needed.

### 3. CLI (`packages/cli/src/commands/session.ts` or `session/sub.ts`)

Introduce a **`session sub`** command group (names can be bikeshedded):

```bash
# Create
ao session sub create <parentSession> [--agent <name>] [--prompt <text>]

# List
ao session sub list <parentSession>

# Kill one terminal/agent sub (not primary)
ao session sub kill <parentSession> <subId>   # e.g. int-1-t2

# Optional: restore dead shell/agent sub (parity with dashboard)
ao session sub restore <parentSession> <subId>
```

- **`create`**: pass `{ agent, prompt }` to `sessionManager.createSubSession(parent, { agent, prompt })`.
- **`list` / `kill` / `restore`**: thin wrappers around existing `listSubSessions`, `killSubSession`, `restoreTerminalSubSession`.
- Help text should state explicitly: **without `--agent`, the new tmux session is a plain shell.**

### 4. HTTP API (dashboard parity)

- **`POST /api/sessions/:id/sub-sessions`**: accept optional JSON `{ "agent"?: string, "prompt"?: string }` with the same rules as CLI (prompt only if agent set).
- **`GET`**: response includes `agent` / intro when present for UI labels (e.g. badge “Agent: codex”).

### 5. Base prompt (`packages/core/src/prompt-builder.ts`)

Add a concise subsection under **Session Lifecycle** (or new **## Sub-sessions (shared worktree)** section):

- Explain that the AO session can have **multiple tmux panes/sessions** in the **same worktree**: primary (this session) plus **sub-sessions** `…-t1`, `…-t2`, …
- **CLI:** `ao session sub create <session> [--agent …] [--prompt …]` — without `--agent`, opens a **plain shell**; with `--agent`, starts that agent in a separate tmux session for parallel work / delegation.
- **When to use:** e.g. long-running tests in a shell tab, a second agent for exploration, without spawning a full new AO session.
- **Caveats:** same branch/worktree — avoid conflicting git operations; prefer coordinating through the user or explicit division of work.

Keep wording short to limit context growth; link to `ao session sub --help` style discovery.

### 6. Tests

| Area | Tests |
|------|--------|
| Core | `createSubSession` shell-only; with agent mock, assert `getLaunchCommand` called and metadata contains `agent`; prompt-only-without-agent throws; restore agent sub recreates launch command. |
| CLI | Parser passes flags to `createSubSession`; list/kill/restore invoke manager. |
| Prompt | `BASE_AGENT_PROMPT` contains agreed phrases / `ao session sub`; snapshot or substring assertions in `prompt-builder.test.ts`. |

---

## Risks & Open Questions

| # | Topic | Notes |
|---|--------|--------|
| 1 | **Two agents, one worktree** | Git lock / conflicting edits; document in base prompt; no automatic merge. |
| 2 | **OpenCode / session mapping** | Agent subs may need `opencodeSessionId` or similar in metadata; may mirror spawn/postLaunchSetup — scope carefully. |
| 3 | **Max sub-sessions** | Existing soft limit (5); consider separate limit for **agent** subs vs shell subs. |
| 4 | **Primary kill** | Unchanged: cascade kills all subs including agent-backed. |
| 5 | **`AO_SUB_SESSION` / env** | Ensure agent launch env vars remain correct for subs (already set for shell subs). |

---

## Implementation Checklist

### Phase A — Core + metadata

- [ ] Extend `createSubSession(sessionId, options?)` and types (`SessionManager`, `SubSession`).
- [ ] Persist optional `agent` + intro prompt keys for agent subs; shell subs unchanged.
- [ ] Update `restoreTerminalSubSession` for agent-backed subs.
- [ ] Unit tests in `session-manager.test.ts`.

### Phase B — CLI

- [ ] Implement `ao session sub create|list|kill|restore` with `--agent` / `--prompt` on create.
- [ ] Help examples; mirror validation messages from core.

### Phase C — Web API + UI (optional polish)

- [ ] Extend `POST .../sub-sessions` body; show agent label on tabs if useful.

### Phase D — Base prompt

- [ ] Edit `BASE_AGENT_PROMPT` in `prompt-builder.ts`.
- [ ] Update `prompt-builder.test.ts` expectations.

### Final

- [ ] `pnpm build && pnpm typecheck && pnpm lint && pnpm test` (as applicable).
- [ ] PR description references this plan file.

---

## Related

- `.feature-plans/pending/restore-agent-override-and-sub-sessions.md` — original sub-session design (shell-only extras); this plan **extends** terminal subs with optional agent + prompt and adds **CLI + prompt documentation**.
- `packages/cli/src/commands/spawn.ts` — reference for `--prompt` UX and `sessionManager.spawn` wiring.
