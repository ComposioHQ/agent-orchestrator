# Design: Fix ao send message Enter race condition (Issue #564)

## Problem Statement

`ao send <session> <message>` pastes the message text into the Claude Code interactive prompt but the Enter key doesn't always register, leaving the message pasted but not submitted. The agent sits idle with the text visible in the input area.

### Steps to Reproduce

1. `ao start` with `agent: claude-code` and `permissions: permissionless`
2. `ao spawn` to create a session — agent launches, completes initial task, goes idle
3. `ao send <session> <long multi-line message>`
4. AO reports `Message sent and processing`
5. But the agent shows the pasted text in the input area without submitting it — the Enter key was not processed

### Root Cause Analysis

In `packages/plugins/runtime-tmux/src/index.ts` L147-150:

```ts
// Small delay to let tmux process the pasted text before pressing Enter.
// Without this, Enter can arrive before the text is fully rendered.
await sleep(300);
await tmux("send-keys", "-t", handle.id, "Enter");
```

The 300ms delay may be insufficient for large multi-line pastes. Claude Code's TUI (ink-based React renderer) needs time to:
1. Process the pasted text character by character
2. Update its internal state
3. Re-render the input field

The delivery confirmation logic (`session-manager.ts:1635`) sees the output changed (pasted text appeared in the buffer) and reports success, even though the message was never actually submitted to the agent.

## Possible Approaches

### Approach 1: Increase the Fixed Delay

**Description**: Simply increase the 300ms delay to a larger value (e.g., 500ms, 1000ms, or even 2000ms).

**Pros**:
- Simple implementation (one line change)
- No complex logic

**Cons**:
- Still a race condition - fundamentally doesn't solve the problem
- Makes all sends slower, even short messages
- No guarantee it will work for all cases
- Wastes time on messages that would have worked with 300ms

**Risk**: Low

**Verdict**: Not recommended. This is a band-aid, not a fix.

---

### Approach 2: Adaptive Delay Based on Message Size

**Description**: Calculate delay based on message length (e.g., 100ms base + 2ms per character).

```ts
const delayMs = Math.min(100 + message.length * 2, 2000);
await sleep(delayMs);
```

**Pros**:
- Simple implementation
- Scales with message size
- Short messages still fast

**Cons**:
- Still fundamentally a race condition
- Heuristic - no guarantee it will work
- Terminal/agent performance variations not accounted for

**Risk**: Low

**Verdict**: Better than fixed delay, but still a heuristic hack. Use as fallback only.

---

### Approach 3: Verify Enter Was Processed (Retry Loop)

**Description**: After sending Enter, capture the pane output and check if the pasted text is still in the input area. If it's still there, retry sending Enter. Give up after N attempts with exponential backoff.

**Pros**:
- Actually solves the problem by verifying success
- Exponential backoff handles edge cases
- Only retries when needed

**Cons**:
- More complex implementation
- Requires heuristics to detect if text is still in input (hard to distinguish from terminal echo)
- Multiple capture-pane calls add overhead

**Risk**: Medium - detecting "message still in input" is tricky

**Verdict**: Good approach if we can reliably detect the failure state.

---

### Approach 4: Bracketed Paste Mode

**Description**: Wrap the paste in bracketed paste mode escape sequences (`\e[200~` before, `\e[201~` after). This tells the terminal that the paste is atomic, and the application should handle the paste as a single event.

```ts
await tmux("send-keys", "-t", handle.id, "C-u");
await tmux("send-keys", "-t", handle.id, "-l", "\x1b[200~"); // start bracketed paste
// paste the message
await tmux("send-keys", "-t", handle.id, "-l", "\x1b[201~"); // end bracketed paste
await sleep(300);
await tmux("send-keys", "-t", handle.id, "Enter");
```

**Pros**:
- Standard terminal protocol
- Minimal code change
- No additional delay needed (bracketed paste signals completion)

**Cons**:
- Not all terminals support bracketed paste mode
- Claude Code's ink-based TUI may not honor bracketed paste
- Still doesn't verify Enter was processed

**Risk**: Medium - depends on Claude Code TUI support

**Verdict**: Good complementary approach, but not sufficient alone.

---

### Approach 5: Bracketed Paste + Adaptive Retry (RECOMMENDED)

**Description**: Combine bracketed paste mode with an adaptive retry mechanism:

1. Use bracketed paste mode to signal paste completion to the terminal
2. Send Enter
3. Capture the pane output
4. Check if the message is still visible (incomplete submission)
5. If still visible after 500ms, retry Enter
6. Repeat up to 3 times with exponential backoff (500ms, 1000ms, 2000ms)

