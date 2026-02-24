# Agent Communication — Integration & Migration Plan

**Date**: 2026-02-16
**Related**: [agent-communication.md](./agent-communication.md)

## Overview

This document outlines the integration and migration plan for the file-based mailbox communication system in Agent Orchestrator. The goal is to replace fragile `tmux send-keys` / `capture-pane` with structured, reliable messaging while maintaining backward compatibility.

---

## Implementation Status

### ✅ Completed

1. **Core mailbox implementation** (`packages/core/src/mailbox.ts`)
   - File-based inbox/outbox system
   - JSON message format with schema
   - Atomic writes (tempfile + rename)
   - Acknowledgment support
   - Message history in processed/ directory
   - Full test coverage (44 tests passing)

2. **Architecture analysis** (`docs/agent-communication.md`)
   - Comparison of 4 approaches (file, socket, queue, tmux)
   - Detailed technical analysis
   - Recommended approach with rationale
   - Performance analysis
   - Security considerations

3. **Inbox watcher script** (`scripts/inbox-watcher.sh`)
   - Polls inbox directory every 5 seconds
   - Formats messages for agent display
   - Delivers via tmux send-keys
   - Sends acknowledgments
   - Moves processed messages

4. **CLI improvements** (`packages/cli/src/commands/spawn.ts`)
   - Added `--prompt <file>` option
   - Added `--prompt-text <text>` option
   - Better than post-spawn tmux send-keys
   - Works with `--open` flag

### ⏳ Next Steps

1. **Integrate with lifecycle manager** (Week 2)
2. **Add Runtime.sendStructuredMessage()** (Week 2)
3. **Update Agent interface** (Week 3)
4. **Scale testing** (Week 3)
5. **Production deployment** (Week 4)

---

## Integration Plan

### Phase 1: Core Infrastructure (This Week — DONE ✅)

**Goals**:
- File-based mailbox system implemented
- Tested and working
- Documentation complete

**Deliverables**:
- ✅ `Mailbox` class with send/receive/ack methods
- ✅ Unit tests (44 passing)
- ✅ Architecture analysis document
- ✅ Inbox watcher script
- ✅ CLI `--prompt` flag

**Status**: Complete

---

### Phase 2: Lifecycle Integration (Week 2)

**Goals**:
- Lifecycle manager uses mailbox for reactions
- Automatic message delivery to sessions
- Backward compatibility maintained

#### 2.1 Update Lifecycle Manager

**File**: `packages/core/src/lifecycle-manager.ts`

**Changes**:
```typescript
import { Mailbox, type Message, type MessageType } from "./mailbox.js";

class LifecycleManager {
  private mailboxes: Map<SessionId, Mailbox> = new Map();

  // Get or create mailbox for a session
  private getMailbox(sessionId: SessionId): Mailbox {
    if (!this.mailboxes.has(sessionId)) {
      this.mailboxes.set(sessionId, new Mailbox(this.dataDir, sessionId));
    }
    return this.mailboxes.get(sessionId)!;
  }

  // Send structured message to session
  async sendToSession(sessionId: SessionId, message: Omit<Message, "id" | "from" | "to" | "timestamp">): Promise<void> {
    const mailbox = this.getMailbox("orchestrator");
    await mailbox.send(sessionId, message);
  }

  // Example: CI failure reaction
  private async handleCIFailure(session: Session, check: CICheck): Promise<void> {
    const reaction = this.reactions["ci_failure"];
    if (!reaction?.auto) return;

    if (reaction.action === "send-to-agent") {
      await this.sendToSession(session.id, {
        type: "fix_ci_failure",
        priority: "high",
        payload: {
          pr: session.pr?.url,
          check: check.name,
          error: check.conclusion,
          url: check.url,
        },
        requiresAck: true,
      });

      // Track message sent
      this.emit("reaction.triggered", {
        reactionType: "ci_failure",
        sessionId: session.id,
        action: "send-to-agent",
      });

      // Wait for acknowledgment (with timeout)
      const acked = await mailbox.waitForAck(msgId, { timeout: 60_000 });
      if (!acked) {
        // Escalate to human
        await this.notifier.notify({
          type: "reaction.escalated",
          priority: "action",
          message: `Session ${session.id} did not acknowledge CI fix request`,
          sessionId: session.id,
        });
      }
    }
  }
}
```

