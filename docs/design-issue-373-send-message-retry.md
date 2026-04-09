# Design Doc: Fix `ao send` Message Delivery for Long Messages

**Issue:** [#373](https://github.com/ComposioHQ/agent-orchestrator/issues/373)  
**Status:** Implemented  
**PR:** [#541](https://github.com/ComposioHQ/agent-orchestrator/pull/541)

## Problem Statement

When `ao send <session> <long-message>` is used with messages over 200 characters (triggering the tmux paste-buffer code path), the message gets pasted into the agent's input buffer but the Enter keystroke that follows often doesn't register. The agent sits idle with the pasted content visible but never processes it.

### Evidence

- Messages under 200 chars (direct `send-keys -l` path) work reliably
- Messages over 200 chars (paste-buffer path) frequently fail
- Failure rate increases with message size (4KB+ worst)
- Manually sending Enter afterwards always works
- `tmux capture-pane` shows the pasted content is there, just not submitted

### Root Cause

The fixed 1000ms delay between paste-buffer and the Enter keystroke is insufficient for large messages (4KB+). The agent's input handling hasn't finished processing the pasted content when Enter arrives, so Enter gets swallowed.

---

## Approaches Considered

### Approach 1: Fixed Delay Increase

**Description:** Simply increase the fixed delay from 1000ms to a higher value (e.g., 3000ms).

**Pros:**
- Simple implementation
- No additional complexity

**Cons:**
- Still fails for very large messages (10KB+)
- Adds unnecessary delay for smaller messages
- No feedback mechanism to confirm delivery
- Wastes time on successful deliveries

**Verdict:** ❌ Not recommended - doesn't scale with message size

---

### Approach 2: Adaptive Delay (Implemented)

**Description:** Scale the delay proportionally with message length.

```
delay = base_delay + (message_length / 1000) * length_factor
delay = min(delay, max_delay)

Where:
- base_delay = 1000ms (for paste-buffer path)
- length_factor = 200ms per KB
- max_delay = 2000ms
```

**Pros:**
- Scales with message size
- Simple to implement
- No additional tmux calls needed
- Predictable behavior

**Cons:**
- Still a guess - no confirmation of delivery
- May over-delay on fast systems
- May under-delay on slow systems

**Verdict:** ✅ Good baseline, but needs confirmation mechanism

---

### Approach 3: Enter Retry with Output Confirmation (Implemented)

**Description:** After sending Enter, capture pane output and verify the agent started processing. If output didn't change, retry Enter up to N times.

```typescript
for (attempt = 0; attempt < maxRetries; attempt++) {
  beforeOutput = capturePane()
  sendKeys("Enter")
  sleep(500)
  afterOutput = capturePane()
  
  if (afterOutput !== beforeOutput) {
    break  // Agent is processing
  }
  // Output unchanged - Enter was swallowed, retry
  sleep(300 * (attempt + 1))  // Increasing backoff
}
```

**Pros:**
- Confirms delivery actually happened
- Self-correcting - retries if needed
- Works regardless of system speed
- Only retries when necessary

**Cons:**
- Extra tmux capture-pane calls
- Adds ~500ms latency per retry
- More complex logic

**Verdict:** ✅ Recommended - provides reliability guarantee

---

### Approach 4: File-Based Message Delivery

**Description:** Instead of pasting text, write message to a temp file and have the agent read it.

```bash
# Write message to file
echo "$message" > /tmp/ao-msg-{session}.txt

# Send command to read file
tmux send-keys -t session "cat /tmp/ao-msg-{session}.txt" Enter
```

**Pros:**
- Bypasses tmux paste-buffer entirely
- No size limitations
- No timing issues

**Cons:**
- Requires agent support for reading files
- Changes agent workflow
- Not transparent to the agent
- Requires cleanup of temp files
- Doesn't work for all agent types

**Verdict:** ❌ Not recommended - requires agent changes, not generalizable

---

### Approach 5: Bracketed Paste Mode

**Description:** Use tmux's bracketed paste mode to wrap pasted content with special sequences that the terminal recognizes.

**Pros:**
- Standard terminal feature
- Clear start/end of paste

**Cons:**
- Requires terminal/agent support
- Still has timing issues
- Not universally supported

**Verdict:** ❌ Not recommended - doesn't solve the core timing issue

---

## Recommended Solution: Approach 2 + Approach 3 (Hybrid)

**Implementation:** Combine adaptive delay with Enter retry confirmation.

### Algorithm

```typescript
async function sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
  // Clear partial input
  await tmux("send-keys", "-t", handle.id, "C-u");
  
  // Paste message (via buffer for long/multiline)
  if (message.length > 200 || message.includes("\n")) {
    await pasteViaBuffer(handle.id, message);
  } else {
    await tmux("send-keys", "-t", handle.id, "-l", message);
  }
  
  // Adaptive delay based on message size
  const baseDelay = isLongMessage ? 1000 : 100;
  const lengthFactor = Math.floor(message.length / 1000) * 200;
  const delay = Math.min(baseDelay + lengthFactor, 2000);
  await sleep(delay);
  
  // Enter with retry for large messages
  const needsRetry = message.length > 1000;
  const maxRetries = needsRetry ? 3 : 1;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let beforeOutput = "";
    if (needsRetry) {
      beforeOutput = await capturePane(handle.id);
    }
    
    await tmux("send-keys", "-t", handle.id, "Enter");
    
    if (needsRetry) {
      await sleep(500);
      const afterOutput = await capturePane(handle.id);
      
      if (afterOutput !== beforeOutput) {
        break;  // Success - agent is processing
      }
      
      // Retry with backoff
      await sleep(300 * (attempt + 1));
    }
  }
}
```

### Why This Approach?

1. **Adaptive delay** handles the common case efficiently
2. **Retry logic** provides safety net for edge cases
3. **Confirmation mechanism** ensures reliability
4. **Backoff strategy** prevents tight retry loops
5. **Only retries for large messages** - minimizes overhead for small messages

### Performance Characteristics

| Message Size | Delay | Max Retries | Worst Case |
|-------------|-------|-------------|------------|
| < 200 chars | 100ms | 1 | 100ms |
| 1KB | 1200ms | 1 | 1200ms |
| 4KB | 1800ms | 3 | 1800ms + 3×(500ms+backoff) ≈ 4.2s |
| 10KB | 2000ms | 3 | 2000ms + 3×(500ms+backoff) ≈ 4.4s |

---

## Implementation Details

### Files Modified

1. **`packages/core/src/tmux.ts`**
   - Updated `sendKeys()` function with adaptive delay and retry logic
   
2. **`packages/plugins/runtime-tmux/src/index.ts`**
   - Updated `sendMessage()` method with same logic

### Test Coverage

- ✅ Short text (< 200 chars) - direct send-keys
- ✅ Long text (> 200 chars) - paste-buffer path
- ✅ Multiline text - paste-buffer path
- ✅ Large messages (> 1KB) - retry logic triggered

### Backward Compatibility

- No API changes
- No configuration changes required
- Gracefully degrades to single Enter for small messages

---

## Future Improvements

1. **Configurable delays** - Allow users to tune delays via config
2. **Agent-specific handling** - Different strategies for different agents
3. **Telemetry** - Track retry rates to tune parameters
4. **File-based fallback** - For extremely large messages (>100KB)

---

## References

- Original issue: https://github.com/ComposioHQ/agent-orchestrator/issues/373
- Implementation PR: https://github.com/ComposioHQ/agent-orchestrator/pull/541
- tmux paste-buffer documentation: https://man.openbsd.org/tmux#paste-buffer