**Pros**:
- Multiple layers of protection
- Bracketed paste reduces the chance of race condition
- Retry loop catches the cases where it still fails
- Exponential backoff handles slow terminals/agents
- Only adds delay when needed

**Cons**:
- Most complex implementation
- Requires careful failure detection logic

**Risk**: Medium - complexity, but mitigated by using bracketed paste first

**Verdict**: **RECOMMENDED** - Best balance of reliability and complexity.

---

### Approach 6: Type Message Character by Character

**Description**: Instead of pasting, type the message one character at a time with small delays between characters, simulating real typing.

**Pros**:
- Eliminates paste-related race conditions
- Very reliable

**Cons**:
- Extremely slow for long messages (could take minutes)
- Unacceptable user experience

**Risk**: High - terrible UX

**Verdict**: Not viable for production use.

---

## Comparison Table

| Approach | Reliability | Complexity | Performance | Recommended |
|----------|-------------|------------|-------------|-------------|
| 1: Fixed Delay | Low | Very Low | Slow | No |
| 2: Adaptive Delay | Medium-Low | Low | Medium | No |
| 3: Retry Loop | High | Medium | Medium | Maybe |
| 4: Bracketed Paste | Medium | Low | Fast | No |
| **5: Bracketed + Retry** | **High** | **Medium** | **Fast** | **Yes** |
| 6: Char-by-Char | Very High | High | Very Slow | No |

## Recommended Implementation: Approach 5

### Why This Approach?

1. **Bracketed paste** reduces the likelihood of the race condition occurring
2. **Retry with verification** catches the edge cases where bracketed paste doesn't help
3. **Exponential backoff** ensures we don't hammer the system
4. **Minimal delay in success cases** - only adds overhead when retry is needed

### Implementation Details

#### Bracketed Paste Integration

For `load-buffer + paste-buffer` path:
- Send bracketed paste start sequence before paste
- Send bracketed paste end sequence after paste
- Keep the 300ms delay (as safety margin)

For `send-keys -l` path:
- Wrap the message in bracketed paste sequences

#### Retry Logic

```
After sending Enter:
1. Wait 500ms for terminal to process
2. Capture pane output
3. Check if message is still visible (heuristic: message text appears in last line of output)
4. If visible:
   - Retry Enter
   - Increase wait time (exponential backoff)
   - Repeat up to 3 times
5. If still visible after 3 retries:
   - Log warning but don't fail (best effort)
```

#### Detection Heuristic

To detect if message is still in input area:
- Capture the last N lines of output (e.g., 5 lines)
- Check if the message or its last few lines are present
- The message should NOT be visible if it was submitted (agent would have started processing)

**Note**: This is a best-effort heuristic. The important thing is that we retry Enter when we detect a likely failure. If we don't detect it, the 3 retries with backoff provide additional safety.

### Pseudocode

```typescript
async function sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 500;

  // Clear input
  await tmux("send-keys", "-t", handle.id, "C-u");

  // Send bracketed paste start
  await tmux("send-keys", "-t", handle.id, "-l", "\x1b[200~");

  // Paste message (existing logic for long/short messages)
  if (message.includes("\n") || message.length > 200) {
    // use load-buffer + paste-buffer
    ...
  } else {
    await tmux("send-keys", "-t", handle.id, "-l", message);
  }

  // Send bracketed paste end
  await tmux("send-keys", "-t", handle.id, "-l", "\x1b[201~");

  // Retry Enter with verification
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
    await tmux("send-keys", "-t", handle.id, "Enter");

    // Check if message was submitted (skip on last attempt)
    if (attempt < MAX_RETRIES - 1) {
      await sleep(200); // Brief wait for output to settle
      const output = await tmux("capture-pane", "-t", handle.id, "-p", "-S", "-5");
      if (!messageStillInOutput(message, output)) {
        // Message was submitted, done
        break;
      }
    }
  }
}

function messageStillInOutput(message: string, output: string): boolean {
  // Heuristic: check if the last line of the message is in the output
  const lastLines = message.split('\n').slice(-3).join('\n');
  return output.includes(lastLines) && !output.includes("Claude"); // Exclude cases where agent started
}
```

### Testing Strategy

1. Unit tests for the retry logic
2. Integration tests with mock tmux that simulates slow terminals
3. Manual testing with real Claude Code sessions

### Migration Notes

- No breaking changes
- Existing behavior preserved for simple cases
- Only adds retry logic when needed

## Conclusion

Approach 5 (Bracketed Paste + Adaptive Retry) provides the best balance of reliability, complexity, and performance. It addresses the root cause (race condition) at multiple levels while maintaining good performance for successful cases.