**Backward compatibility**: Keep `runtime.sendMessage()` as fallback for agents that don't have inbox watchers yet.

#### 2.2 Auto-start Inbox Watcher

**File**: `packages/cli/src/commands/spawn.ts`

**Changes** (add after agent launch):
```typescript
// Start inbox watcher in background
spinner.text = "Starting inbox watcher";
try {
  await exec("tmux", [
    "send-keys",
    "-t",
    sessionName,
    "-l",
    `AO_SESSION=${sessionName} AO_DATA_DIR=${config.dataDir} nohup ~/scripts/inbox-watcher.sh &> /dev/null &`,
  ]);
  await exec("tmux", ["send-keys", "-t", sessionName, "Enter"]);
} catch (err) {
  // Non-fatal — session will work without mailbox
  spinner.warn("Failed to start inbox watcher");
}
```

#### 2.3 Dashboard Integration

**File**: `packages/web/src/app/api/sessions/[id]/send/route.ts`

**Changes**:
```typescript
import { Mailbox } from "@composio/ao-core";

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const { message } = await request.json();
  const config = loadConfig();
  const mailbox = new Mailbox(config.dataDir, "orchestrator");

  // Send via mailbox (structured)
  await mailbox.send(params.id, {
    type: "custom",
    priority: "normal",
    payload: { text: message },
    requiresAck: false,
  });

  return Response.json({ success: true });
}
```

**Testing**:
- [ ] Manually spawn 2-3 sessions with inbox watcher
- [ ] Send test messages via dashboard
- [ ] Verify messages appear in agent
- [ ] Check acknowledgments work
- [ ] Test with CI failure simulation

---

### Phase 3: Agent-Specific Improvements (Week 3)

**Goals**:
- Direct mailbox integration for agents that support it
- Eliminate inbox watcher dependency for modern agents
- Optimize latency

#### 3.1 Claude Code Direct Integration

**Approach**: Claude Code can read inbox directly via PostToolUse hook (no watcher needed).

**File**: `packages/plugins/agent-claude-code/src/inbox-hook.ts`

**Implementation**:
```bash
#!/usr/bin/env bash
# Claude Code Inbox Hook
# Runs after each tool use to check for new messages

set -euo pipefail

INBOX="$HOME/.ao-sessions/$AO_SESSION/inbox"

# Find unprocessed messages
messages=$(find "$INBOX" -maxdepth 1 -name "*.json" -type f 2>/dev/null | sort)

if [[ -z "$messages" ]]; then
  # No messages, exit silently
  echo '{}'
  exit 0
fi

# Get first unread message
msg_file=$(echo "$messages" | head -1)

# Parse message
if command -v jq &>/dev/null; then
  msg_type=$(jq -r '.type' "$msg_file")
  msg_text=$(jq -r '.payload.text // empty' "$msg_file")
else
  msg_type="custom"
  msg_text="You have a new message. Check $msg_file"
fi

# Move to processed
mkdir -p "$INBOX/processed"
mv "$msg_file" "$INBOX/processed/"

# Display message to Claude
echo "{\"systemMessage\": \"📬 New message (type: $msg_type): $msg_text\"}"
exit 0
```

**Add to settings.json**:
```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": ".claude/inbox-hook.sh",
            "timeout": 5000
          }
        ]
      }
    ]
  }
}
```

**Benefits**:
- No background watcher process needed
- Lower latency (checks after each tool use)
- Agent-native integration
- More reliable

#### 3.2 Codex / Aider Integration

**Approach**: Use inbox watcher until we implement agent-native hooks.

**Future**: Check if Codex/Aider have hook systems, implement similar to Claude Code.

#### 3.3 Update Agent Interface

**File**: `packages/core/src/types.ts`

**Add optional methods**:
```typescript
export interface Agent {
  // ... existing methods ...

  /**
   * Optional: Send structured message to agent session.
   * If not implemented, falls back to runtime.sendMessage().
   */
  sendStructuredMessage?(session: Session, message: Message): Promise<void>;

  /**
   * Optional: Check for incoming messages from agent.
   * Used for bidirectional communication (agent → orchestrator).
   */
  receiveMessages?(session: Session): Promise<Message[]>;

  /**
   * Optional: Setup mailbox for this agent (inbox watcher or hooks).
   * Called during session spawn.
   */
  setupMailbox?(session: Session, dataDir: string): Promise<void>;
}
```

