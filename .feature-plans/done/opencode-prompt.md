# Feature Plan: OpenCode Initial Prompt Not Sent

**Issue:** opencode-prompt
**Branch:** `feat/opencode-prompt`
**Status:** Done

---

## Problem

- Initial prompt is not submitted to the LLM when using OpenCode as an agent
- The two-step launch sequence creates the session correctly but silently swallows the prompt

## Research

### Why post-launch delivery fails for OpenCode

- **File:** `packages/core/src/session-manager.ts:1303-1333`
- Post-launch `sendMessage` (used by Claude Code) types text into tmux via `send-keys`/`paste-buffer`
- Claude Code's launch is a single fast command (`claude`), so the TUI is ready when sendMessage fires
- OpenCode's launch is a multi-step shell script (5-10s): `opencode run | node` → fallback discovery → `exec opencode --session`
- sendMessage fires while the shell script is still running — the text goes to the shell, not the TUI
- All 3 retry attempts (3s, 9s, 18s) can fire before or during the launch script

### Capture script bottleneck

- **File:** `packages/plugins/agent-opencode/src/index.ts:80-118`
- Original capture script waited for `opencode run` to finish (stdin EOF) before outputting session_id
- With a prompt, `opencode run` blocks until the LLM responds (30s+), causing a blank tmux pane
- Fix: exit immediately after finding session_id — `opencode run` gets SIGPIPE, but the session is already created and prompt submitted

## Root Cause

- Post-launch `sendMessage` has a fundamental timing incompatibility with OpenCode's multi-step launch script
- The prompt text gets pasted into the terminal and consumed by the shell pipeline, not the OpenCode TUI

## Approach

### Fix: Inline prompt delivery via `opencode run`

- Remove `promptDelivery: "post-launch"` — use inline delivery (default)
- Pass `config.prompt` as positional arg to `opencode run`: `opencode run --format json --title "AO:..." 'the prompt'`
- Modify capture script to exit immediately after finding session_id (no wait for stdin EOF)
- Priority chain for message value: `systemPromptFile > systemPrompt > config.prompt > --command true`

**Behavioral difference:**
- Before: session created without a message, sendMessage fires into shell pipeline → prompt lost
- After: prompt submitted to LLM via `opencode run`, capture script exits early (SIGPIPE), TUI opens on existing session

## Files Modified

| File | Change |
|------|--------|
| `packages/plugins/agent-opencode/src/index.ts` | Inline prompt delivery, capture script exits early |
| `packages/plugins/agent-opencode/src/index.test.ts` | Updated tests to match inline prompt behavior |

## Validation

- All 94 tests pass
- Typecheck clean on opencode plugin
- Build succeeds
