# Feature Plan: OpenCode Initial Prompt Not Sent

**Issue:** opencode-prompt
**Branch:** `feat/opencode-prompt`
**Status:** Done

---

## Problem

- Initial prompt is not submitted to the LLM when using OpenCode as an agent
- The two-step launch sequence creates the session correctly but silently swallows the prompt
- OpenCode's TUI `--prompt` flag only pre-fills the input box; it does not auto-submit

## Research

### getLaunchCommand — new session path

- **File:** `packages/plugins/agent-opencode/src/index.ts:250-271`
- **Trigger:** Every new OpenCode session spawn (no existing `opencodeSessionId`)
- **Risk:** HIGH — prompt completely lost for all new sessions

Two-step sequence:
1. `opencode run --format json --title "AO:..." --command true` — creates session, captures SES_ID, sends **no message**
2. `exec opencode --session "$SES_ID" --prompt "..."` — resumes in TUI mode

The bug is in step 2. `opencode` TUI's `--prompt` option pre-fills the text input, it does not auto-submit.

Confirmed via `opencode --help`: the flag says "prompt to use" (ambiguous). Testing shows TUI pre-fill behavior.

### opencode run positional arg

- **File:** `packages/plugins/agent-opencode/src/index.ts:261`
- `opencode run [message..]` — message is a positional array; passed to the LLM immediately
- Session JSON events include `session_id` — captured by existing `buildSessionIdCaptureScript`

## Root Cause

- Prompt is passed to TUI mode via `--prompt` which only pre-fills the input box
- Should be passed to `opencode run` as a positional message arg, which submits it to the LLM
- The `--command true` approach (used when no prompt) is fine for session creation only

## Approach

### Fix: Pass prompt as positional arg to `opencode run`

- Change `runCommandParts`: if `promptValue` exists, append it as positional arg; else keep `--command true`
- Remove `promptValue` from `resumeOptions` (already consumed by `opencode run`)
- `sharedOptions` (model, agent) still passed to both run and TUI resume

**Behavioral difference:**
- Before: prompt pre-filled in TUI input box (not submitted)
- After: prompt submitted to LLM via `opencode run` before TUI opens; session continues in TUI

## Files Modified

| File | Change |
|------|--------|
| `packages/plugins/agent-opencode/src/index.ts` | Prompt as positional arg in `opencode run`, removed from TUI resume |
| `packages/plugins/agent-opencode/src/index.test.ts` | Updated 15+ tests to match new command structure |

## Validation

- All 93 tests pass
- Typecheck clean on opencode plugin
- Build succeeds