**Implementation example** (Claude Code plugin):
```typescript
async setupMailbox(session: Session, dataDir: string): Promise<void> {
  // Setup inbox hook (reads messages after tool use)
  const hookPath = join(session.workspacePath, ".claude", "inbox-hook.sh");
  await writeFile(hookPath, INBOX_HOOK_SCRIPT, "utf-8");
  await chmod(hookPath, 0o755);

  // Add hook to settings.json
  await this.addInboxHook(session.workspacePath);
}

async sendStructuredMessage(session: Session, message: Message): Promise<void> {
  const mailbox = new Mailbox(session.workspacePath, "orchestrator");
  await mailbox.send(session.id, message);
  // No need to wait for ack - hook will pick it up
}
```

**Testing**:
- [ ] Test Claude Code with inbox hook
- [ ] Compare latency: watcher (5s) vs hook (<1s)
- [ ] Test with Codex/Aider (should still use watcher)
- [ ] Verify backward compatibility

---

### Phase 4: Scale Testing (Week 3)

**Goals**:
- Verify system works with 20+ sessions
- Measure performance and latency
- Identify bottlenecks

#### 4.1 Load Test Setup

**Script**: `scripts/test-mailbox-scale.sh`

```bash
#!/usr/bin/env bash
# Test mailbox system with many sessions

set -euo pipefail

NUM_SESSIONS=${1:-20}
DATA_DIR="$HOME/.ao-test-sessions"

echo "Setting up $NUM_SESSIONS test sessions..."

# Create test sessions
for i in $(seq 1 "$NUM_SESSIONS"); do
  session="test-$i"
  mkdir -p "$DATA_DIR/$session/inbox"
  mkdir -p "$DATA_DIR/$session/outbox"
done

# Send 100 messages to each session
echo "Sending messages..."
start=$(date +%s)

for i in $(seq 1 "$NUM_SESSIONS"); do
  session="test-$i"
  for j in $(seq 1 100); do
    cat > "$DATA_DIR/$session/inbox/msg-$j.json" <<EOF
{
  "id": "msg-$j",
  "from": "orchestrator",
  "to": "$session",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "type": "custom",
  "priority": "normal",
  "payload": {"text": "Test message $j"},
  "requiresAck": false
}
EOF
  done
done

end=$(date +%s)
elapsed=$((end - start))
total_messages=$((NUM_SESSIONS * 100))

echo "Sent $total_messages messages in ${elapsed}s"
echo "Throughput: $((total_messages / elapsed)) msg/s"

# Cleanup
rm -rf "$DATA_DIR"
```

#### 4.2 Performance Metrics

**Track**:
- Message send latency (p50, p95, p99)
- Message delivery latency (orchestrator → agent sees it)
- Acknowledgment latency
- Disk I/O (iops, throughput)
- Memory usage (per session)
- CPU usage (watcher processes)

**Goals**:
- Send latency: <50ms
- Delivery latency: <6s (polling interval + send)
- Acknowledgment: <11s (2x polling interval)
- Throughput: >100 msg/s (20 sessions)
- Memory: <10MB per session
- CPU: <5% total (all watchers)

**Tools**:
```bash
# Monitor disk I/O
iostat -x 1

# Monitor process resources
watch -n 1 'ps aux | grep inbox-watcher'

# Test message delivery latency
time node scripts/test-message-latency.ts
```

#### 4.3 Optimization

**If performance issues**:
1. **Reduce polling interval** (5s → 3s) for faster delivery
2. **Use fs.watch()** instead of polling (instant, but less reliable)
3. **Batch messages** (send multiple in one file)
4. **Compress old messages** (gzip processed/)
5. **File rotation** (move old messages to archive)

**Testing**:
- [ ] Run load test with 20 sessions
- [ ] Measure all metrics
- [ ] Identify bottlenecks
- [ ] Optimize if needed
- [ ] Re-test after optimization

---

### Phase 5: Production Deployment (Week 4)

**Goals**:
- Roll out to production orchestrator
- Monitor performance
- Fix issues
- Gather feedback

#### 5.1 Rollout Plan

**Gradual rollout**:
1. **Week 4 Day 1-2**: Deploy to 2 test sessions
2. **Week 4 Day 3-4**: Deploy to 10 sessions
3. **Week 4 Day 5-7**: Deploy to all sessions

