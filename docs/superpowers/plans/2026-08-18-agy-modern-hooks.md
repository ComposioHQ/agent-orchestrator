# AGY Modern Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace AGY's obsolete Gemini-style hook integration with the modern Antigravity workspace hook contract so AO receives reliable active and idle Kanban signals.

**Architecture:** The AGY adapter will own one named `agent-orchestrator` object inside `.agents/hooks.json`, preserving every other top-level JSON member. The named object will install `PreInvocation`, `PostToolUse`, and `Stop` commands which normalize into AO activity signals; process exit and SCM statuses remain owned by existing runtime and SCM services.

**Tech Stack:** Go 1.26, JSON via `encoding/json`, AO atomic hook utilities, table-driven Go tests.

## Global Constraints

- Support the current AGY v1.1.13 hook contract only; do not install the obsolete `.gemini/hooks.json` file.
- Keep all integration state workspace-local under `.agents/hooks.json`.
- Preserve all user-owned named hooks and unknown top-level fields.
- Never claim blocked/Needs You capability without a reliable AGY permission-wait event.
- Do not change shared SCM status derivation in this PR.
- Use test-first development and small conventional commits.

---

### Task 1: Modern activity vocabulary and capability declarations

**Files:**
- Modify: `backend/internal/adapters/agent/agy/activity.go`
- Modify: `backend/internal/adapters/agent/agy/activity_test.go`
- Modify: `backend/internal/adapters/agent/agy/agy.go`
- Test: `backend/internal/adapters/agent/agy/agy_test.go`

**Interfaces:**
- Consumes: `ports.SubmitActivitySignaler`, `ports.BlockedActivitySignaler`, and `domain.ActivityState`.
- Produces: `DeriveActivityState(event string, payload []byte) (domain.ActivityState, bool)`, `(*Plugin).EmitsSubmitActivity() bool`, and `(*Plugin).EmitsBlockedActivity() bool`.

- [ ] **Step 1: Replace the activity table expectations with modern normalized events**

Update `TestDeriveActivityState` to require:

```go
tests := []struct {
    name   string
    event  string
    want   domain.ActivityState
    wantOK bool
}{
    {"pre invocation -> active", "pre-invocation", domain.ActivityActive, true},
    {"post tool use -> active", "post-tool-use", domain.ActivityActive, true},
    {"stop -> idle", "stop", domain.ActivityIdle, true},
    {"legacy before agent ignored", "before-agent", "", false},
    {"legacy after agent ignored", "after-agent", "", false},
    {"unknown event -> no signal", "unknown", "", false},
}
```

Add `TestActivitySignalCapabilities` in `agy_test.go`:

```go
func TestActivitySignalCapabilities(t *testing.T) {
    p := &Plugin{}
    if !p.EmitsSubmitActivity() {
        t.Fatal("EmitsSubmitActivity = false, want true")
    }
    if p.EmitsBlockedActivity() {
        t.Fatal("EmitsBlockedActivity = true, want false")
    }
}
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
cd backend
GOCACHE=/private/tmp/ao-agy-modern-hooks-go-cache go test ./internal/adapters/agent/agy -run 'TestDeriveActivityState|TestActivitySignalCapabilities' -count=1
```

Expected: FAIL because legacy mappings remain and the capability methods do not exist.

- [ ] **Step 3: Implement the minimal modern mappings and capabilities**

Change `DeriveActivityState` to:

```go
func DeriveActivityState(event string, _ []byte) (domain.ActivityState, bool) {
    switch event {
    case "pre-invocation", "post-tool-use":
        return domain.ActivityActive, true
    case "stop":
        return domain.ActivityIdle, true
    default:
        return "", false
    }
}
```

Add interface assertions and methods in `agy.go`:

```go
var _ ports.SubmitActivitySignaler = (*Plugin)(nil)
var _ ports.BlockedActivitySignaler = (*Plugin)(nil)

func (p *Plugin) EmitsSubmitActivity() bool { return true }
func (p *Plugin) EmitsBlockedActivity() bool { return false }
```

