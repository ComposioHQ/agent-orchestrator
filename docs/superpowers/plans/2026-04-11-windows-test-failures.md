# Windows Test Failures Inventory

**Date:** 2026-04-11
**Branch:** `feat/windows-platform-adapter`
**Latest commit:** `aa568356` — fix(windows): address review comments + coverage for pipe relay

---

## Summary

| Package | Failed | Passed | Total |
|---------|--------|--------|-------|
| @aoagents/ao-core | 31 | 613 | 644 |
| @aoagents/ao-plugin-agent-codex | 35 | 161 | 196 |
| @aoagents/ao-plugin-agent-claude-code | 2 | 159 | 161 |
| @aoagents/ao-plugin-agent-opencode | 4 | 94 | 98 |
| @aoagents/ao-plugin-agent-aider | 2 | 49 | 51 |
| @aoagents/ao-cli | 6 | 325 | 336 |
| @aoagents/ao-web | 0 | 549 | 549 |
| @aoagents/ao-plugin-runtime-process | 0 | 48 | 48 |
| **Total** | **80** | **1998** | **2083** |

---

## Root Causes

| # | Cause | Tests Affected | Fix Strategy |
|---|-------|----------------|--------------|
| RC-1 | Path separator: regex/assertions use `/`, Windows returns `\` | ~10 | Use `[/\\]` in regex or normalize paths |
| RC-2 | POSIX shell escape: tests expect `'\''` (bash), Windows shellEscape uses `''` (PowerShell) | ~6 | `skipIf(isWindows)` or platform-aware assertion |
| RC-3 | Mock `opencode` binary is a bash script (can't execute on Windows) | ~25 | Rewrite mock as Node.js script |
| RC-4 | Codex shell wrapper content tests (bash wrappers don't exist on Windows — `.cmd` instead) | ~30 | `skipIf(isWindows)` — different content by design |
| RC-5 | CLI scripts (`ao-doctor.sh`, `ao-update.sh`) require bash | ~5 | `skipIf(isWindows)` |
| RC-6 | Misc: openclaw binary spawn ENOENT, send busy-detection | ~4 | Individual fixes |

---

## Failing Tests by Package

### @aoagents/ao-core (31 failures)

**File: `src/__tests__/paths.test.ts`** (6 tests) — RC-1

- `getProjectBaseDir returns correct format`
- `getSessionsDir returns {baseDir}/sessions`
- `getWorktreesDir returns {baseDir}/worktrees`
- `getFeedbackReportsDir returns {baseDir}/feedback-reports`
- `getArchiveDir returns {baseDir}/sessions/archive`
- `getOriginFilePath returns {baseDir}/.origin`

**File: `src/__tests__/session-manager/communication.test.ts`** (9 tests) — RC-3

- `send > auto-discovers OpenCode mapping before sending when missing`
- `send > re-discovers OpenCode mapping before sending when stored mapping is invalid`
- `send > confirms OpenCode delivery from session updated timestamps`
- `send > does not confirm OpenCode delivery from timestamp visibility alone`
- `remap > refreshes mapping when force remap is requested`
- `remap > uses a longer discovery timeout for explicit remap operations`
- `remap > discovers mapping by AO session title and persists it`
- `remap > falls back to title discovery when persisted mapping is invalid`
- `remap > uses the project agent fallback when metadata does not persist the agent name`

**File: `src/__tests__/session-manager/lifecycle.test.ts`** (6 tests) — RC-3

- `kill > destroys runtime, workspace, and archives metadata`
- `kill > destroys workspace under legacy ~/.worktrees root`
- `kill > purges mapped OpenCode session when requested`
- `cleanup > deletes mapped OpenCode session during cleanup`
- `cleanup > deletes mapped OpenCode session from archived killed sessions`
- `cleanup > does not skip archived cleanup for matching session IDs in other projects`

**File: `src/__tests__/session-manager/query.test.ts`** (2 tests) — RC-3

- `get > auto-discovers and persists OpenCode session mapping when missing`
- `get > reuses a single OpenCode session list lookup when multiple unmapped sessions are listed`

**File: `src/__tests__/session-manager/restore.test.ts`** (1 test) — RC-3

- `restore > re-discovers OpenCode mapping when stored mapping is invalid`

**File: `src/__tests__/session-manager/spawn.test.ts`** (7 tests) — RC-3 + misc

- `spawn > skips remote session branches when allocating a fresh session id`
- `spawn > deletes old issue mappings and starts fresh when opencodeIssueSessionStrategy is delete`
- `spawnOrchestrator > deletes previous OpenCode orchestrator sessions before starting`
- `spawnOrchestrator > discovers and persists OpenCode session id by title when strategy is reuse`
- `spawnOrchestrator > reuses mapped OpenCode session id when strategy is reuse and opencode lists it by title`
- `spawnOrchestrator > discovers OpenCode mapping by title when no archived mapping exists for new session id`
- `spawnOrchestrator > reuses OpenCode session by title when orchestrator mapping is missing`

---

### @aoagents/ao-plugin-agent-codex (35 failures)

**File: `src/index.test.ts`**

*RC-2 (1 test):*
- `getLaunchCommand > escapes single quotes in prompt (POSIX shell escaping)`

*RC-1 (5 tests):*
- `getEnvironment > prepends ~/.ao/bin to PATH for shell wrappers`
- `getEnvironment > PATH starts with the ao bin dir specifically`
- `getEnvironment > puts /usr/local/bin before linuxbrew paths`
- `getEnvironment > deduplicates ao and /usr/local/bin entries`
- `getEnvironment > falls back to /usr/bin:/bin when process.env.PATH is undefined`

*RC-1 (2 tests):*
- `resolveCodexBinary > checks ~/.cargo/bin/codex as fallback (Rust-based codex)`
- `resolveCodexBinary > checks ~/.npm/bin/codex as fallback`

*RC-4 — Shell wrapper content tests (27 tests):*
- `setupWorkspaceHooks > creates ~/.ao/bin directory`
- `setupWorkspaceHooks > writes ao-metadata-helper.sh with executable permissions via atomic write`
- `setupWorkspaceHooks > writes gh and git wrappers atomically when version marker is missing`
- `setupWorkspaceHooks > sets executable permissions on gh and git wrappers via writeFile mode`
- `setupWorkspaceHooks > writes ao session context to .ao/AGENTS.md`
- `setupWorkspaceHooks > uses atomic write (temp + rename) to prevent partial reads from concurrent sessions`
- `setupWorkspaceHooks > writes .ao/AGENTS.md without modifying repo-tracked AGENTS.md`
- `shell wrapper content > metadata helper > contains update_ao_metadata function`
- `shell wrapper content > metadata helper > uses AO_DATA_DIR and AO_SESSION env vars`
- `shell wrapper content > metadata helper > escapes sed metacharacters in values`
- `shell wrapper content > metadata helper > uses atomic temp file + mv pattern`
- `shell wrapper content > metadata helper > validates session name has no path separators`
- `shell wrapper content > metadata helper > validates ao_dir is an absolute path under expected locations`
- `shell wrapper content > metadata helper > resolves symlinks and verifies file stays within ao_dir`
- `shell wrapper content > gh wrapper > uses grep -Fxv for PATH cleaning (not regex grep)`
- `shell wrapper content > gh wrapper > only captures output for pr/create and pr/merge`
- `shell wrapper content > gh wrapper > uses exec for non-PR commands (transparent passthrough)`
- `shell wrapper content > gh wrapper > prefers GH_PATH when provided and executable`
- `shell wrapper content > gh wrapper > guards against recursive GH_PATH pointing to ao wrapper dir`
- `shell wrapper content > gh wrapper > extracts PR URL from gh pr create output`
- `shell wrapper content > gh wrapper > updates status to merged on gh pr merge`
- `shell wrapper content > gh wrapper > cleans up temp file on exit`
- `shell wrapper content > git wrapper > uses grep -Fxv for PATH cleaning (not regex grep)`
- `shell wrapper content > git wrapper > captures branch name from checkout -b`
- `shell wrapper content > git wrapper > captures branch name from switch -c`
- `shell wrapper content > git wrapper > only updates metadata on success (exit code 0)`
- `shell wrapper content > git wrapper > sources the metadata helper`

---

### @aoagents/ao-plugin-agent-claude-code (2 failures)

**File: `src/index.test.ts`** — RC-1

- `getSessionInfo > path conversion > converts workspace path to Claude project dir path`
- `hook setup — relative path (symlink-safe) > still writes the script file to the correct absolute filesystem path`

---

### @aoagents/ao-plugin-agent-opencode (4 failures)

**File: `src/index.test.ts`** — RC-2 + RC-1

- `getLaunchCommand > escapes single quotes in prompt (POSIX shell escaping)`
- `getLaunchCommand > escapes single quotes in systemPrompt`
- `getLaunchCommand > escapes path in systemPromptFile`
- `getEnvironment PATH > prepends ~/.ao/bin to PATH`

---

### @aoagents/ao-plugin-agent-aider (2 failures)

**File: `src/index.test.ts`** — RC-2 + RC-1

- `getLaunchCommand > escapes single quotes in prompt (POSIX shell escaping)`
- `getEnvironment PATH > prepends ~/.ao/bin to PATH`

---

### @aoagents/ao-cli (6 failures)

**File: `__tests__/scripts/doctor-script.test.ts`** (2 tests) — RC-5

- `scripts/ao-doctor.sh > reports a healthy install as PASS`
- `scripts/ao-doctor.sh > applies safe fixes for missing launcher, missing dirs, and stale temp files`

**File: `__tests__/scripts/update-script.test.ts`** (1 test) — RC-5

- `scripts/ao-update.sh > runs the built-in smoke commands in smoke-only mode`

**File: `__tests__/lib/openclaw-probe.test.ts`** (2 tests) — RC-6

- `detectOpenClawInstallation > reports installed-but-stopped when binary exists but gateway is down`
- `detectOpenClawInstallation > reports running when gateway is reachable`

**File: `__tests__/commands/send.test.ts`** (1 test) — RC-6

- `send command > busy detection > detects busy session and waits via agent plugin`
