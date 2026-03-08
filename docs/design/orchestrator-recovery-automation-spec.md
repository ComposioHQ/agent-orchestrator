# Orchestrator Recovery Automation — Design Specification

**Status:** Draft  
**Issue:** #356 — Session lifecycle race condition: orphan agent processes when orchestrator restarts during active spawns  
**Created:** 2026-03-08  
**Author:** Agent Orchestrator Team

---

## Executive Summary

When the orchestrator restarts while agents are spawning or working, session tracking loses track of active agent processes. This spec defines a comprehensive recovery automation system that:

1. **Detects orphan sessions** on orchestrator startup
2. **Validates session state** against runtime reality
3. **Recovers live sessions** with full context restoration
4. **Cleans up dead sessions** safely
5. **Provides audit logging** for operational visibility

---

## 1. Problem Statement

### 1.1 Root Cause

The `SessionManager.startSession()` flow is non-atomic:

```
1. Reserve session ID (O_EXCL file create)     ← Persistent
2. Create workspace (worktree)                 ← Persistent (filesystem)
3. Create runtime (tmux session)               ← Persistent (tmux server)
4. Launch agent                                ← Persistent (child process)
5. Write full metadata (status=working)        ← Persistent
   ↓
   [CRASH POINT] — orchestrator dies here
   ↓
6. In-memory state (Map<SessionId, Session>)   ← LOST
7. WebSocket connections                       ← LOST
8. Lifecycle manager polling                   ← STOPPED
```

If the orchestrator crashes between steps 1-5, filesystem state exists but in-memory state is lost. On restart:

- **Session metadata file exists** (on disk)
- **Runtime session may exist** (tmux/docker)
- **Agent process may be running** (independent of orchestrator)
- **SessionManager has no record** (in-memory Map is empty)
- **WebSocket disconnected** (no client notification)

### 1.2 Symptoms

| Symptom                     | Cause                                     | Impact                              |
| --------------------------- | ----------------------------------------- | ----------------------------------- |
| Orphan tmux sessions        | Runtime persists after orchestrator crash | Resource leak, invisible work       |
| Duplicate session IDs       | Reservation without completion tracking   | Name collisions, confusion          |
| Stale WebSocket connections | Clients not notified of disconnect        | Frozen UI, missing updates          |
| Lost worktrees              | Workspace created but never tracked       | Disk space leak, abandoned branches |
| Duplicate PRs               | Agent respawned for same issue            | Review confusion, merge conflicts   |

### 1.3 Current State Analysis

**What works today:**

- `atomicWriteFileSync()` — metadata writes are atomic via rename(2)
- `reserveSessionId()` — uses O_EXCL to prevent race conditions
- `runtime.isAlive()` — can check if tmux session exists
- Session metadata persists across restarts (flat files in `~/.agent-orchestrator/`)

**What's missing:**

- No startup scan for existing sessions
- No validation of metadata against runtime reality
- No orphan cleanup
- No WebSocket reconnection
- No audit trail of recovery actions

---

## 2. Goals & Non-Goals

### 2.1 Goals

1. **Detect all sessions** on orchestrator startup by scanning metadata directories
2. **Validate each session** by checking runtime liveness
3. **Recover live sessions** by rebuilding in-memory state and reconnecting WebSocket
4. **Clean up dead sessions** by removing stale worktrees and marking as terminated
5. **Log all recovery actions** for operational debugging
6. **Resume lifecycle polling** for recovered sessions

### 2.2 Non-Goals

- **No state migration** — assumes existing metadata format is valid
- **No distributed coordination** — single orchestrator instance only
- **No agent state resurrection** — cannot recover agent's internal reasoning
- **No cross-machine failover** — sessions are local to one orchestrator
- **No partial transaction rollback** — if spawn failed mid-way, manual cleanup required

---

## 3. Design Specification