Document that `PreInvocation` proves submitted work became active and that current AGY has no correlatable permission-wait signal.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add backend/internal/adapters/agent/agy/activity.go backend/internal/adapters/agent/agy/activity_test.go backend/internal/adapters/agent/agy/agy.go backend/internal/adapters/agent/agy/agy_test.go
git commit -m "fix(agy): map modern activity events"
```

---

### Task 2: Modern named-hook installation and preservation

**Files:**
- Rewrite: `backend/internal/adapters/agent/agy/hooks.go`
- Modify: `backend/internal/adapters/agent/agy/agy_test.go`

**Interfaces:**
- Consumes: `hookutil.AtomicWriteFile`, `hookutil.EnsureWorkspaceGitignore`, and `ports.WorkspaceHookConfig`.
- Produces: `agyHooksPath(workspacePath string) string`, `(*Plugin).GetAgentHooks`, `(*Plugin).UninstallHooks`, and `(*Plugin).AreHooksInstalled` using `.agents/hooks.json`.

- [ ] **Step 1: Rewrite lifecycle tests to specify the current AGY file contract**

Replace `TestHooksLifecycle` assertions so installation must create `.agents/hooks.json`, must not create `.gemini/hooks.json`, and must decode this AO-owned shape:

```go
type installedHooks map[string]json.RawMessage