**Feature flags**:
```yaml
# agent-orchestrator.yaml
experiments:
  mailbox_enabled: true  # Enable mailbox system
  mailbox_fallback: true  # Fallback to tmux if mailbox fails
```

#### 5.2 Monitoring

**Metrics to track**:
- Messages sent/received per hour
- Unacknowledged messages count
- Inbox size per session
- Watcher process health
- Message delivery failures
- Latency percentiles

**Alerts**:
- Inbox size >50 messages → session stuck
- Watcher crashed → restart needed
- Message not acked in 5 minutes → escalate
- Disk usage >1GB → rotate old messages

**Dashboard**:
```typescript
// Add to web dashboard
interface MailboxMetrics {
  totalMessages: number;
  unacknowledged: number;
  avgLatency: number;
  p95Latency: number;
  inboxSizes: Record<SessionId, number>;
  watcherHealth: Record<SessionId, "running" | "crashed">;
}
```

#### 5.3 Rollback Plan

**If critical issues**:
1. Disable feature flag: `mailbox_enabled: false`
2. Orchestrator falls back to `runtime.sendMessage()` (tmux)
3. Stop inbox watcher processes: `pkill -f inbox-watcher`
4. Keep mailbox code in place (no code rollback needed)

**Testing**:
- [ ] Deploy to 2 test sessions
- [ ] Monitor for 24 hours
- [ ] Check metrics (no issues)
- [ ] Deploy to 10 sessions
- [ ] Monitor for 48 hours
- [ ] Deploy to all sessions

---

## Migration Strategy

### For Existing Sessions

**Problem**: Existing sessions don't have inbox watchers or mailbox setup.

**Solution**: Add inbox watcher retroactively.

**Script**: `scripts/migrate-sessions-to-mailbox.sh`

```bash
#!/usr/bin/env bash
# Migrate existing sessions to use mailbox

set -euo pipefail

DATA_DIR="${AO_DATA_DIR:-$HOME/.ao-sessions}"

echo "Migrating sessions to mailbox system..."

# Find all active tmux sessions
sessions=$(tmux list-sessions -F "#{session_name}" 2>/dev/null | grep -E "^(ao|integrator)-[0-9]+$" || true)

for session in $sessions; do
  echo "  Migrating $session..."

  # Create inbox/outbox directories
  mkdir -p "$DATA_DIR/$session/inbox/processed"
  mkdir -p "$DATA_DIR/$session/outbox"

  # Start inbox watcher in tmux session
  tmux send-keys -t "$session" Escape 2>/dev/null || continue
  tmux send-keys -t "$session" -l "AO_SESSION=$session AO_DATA_DIR=$DATA_DIR nohup ~/scripts/inbox-watcher.sh &> /dev/null &" 2>/dev/null
  tmux send-keys -t "$session" Enter 2>/dev/null

  echo "    ✓ Migrated $session"
done

echo "Migration complete!"
```

**Run once during deployment**:
```bash
~/scripts/migrate-sessions-to-mailbox.sh
```

### For New Sessions

**Auto-enabled**: New sessions spawned with `ao spawn` automatically get:
- Inbox/outbox directories created
- Inbox watcher started (or hooks configured for Claude Code)
- Metadata initialized

**No manual steps needed**.

---

## Backward Compatibility

### Runtime Interface

**Current**:
```typescript
interface Runtime {
  sendMessage(handle: RuntimeHandle, message: string): Promise<void>;
}
```

**No changes needed** — keep this as fallback.

### Hybrid Approach

**Lifecycle manager**:
```typescript
async sendToSession(session: Session, message: string | Message): Promise<void> {
  if (typeof message === "string") {
    // Legacy: string message via runtime
    await this.runtime.sendMessage(session.runtimeHandle!, message);
  } else {
    // New: structured message via mailbox
    const mailbox = new Mailbox(this.dataDir, "orchestrator");
    await mailbox.send(session.id, message);
  }
}
```

**Gradual migration**: Both approaches work simultaneously.

---

## Future Enhancements

### Phase 6: Advanced Features (Post-Launch)

1. **Message threading** (replyTo chains)
2. **Broadcast messages** (one-to-many)
3. **Message priorities** (urgent messages skip queue)
4. **Rich message types** (attachments, images, code blocks)
5. **Message search** (query mailbox history)
6. **Message analytics** (response times, ack rates)

### Phase 7: Cross-Runtime Support