### 3.1 Recovery Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    ORCHESTRATOR STARTUP                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  PHASE 1: DISCOVERY                                             │
│  ─────────────────────────────────────────────────────────────  │
│  • Scan ~/.agent-orchestrator/*/sessions/ for metadata files   │
│  • Build candidate list: [{sessionId, projectId, rawMetadata}]  │
│  • Load OrchestratorConfig to resolve projects                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  PHASE 2: VALIDATION (parallel per session)                     │
│  ─────────────────────────────────────────────────────────────  │
│  For each candidate:                                            │
│  • Check runtime.isAlive(handle)                                │
│  • Check workspace.exists(path)                                 │
│  • Check agent.isProcessRunning(handle)                         │
│  • Classify: LIVE | DEAD | PARTIAL                              │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
        ┌──────────┐    ┌──────────┐    ┌──────────┐
        │   LIVE   │    │   DEAD   │    │ PARTIAL  │
        └──────────┘    └──────────┘    └──────────┘
              │               │               │
              ▼               ▼               ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│ PHASE 3A:       │ │ PHASE 3B:       │ │ PHASE 3C:       │
│ RECOVER         │ │ CLEANUP         │ │ REPAIR/ESCALATE │
│ ─────────────── │ │ ─────────────── │ │ ─────────────── │
│ • Rebuild       │ │ • Kill runtime  │ │ • Log details   │
│   Session obj   │ │ • Remove        │ │ • Mark stuck    │
│ • Reconnect     │ │   worktree      │ │ • Notify human  │
│   WebSocket     │ │ • Mark status   │ │ • Skip from     │
│ • Resume        │ │   =terminated   │ │   polling       │
│   lifecycle     │ │ • Audit log     │ │ • Audit log     │
│ • Audit log     │ │                 │ │                 │
└─────────────────┘ └─────────────────┘ └─────────────────┘
              │               │               │
              └───────────────┴───────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  PHASE 4: REPORTING                                              │
│  ─────────────────────────────────────────────────────────────  │
│  • Write recovery summary to ~/.agent-orchestrator/recovery.log │
│  • Emit OrchestratorEvent (recovery.complete)                   │
│  • Dashboard: show recovery banner if any sessions affected     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │ NORMAL OPERATION │
                    │ (lifecycle poll) │
                    └─────────────────┘
```

### 3.2 Session Classification

```typescript
type RecoveryClassification = "live" | "dead" | "partial" | "unrecoverable";

interface RecoveryAssessment {
  sessionId: SessionId;
  classification: RecoveryClassification;

  // Runtime state
  runtimeAlive: boolean;
  runtimeHandle: RuntimeHandle | null;

  // Workspace state
  workspaceExists: boolean;
  workspacePath: string | null;

  // Agent state
  agentProcessRunning: boolean;
  agentActivity: ActivityState | null;

  // Metadata state
  metadataValid: boolean;
  metadataStatus: SessionStatus;

  // Recommended action
  action: "recover" | "cleanup" | "escalate" | "skip";
  reason: string;
}
```

**Classification rules:**

| Runtime | Workspace | Agent   | Status | Classification  | Action                       |
| ------- | --------- | ------- | ------ | --------------- | ---------------------------- |
| alive   | exists    | running | any    | `live`          | `recover`                    |
| alive   | exists    | exited  | any    | `partial`       | `escalate`                   |
| alive   | missing   | -       | any    | `partial`       | `escalate`                   |
| dead    | exists    | -       | any    | `dead`          | `cleanup`                    |
| dead    | missing   | -       | merged | `dead`          | `cleanup` (no action needed) |
| -       | -         | -       | merged | `unrecoverable` | `skip` (already done)        |

### 3.3 Recovery Actions

#### 3.3.1 RECOVER (live sessions)

```typescript
async function recoverSession(
  sessionId: SessionId,
  assessment: RecoveryAssessment,
): Promise<RecoveryResult> {
  // 1. Rebuild Session object from metadata
  const session = metadataToSession(sessionId, assessment.rawMetadata);

  // 2. Restore runtime handle
  session.runtimeHandle = assessment.runtimeHandle;

  // 3. Update activity state
  session.activity = assessment.agentActivity;

  // 4. Add to SessionManager's in-memory map
  sessionManager.registerSession(session);

  // 5. Reconnect WebSocket (if terminal-web plugin)
  await reconnectWebSocket(session);

  // 6. Resume lifecycle polling
  lifecycleManager.trackSession(session);

  // 7. Write audit log
  writeRecoveryLog({
    sessionId,
    action: "recovered",
    previousStatus: session.status,
    recoveredAt: new Date(),
    details: assessment,
  });

  return { success: true, action: "recovered", session };
}
```

#### 3.3.2 CLEANUP (dead sessions)

```typescript
async function cleanupDeadSession(
  sessionId: SessionId,
  assessment: RecoveryAssessment,
): Promise<RecoveryResult> {
  const project = config.projects[assessment.projectId];

  // 1. Kill runtime (if exists, idempotent)
  if (assessment.runtimeAlive) {
    const runtime = registry.get<Runtime>("runtime", project.runtime);
    await runtime.destroy(assessment.runtimeHandle);
  }

  // 2. Remove worktree (if exists)
  if (assessment.workspaceExists && assessment.workspacePath) {
    const workspace = registry.get<Workspace>("workspace", project.workspace);
    await workspace.destroy(assessment.workspacePath);
  }

  // 3. Update metadata status
  const sessionsDir = getSessionsDir(config.configPath, project.path);
  updateMetadata(sessionsDir, sessionId, {
    status: "terminated",
    terminatedAt: new Date().toISOString(),
    terminationReason: "orchestrator_recovery_cleanup",
  });

  // 4. Archive metadata (move to archive/)
  deleteMetadata(sessionsDir, sessionId, { archive: true });

  // 5. Write audit log
  writeRecoveryLog({
    sessionId,
    action: "cleaned_up",
    previousStatus: assessment.metadataStatus,
    cleanedUpAt: new Date(),
    details: assessment,
  });

  return { success: true, action: "cleaned_up" };
}
```

#### 3.3.3 ESCALATE (partial/unrecoverable)

```typescript
async function escalateSession(
  sessionId: SessionId,
  assessment: RecoveryAssessment,
): Promise<RecoveryResult> {
  // 1. Mark status as stuck with special marker
  const sessionsDir = getSessionsDir(config.configPath, project.path);
  updateMetadata(sessionsDir, sessionId, {
    status: "stuck",
    recoveryRequired: "manual",
    recoveryAssessment: JSON.stringify(assessment),
  });

  // 2. Emit event for notification
  eventEmitter.emit({
    type: "recovery.escalation_required",
    sessionId,
    projectId: assessment.projectId,
    message: `Session ${sessionId} requires manual intervention`,
    priority: "urgent",
    data: { assessment },
  });

  // 3. Write audit log
  writeRecoveryLog({
    sessionId,
    action: "escalated",
    reason: assessment.reason,
    escalatedAt: new Date(),
    details: assessment,
  });

  return { success: true, action: "escalated", requiresManualIntervention: true };
}
```

---

## 4. API Changes

### 4.1 SessionManager

```typescript
interface SessionManager {
  // Existing methods...
  spawn(config: SessionSpawnConfig): Promise<Session>;
  list(projectId?: string): Promise<Session[]>;
  get(sessionId: SessionId): Promise<Session | null>;
  kill(sessionId: SessionId): Promise<void>;
  send(sessionId: SessionId, message: string): Promise<void>;

  // NEW: Recovery methods
  recoverAll(): Promise<RecoveryReport>;
  recoverSession(sessionId: SessionId): Promise<RecoveryResult>;
  validateSession(sessionId: SessionId): Promise<RecoveryAssessment>;
}

interface RecoveryReport {
  timestamp: Date;
  totalScanned: number;
  recovered: SessionId[];
  cleanedUp: SessionId[];
  escalated: SessionId[];
  skipped: SessionId[];
  errors: Array<{ sessionId: SessionId; error: Error }>;
}

interface RecoveryResult {
  success: boolean;
  action: "recovered" | "cleaned_up" | "escalated" | "skipped";
  session?: Session;
  requiresManualIntervention?: boolean;
}
```

### 4.2 CLI Commands

```bash
# Automatic recovery on startup (default behavior)
ao start

# Manual recovery trigger
ao session recover --all
ao session recover <session-id>

# Dry-run to see what would be recovered
ao session recover --dry-run

# View recovery log
ao recovery log [--tail 100]

# Force cleanup of specific session
ao session cleanup <session-id> --force
```

### 4.3 Web API Endpoints

```
GET  /api/recovery/status     # Get current recovery state
POST /api/recovery/run        # Trigger manual recovery
GET  /api/recovery/log        # Get recovery log entries
POST /api/sessions/:id/recover # Recover specific session
POST /api/sessions/:id/cleanup # Force cleanup specific session
```

---

## 5. Metadata Schema Extensions

### 5.1 New Fields

```typescript
interface SessionMetadata {
  // Existing fields...
  worktree: string;
  branch: string;
  status: string;
  tmuxName?: string;
  issue?: string;
  pr?: string;

  // NEW: Recovery tracking
  recoveredAt?: string; // ISO timestamp of last recovery
  recoveredFrom?: string; // Previous status before recovery
  recoveryCount?: number; // Number of times recovered
  terminatedAt?: string; // ISO timestamp of termination
  terminationReason?: string; // Why session was terminated
  recoveryRequired?: "auto" | "manual"; // Hint for recovery system
  recoveryAssessment?: string; // JSON of last assessment
}
```

### 5.2 Recovery Log Format

Location: `~/.agent-orchestrator/recovery.log`

```
# Recovery Log Format (JSONL)
{"timestamp":"2026-03-08T12:00:00Z","sessionId":"app-1","action":"recovered","previousStatus":"working","details":{...}}
{"timestamp":"2026-03-08T12:00:01Z","sessionId":"app-2","action":"cleaned_up","reason":"runtime_dead","details":{...}}
```

---

## 6. Graceful Shutdown

### 6.1 Shutdown Hook

```typescript
interface GracefulShutdownConfig {
  enabled: boolean;
  timeoutMs: number; // Max time to wait for clean shutdown
  forceKillAfterMs: number; // Force exit if graceful fails
}

async function gracefulShutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(`Received ${signal}, starting graceful shutdown...`);

  // 1. Stop accepting new sessions
  sessionManager.lock();

  // 2. Stop lifecycle polling (finish current cycle)
  await lifecycleManager.stop();

  // 3. Save all session state
  for (const session of sessionManager.list()) {
    await sessionManager.saveState(session.id);
  }

  // 4. Close WebSocket connections gracefully
  await webSocketServer.close({ allowReconnect: true });

  // 5. Write shutdown marker
  writeShutdownMarker({
    timestamp: new Date(),
    reason: signal,
    activeSessions: sessionManager.list().map((s) => s.id),
  });

  console.log("Graceful shutdown complete");
  process.exit(0);
}

// Register signal handlers
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
```

### 6.2 Shutdown Marker

Location: `~/.agent-orchestrator/.shutdown-marker`

```json
{
  "timestamp": "2026-03-08T12:00:00Z",
  "reason": "SIGTERM",
  "activeSessions": ["app-1", "app-2"],
  "version": "1.0.0"
}
```

On startup, if shutdown marker exists with recent timestamp (< 5 min), recovery can be more aggressive (assume clean shutdown). If no marker or old marker, assume crash recovery.

---

## 7. Error Handling

### 7.1 Recovery Failures

| Failure                     | Handling                                   |
| --------------------------- | ------------------------------------------ |
| Metadata unreadable         | Log error, skip session, continue          |
| Runtime check timeout       | Classify as `partial`, escalate            |
| Workspace permission denied | Classify as `partial`, escalate            |
| WebSocket reconnect fails   | Log warning, session still recovered       |
| Cleanup partially fails     | Log error, continue with remaining cleanup |

### 7.2 Recovery Loop Prevention

To prevent infinite recovery loops:

```typescript
const MAX_RECOVERY_ATTEMPTS = 3;
const RECOVERY_BACKOFF_MS = [0, 5000, 30000]; // Exponential backoff

async function recoverWithBackoff(
  sessionId: SessionId,
  attempt: number = 0,
): Promise<RecoveryResult> {
  if (attempt >= MAX_RECOVERY_ATTEMPTS) {
    return escalateSession(sessionId, { reason: "max_recovery_attempts_exceeded" });
  }

  await sleep(RECOVERY_BACKOFF_MS[attempt] ?? 30000);

  try {
    return await recoverSession(sessionId);
  } catch (error) {
    return recoverWithBackoff(sessionId, attempt + 1);
  }
}
```

---

## 8. Implementation Phases

### Phase 1: Discovery & Validation (Week 1)

**Scope:**

- Implement `scanAllSessions()` to discover metadata files
- Implement `validateSession()` to check runtime/workspace/agent state
- Add `RecoveryAssessment` type and classification logic
- Add recovery CLI commands (`--dry-run`)

**Deliverables:**

- `packages/core/src/recovery/scanner.ts`
- `packages/core/src/recovery/validator.ts`
- `packages/core/src/recovery/types.ts`
- CLI: `ao session recover --dry-run`

**Testing:**

- Unit tests for classification logic
- Integration test: create sessions, kill orchestrator, run validation

### Phase 2: Recovery & Cleanup (Week 2)

**Scope:**

- Implement `recoverSession()` for live sessions
- Implement `cleanupDeadSession()` for dead sessions
- Implement `escalateSession()` for partial sessions
- Add `recoverAll()` orchestration

**Deliverables:**

- `packages/core/src/recovery/recoverer.ts`
- `packages/core/src/recovery/cleanup.ts`
- CLI: `ao session recover --all`
- Web API: `/api/recovery/*`

**Testing:**

- Integration test: recover live session after restart
- Integration test: cleanup dead session
- Integration test: escalate partial session

### Phase 3: Integration & Audit (Week 3)

**Scope:**

- Integrate recovery into `ao start` flow
- Implement recovery log writer
- Add graceful shutdown hooks
- Add WebSocket reconnection logic

**Deliverables:**

- Recovery runs automatically on `ao start`
- `~/.agent-orchestrator/recovery.log` populated
- Graceful shutdown on SIGTERM/SIGINT
- Dashboard shows recovery banner

**Testing:**

- E2E test: spawn → kill orchestrator → restart → verify recovery
- E2E test: graceful shutdown preserves state
- Load test: recover 50+ sessions simultaneously

### Phase 4: Polish & Documentation (Week 4)

**Scope:**

- Error message improvements
- Dashboard UI for recovery status
- Troubleshooting guide
- Performance optimization

**Deliverables:**

- Updated `TROUBLESHOOTING.md`
- Dashboard recovery panel
- Recovery performance metrics
- Blog post / changelog

---

## 9. Testing Strategy

### 9.1 Unit Tests

```typescript
describe("RecoveryClassifier", () => {
  it("classifies live session with all components running", () => {
    const assessment = classifySession({
      runtimeAlive: true,
      workspaceExists: true,
      agentProcessRunning: true,
      metadataStatus: "working",
    });
    expect(assessment.classification).toBe("live");
    expect(assessment.action).toBe("recover");
  });

  it("classifies dead session with no runtime", () => {
    const assessment = classifySession({
      runtimeAlive: false,
      workspaceExists: true,
      metadataStatus: "working",
    });
    expect(assessment.classification).toBe("dead");
    expect(assessment.action).toBe("cleanup");
  });

  it("classifies partial session with runtime but no agent", () => {
    const assessment = classifySession({
      runtimeAlive: true,
      workspaceExists: true,
      agentProcessRunning: false,
      metadataStatus: "working",
    });
    expect(assessment.classification).toBe("partial");
    expect(assessment.action).toBe("escalate");
  });
});
```

### 9.2 Integration Tests

```typescript
describe("Recovery Integration", () => {
  it("recovers live session after orchestrator restart", async () => {
    // 1. Start orchestrator
    // 2. Spawn session
    // 3. Verify session is tracked
    // 4. Kill orchestrator (SIGKILL)
    // 5. Restart orchestrator
    // 6. Verify session is recovered
    // 7. Verify lifecycle polling resumes
  });

  it("cleans up dead session after orchestrator restart", async () => {
    // 1. Start orchestrator
    // 2. Spawn session
    // 3. Kill runtime (tmux kill-session)
    // 4. Kill orchestrator (SIGKILL)
    // 5. Restart orchestrator
    // 6. Verify session is cleaned up
    // 7. Verify worktree removed
  });

  it("handles crash during spawn gracefully", async () => {
    // 1. Start orchestrator
    // 2. Begin spawn (create metadata file)
    // 3. Kill orchestrator before spawn completes
    // 4. Restart orchestrator
    // 5. Verify partial session is detected
    // 6. Verify session is cleaned up or escalated
  });
});
```

### 9.3 Chaos Testing

```bash
# Script: test-recovery-chaos.sh
# Randomly kills orchestrator during various operations

for i in {1..10}; do
  # Spawn some sessions
  ao spawn test-project $i &

  # Randomly kill orchestrator
  sleep $((RANDOM % 5))
  pkill -f "ao start" || true

  # Restart orchestrator
  ao start &
  sleep 2

  # Check recovery status
  ao session recover --dry-run
done

# Verify no orphan sessions
tmux list-sessions | wc -l  # Should match ao session list | wc -l
```

---

## 10. Operational Considerations

### 10.1 Monitoring

**Metrics to track:**

- `ao_recovery_sessions_scanned` — total sessions found on startup
- `ao_recovery_sessions_recovered` — successfully recovered
- `ao_recovery_sessions_cleaned_up` — cleaned up as dead
- `ao_recovery_sessions_escalated` — required manual intervention
- `ao_recovery_duration_ms` — time to complete recovery

**Alerting:**

- Alert if `escalated > 0` — manual intervention needed
- Alert if `recovery_duration_ms > 30000` — recovery too slow
- Alert if `cleaned_up / scanned > 0.5` — high crash rate

### 10.2 Manual Intervention

When sessions are escalated, operators should:

1. Check `ao recovery log` for details
2. Inspect session: `ao session show <id>`
3. Check runtime: `tmux attach -t <session>` (or Docker logs)
4. Check workspace: `cd ~/.worktrees/<project>/<session>`
5. Decide: manually recover or cleanup
   - `ao session recover <id>` — attempt recovery
   - `ao session cleanup <id> --force` — force cleanup

### 10.3 Backward Compatibility

- Recovery system must handle metadata from older versions
- Unknown fields in metadata are preserved (pass-through)
- Missing fields get sensible defaults
- Version field in metadata for future migrations

---

## 11. Acceptance Criteria

From issue #356:

- [x] **AC1:** `SessionManager` persists session metadata atomically to disk  
      _Already implemented via `atomicWriteFileSync()`_

- [ ] **AC2:** On orchestrator startup, all sessions are validated and recovered from disk  
      _Requires: `scanAllSessions()`, `validateSession()`, `recoverAll()`_

- [ ] **AC3:** Orphan sessions (no matching process) are logged and cleaned up  
      _Requires: classification logic, `cleanupDeadSession()`, recovery log_

- [ ] **AC4:** WebSocket connections reconnect to recovered sessions without re-spawning  
      _Requires: WebSocket reconnection logic, session handle restoration_

- [ ] **AC5:** Integration test covers: spawn → orchestrator crash → restart → agent resumes work  
      _Requires: full integration test suite_

---

## 12. Risks & Mitigations

| Risk                                          | Likelihood | Impact | Mitigation                                             |
| --------------------------------------------- | ---------- | ------ | ------------------------------------------------------ |
| Recovery too slow (100+ sessions)             | Medium     | High   | Parallel validation, batching                          |
| False positive (live session classified dead) | Low        | High   | Conservative classification, manual recovery available |
| Race condition during recovery                | Low        | Medium | Lock file, single recovery process                     |
| Metadata corruption                           | Low        | High   | Archive before modification, validation                |
| WebSocket reconnection fails                  | Medium     | Low    | Session still recovered, user can refresh              |

---

## 13. Future Enhancements

**Not in MVP, but worth considering:**

1. **State snapshots** — periodic checkpoint of session state for faster recovery
2. **Distributed coordination** — etcd/Consul for multi-orchestrator setups
3. **Agent state resurrection** — export/import agent's internal state
4. **Predictive cleanup** — detect stuck sessions proactively
5. **Recovery webhooks** — notify external systems of recovery events
6. **Partial spawn rollback** — automatic cleanup of incomplete spawns

---

## 14. References

- Issue #356: Session lifecycle race condition
- Issue #325: Session ID capture to prevent orphan sessions
- Issue #330: Multi-session spawn race and attach ambiguity
- Issue #329: Restart button for dashboard
- `docs/design/session-replacement-handoff.md` — successor session design
- `packages/core/src/metadata.ts` — current metadata implementation
- `packages/plugins/runtime-tmux/README.md` — tmux runtime documentation

---

## Appendix A: Recovery Log Schema

```typescript
interface RecoveryLogEntry {
  timestamp: string; // ISO 8601
  sessionId: SessionId;
  action: "recovered" | "cleaned_up" | "escalated" | "skipped" | "error";

  // For recovered
  previousStatus?: SessionStatus;
  recoveredAt?: string;

  // For cleaned_up
  reason?: string;
  cleanedUpAt?: string;

  // For escalated
  escalatedAt?: string;
  requiresManualIntervention?: boolean;

  // For all
  details?: RecoveryAssessment;
  error?: string; // If action === "error"
}
```

## Appendix B: Configuration Schema

```yaml
# agent-orchestrator.yaml
recovery:
  enabled: true # Enable automatic recovery on startup
  timeoutMs: 30000 # Max time for recovery phase
  parallelValidation: 5 # Concurrent validation tasks
  logPath: ~/.agent-orchestrator/recovery.log
  autoCleanup: true # Automatically cleanup dead sessions
  escalatePartial: true # Escalate partial sessions (vs. auto-cleanup)

shutdown:
  gracefulTimeoutMs: 10000 # Wait time for graceful shutdown
  forceKillAfterMs: 30000 # Force exit if graceful fails
```

---

_Document version: 1.0.0-draft_  
_Last updated: 2026-03-08_