var top installedHooks
if err := json.Unmarshal(data, &top); err != nil {
    t.Fatal(err)
}
aoRaw, ok := top[agyManagedHookName]
if !ok {
    t.Fatalf("missing named hook %q", agyManagedHookName)
}
var ao agyNamedHook
if err := json.Unmarshal(aoRaw, &ao); err != nil {
    t.Fatal(err)
}
```

Assert exact commands and shapes:

```go
if got := ao.PreInvocation[0].Command; got != "ao hooks agy pre-invocation" { ... }
if got := *ao.PostToolUse[0].Matcher; got != "*" { ... }
if got := ao.PostToolUse[0].Hooks[0].Command; got != "ao hooks agy post-tool-use" { ... }
if got := ao.Stop[0].Command; got != "ao hooks agy stop" { ... }
```

Call installation twice and assert the decoded AO entry is unchanged.

- [ ] **Step 2: Add preservation, uninstall, and malformed-file tests**

Add `TestHooksPreserveUserNamedHooks` that seeds:

```json
{
  "user-linter": {
    "enabled": false,
    "PostToolUse": [{"matcher":"run_command","hooks":[{"command":"./lint.sh"}]}]
  },
  "future-field": {"value": 7}
}
```

After install and uninstall, compare `json.RawMessage` values for `user-linter` and `future-field` to their normalized pre-install JSON and confirm only `agent-orchestrator` was added then removed.

Add `TestHooksRejectMalformedJSON` that writes `{not-json` at `.agents/hooks.json`, calls `GetAgentHooks`, expects a non-nil error containing `parse`, and confirms the original bytes remain unchanged.

- [ ] **Step 3: Run the hook tests and verify RED**

Run:

```bash
cd backend
GOCACHE=/private/tmp/ao-agy-modern-hooks-go-cache go test ./internal/adapters/agent/agy -run 'TestHooks' -count=1
```

Expected: FAIL because the adapter still writes `.gemini/hooks.json` with the obsolete event map.

- [ ] **Step 4: Implement the current named-hook data model**

Replace the legacy types with:

```go
const (
    agyHooksDirName = ".agents"
    agyHooksFileName = "hooks.json"
    agyManagedHookName = "agent-orchestrator"
    agyHookCommandPrefix = "ao hooks agy "
    agyHookTimeout = 30
)

type agyHookEntry struct {
    Type    string `json:"type,omitempty"`
    Command string `json:"command"`
    Timeout int    `json:"timeout,omitempty"`
}

type agyMatcherGroup struct {
    Matcher *string        `json:"matcher,omitempty"`
    Hooks   []agyHookEntry `json:"hooks"`
}

type agyNamedHook struct {
    PreInvocation []agyHookEntry    `json:"PreInvocation"`
    PostToolUse   []agyMatcherGroup `json:"PostToolUse"`
    Stop          []agyHookEntry    `json:"Stop"`
}
```

Construct one deterministic managed value with timeout 30 on every command and matcher `*` on `PostToolUse`.

- [ ] **Step 5: Implement read, install, uninstall, and installed checks**

Use `map[string]json.RawMessage` for the top-level document. `readAgyHooks` must treat missing/blank files as an empty map and return `parse <path>` errors for malformed JSON.

`GetAgentHooks` must marshal the managed value, assign only `topLevel[agyManagedHookName]`, atomically write indented JSON plus newline, and ignore `.agents/hooks.json` through `EnsureWorkspaceGitignore`.

`UninstallHooks` must delete only `agyManagedHookName` and rewrite the remaining object.

`AreHooksInstalled` must return true only when `agyManagedHookName` exists and decodes to the exact managed commands; a user-created entry with the same name but different commands must return false rather than being treated as AO-owned.

- [ ] **Step 6: Run the hook tests and verify GREEN**

Run the Step 3 command. Expected: PASS.

- [ ] **Step 7: Run the entire AGY adapter suite**

```bash
cd backend
GOCACHE=/private/tmp/ao-agy-modern-hooks-go-cache go test ./internal/adapters/agent/agy/... -count=1
```

Expected: PASS.

- [ ] **Step 8: Commit Task 2**

```bash
git add backend/internal/adapters/agent/agy/hooks.go backend/internal/adapters/agent/agy/agy_test.go
git commit -m "fix(agy): install modern workspace hooks"
```

---

### Task 3: Integration verification and pull request

**Files:**
- Verify: `docs/superpowers/specs/2026-08-18-agy-modern-hooks-design.md`
- Verify: `docs/superpowers/plans/2026-08-18-agy-modern-hooks.md`

**Interfaces:**
- Consumes: activity dispatch registration for harness `agy`, session-manager capability gates, and repository CI commands.
- Produces: a pushed `codex/fix-agy-modern-hooks` branch and a focused GitHub pull request against `main`.

- [ ] **Step 1: Verify dispatch and session-manager integration**

Run:

```bash
cd backend
GOCACHE=/private/tmp/ao-agy-modern-hooks-go-cache go test ./internal/adapters/agent/activitydispatch/... ./internal/session_manager/... -count=1
```

Expected: PASS. If a session-manager test still describes AGY as not emitting submit activity, update only that stale fixture/comment to reflect submit=true and blocked=false, then rerun.

- [ ] **Step 2: Run repository-level backend checks**

```bash
cd backend
GOCACHE=/private/tmp/ao-agy-modern-hooks-go-cache go test ./...
GOCACHE=/private/tmp/ao-agy-modern-hooks-go-cache go vet ./...
```

Expected: both commands exit 0. Tests requiring loopback listeners may need the approved unsandboxed `go test` execution.

- [ ] **Step 3: Inspect the final diff**

```bash
git diff --check untrivial/main...HEAD
git status --short
git log --oneline untrivial/main..HEAD
```

Expected: no whitespace errors, only the design/plan and focused AGY integration files changed, and the worktree is clean after commits.

- [ ] **Step 4: Request code review**

Provide a reviewer with:

```text
Description: Migrates AGY activity hooks to the v1.1.13 .agents/hooks.json named-hook contract.
Requirements: Preserve user hooks, emit Active from PreInvocation/PostToolUse, emit Idle from Stop, never claim blocked capability, do not write .gemini/hooks.json.
Base: untrivial/main
Head: HEAD
```

Resolve all Critical and Important findings before continuing.

- [ ] **Step 5: Push the branch and create the PR**

```bash
git push -u untrivial codex/fix-agy-modern-hooks
gh pr create --repo Untrivial-ai/agent-orchestrator --base main --head codex/fix-agy-modern-hooks --title "fix(agy): restore Kanban activity tracking" --body-file /private/tmp/agy-modern-hooks-pr.md
```

The PR body must summarize the hook contract migration, the supported Kanban transitions, the explicit Needs You limitation, and exact verification commands.