1. **Docker**: Mount mailbox volume
2. **Kubernetes**: Use PersistentVolume
3. **SSH**: rsync mailbox over SSH
4. **Cloud**: S3/GCS-backed mailbox

### Phase 8: Agent-Native Protocols

1. **Claude Code teams integration**: Use Claude's native mailbox
2. **Codex API**: If Codex adds messaging API
3. **Aider hooks**: If Aider adds hook system
4. **Universal protocol**: MCP for agent messaging

---

## Timeline Summary

| Phase | Duration | Deliverables | Status |
|-------|----------|--------------|--------|
| 1. Core Infrastructure | Week 1 | Mailbox, tests, docs, CLI | ✅ DONE |
| 2. Lifecycle Integration | Week 2 | Lifecycle sends messages | ⏳ TODO |
| 3. Agent Improvements | Week 3 | Claude Code hooks, optimizations | ⏳ TODO |
| 4. Scale Testing | Week 3 | 20+ session load test | ⏳ TODO |
| 5. Production Deploy | Week 4 | Gradual rollout, monitoring | ⏳ TODO |
| 6. Advanced Features | Post-launch | Threading, broadcast, rich messages | 📋 Backlog |
| 7. Cross-Runtime | Post-launch | Docker, k8s, SSH | 📋 Backlog |
| 8. Agent-Native | Post-launch | MCP, native protocols | 📋 Backlog |

**Total time to production**: 4 weeks

---

## Success Criteria

### Week 2 (Lifecycle Integration)
- ✅ Lifecycle manager sends CI failure messages via mailbox
- ✅ Sessions receive and acknowledge messages
- ✅ Acknowledgment timeout triggers escalation
- ✅ Backward compatibility maintained (runtime.sendMessage still works)

### Week 3 (Scale & Optimization)
- ✅ 20 sessions handle 100 messages each (2000 total)
- ✅ Message delivery <6s (p95)
- ✅ Acknowledgment <11s (p95)
- ✅ No crashes or data loss
- ✅ Claude Code inbox hook reduces latency to <1s

### Week 4 (Production)
- ✅ All sessions using mailbox
- ✅ Zero critical issues
- ✅ Metrics dashboard showing health
- ✅ Documentation complete
- ✅ Team trained on new system

---

## Risk Mitigation

### Risk 1: File System Performance

**Risk**: High I/O from 20+ sessions could slow down filesystem.

**Mitigation**:
- Use SSD (Agent Orchestrator already requires SSD)
- Batch messages if needed
- Monitor iostat, alert on high usage
- Implement file rotation (move old messages)

### Risk 2: Inbox Watcher Crashes

**Risk**: Watcher process crashes, messages not delivered.

**Mitigation**:
- Watchdog process restarts crashed watchers
- Orchestrator detects missing acks, escalates
- Dashboard shows watcher health
- Messages queue in inbox (not lost)

### Risk 3: Message Delivery Latency

**Risk**: 5-10 second latency too slow for urgent messages.

**Mitigation**:
- Priority field: urgent messages checked more frequently
- Hybrid approach: urgent messages via tmux + mailbox
- Claude Code inbox hook: <1s latency
- fs.watch() for instant delivery (if reliable on system)

### Risk 4: Backward Compatibility

**Risk**: Breaking existing tmux-based communication.

**Mitigation**:
- Keep runtime.sendMessage() working
- Hybrid approach: both methods supported
- Feature flag: can disable mailbox
- Gradual rollout: test before full deploy

---

## Conclusion

The file-based mailbox system provides a **reliable, structured, and scalable** alternative to fragile tmux send-keys communication. The implementation is complete and tested, with a clear integration path that maintains backward compatibility.

**Key benefits**:
- ✅ Structured JSON messages with schema
- ✅ Acknowledgment support for reliability
- ✅ Message history for debugging
- ✅ No agent modifications required
- ✅ Works with any runtime (tmux, docker, k8s)
- ✅ Proven approach (Claude Code uses this)

**Next steps**: Begin Phase 2 (Lifecycle Integration) to connect the mailbox system to the orchestrator's reaction engine.

---

## Related Files

- [agent-communication.md](./agent-communication.md) - Architecture analysis
- `packages/core/src/mailbox.ts` - Core implementation
- `packages/core/src/mailbox.test.ts` - Test suite
- `scripts/inbox-watcher.sh` - Message delivery script
- `packages/cli/src/commands/spawn.ts` - CLI with --prompt flag
