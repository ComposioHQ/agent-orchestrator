# Cursor Chat and Terminal Interface Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Desktop AO Cursor workers to switch between structured Chat and the native Cursor terminal UI while preserving one provider-native conversation ID and replaying native history before Chat activation.

**Architecture:** Add Cursor to the existing `ports.AgentInterfaceHandoff` adapter capability; the generic session-manager transition coordinator remains the only controller-switch state machine. Cursor returns its current hook-captured TUI ID or persisted ACP ID, Chat-to-TUI resumes with `cursor-agent --resume`, and TUI-to-Chat resumes through ACP `session/load` with the existing required-history barrier.

**Tech Stack:** Go, AO adapter ports, Cursor Agent CLI 2026.08.11+, ACP v1, Go `testing`, existing session-manager fakes.

**Spec:** `docs/superpowers/specs/2026-08-25-cursor-interface-handoff-design.md`

## Global Constraints

- Desktop first; do not add Mobile or Cloud UI work.
- Reuse the existing interface-transition API, durable transition state machine, drain/interrupt policies, generation fencing, and rollback.
- Do not add a Cursor-specific endpoint, migration, or renderer component.
- Never derive or fabricate a Cursor ID and never fall back to a summary-started conversation.
- TUI identity comes only from `MetadataKeyAgentSessionID`; Chat identity comes only from `ProviderConversationID`.
- TUI-to-Chat activation requires ACP `session/load` replay through `ChatHistoryReader`; `session/resume` alone is insufficient.
- Do not parse PTY output into structured Chat history.

## File Structure

- `backend/internal/adapters/agent/cursor/cursor.go` — maps the current Cursor interface to one native conversation ID.
- `backend/internal/adapters/agent/cursor/cursor_test.go` — tests strict ID selection, refusal, cancellation, and interface conformance.
- `backend/internal/session_manager/interface_transition_test.go` — tests the real Cursor adapter through the generic status/generation-fence path.
- `backend/internal/adapters/chatdriver/cursoracp/live_test.go` — opt-in native CLI → ACP → native CLI continuity conformance.
- `docs/STATUS.md` — records Cursor's shipped handoff capability and replay boundary.

---

### Task 1: Declare Cursor's native interface identity

**Files:**
- Modify: `backend/internal/adapters/agent/cursor/cursor_test.go`
- Modify: `backend/internal/adapters/agent/cursor/cursor.go`

**Interfaces:**
- Consumes: `ports.AgentInterfaceHandoff.NativeConversationID(context.Context, ports.SessionRef, domain.SessionMode, string) (string, bool, error)`.
- Produces: `(*cursor.Plugin).NativeConversationID` and compile-time interface conformance.

- [ ] **Step 1: Write the failing identity tests**

Add the domain import and these tests near the restore tests:

```go
func TestNativeConversationIDUsesCursorIdentityFromCurrentInterface(t *testing.T) {
	plugin := &Plugin{}
	tuiID, ok, err := plugin.NativeConversationID(context.Background(), ports.SessionRef{
		ID: "ao-session-1",
		Metadata: map[string]string{ports.MetadataKeyAgentSessionID: "cursor-native-1"},
	}, domain.SessionModeTUI, "stale-chat-id")
	if err != nil || !ok || tuiID != "cursor-native-1" {
		t.Fatalf("TUI native id = %q ok=%v err=%v", tuiID, ok, err)
	}
	chatID, ok, err := plugin.NativeConversationID(context.Background(), ports.SessionRef{
		Metadata: map[string]string{ports.MetadataKeyAgentSessionID: "stale-tui-id"},
	}, domain.SessionModeChat, "cursor-native-1")
	if err != nil || !ok || chatID != "cursor-native-1" {
		t.Fatalf("Chat native id = %q ok=%v err=%v", chatID, ok, err)
	}
}

func TestNativeConversationIDRefusesMissingCursorIdentity(t *testing.T) {
	plugin := &Plugin{}
	for _, test := range []struct {
		name string
		mode domain.SessionMode
		providerID string
		metadata map[string]string
	}{
		{name: "TUI does not derive AO id", mode: domain.SessionModeTUI, metadata: map[string]string{}},
		{name: "blank TUI id", mode: domain.SessionModeTUI, metadata: map[string]string{ports.MetadataKeyAgentSessionID: "  "}},
		{name: "blank Chat id", mode: domain.SessionModeChat, providerID: "  ", metadata: map[string]string{ports.MetadataKeyAgentSessionID: "stale"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			id, ok, err := plugin.NativeConversationID(context.Background(), ports.SessionRef{
				ID: "ao-session-1", Metadata: test.metadata,
			}, test.mode, test.providerID)
			if err != nil || ok || id != "" {
				t.Fatalf("native id = %q ok=%v err=%v", id, ok, err)
			}
		})
	}
}
```

Extend `TestContextCancellationPerMethod` with a cancelled `NativeConversationID` call and require a context error.

- [ ] **Step 2: Run the tests to verify red**

Run: `cd backend && go test ./internal/adapters/agent/cursor -run 'TestNativeConversationID|TestContextCancellationPerMethod' -count=1`

Expected: build failure because `Plugin.NativeConversationID` is undefined.

- [ ] **Step 3: Implement the minimal mapping**

Import `backend/internal/domain`, add `var _ ports.AgentInterfaceHandoff = (*Plugin)(nil)`, and add:

```go
func (p *Plugin) NativeConversationID(
	ctx context.Context,
	session ports.SessionRef,
	currentMode domain.SessionMode,
	providerConversationID string,
) (string, bool, error) {
	if err := ctx.Err(); err != nil {
		return "", false, err
	}
	if currentMode == domain.SessionModeChat {
		id := strings.TrimSpace(providerConversationID)
		return id, id != "", nil
	}
	id := strings.TrimSpace(session.Metadata[ports.MetadataKeyAgentSessionID])
	return id, id != "", nil
}
```

Do not implement `AgentInterfaceHandoffHistoryProbe`; Cursor has no documented stable local transcript path for a safe read-only existence check.

- [ ] **Step 4: Verify green**

Run: `cd backend && go test ./internal/adapters/agent/cursor -count=1`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/adapters/agent/cursor/cursor.go backend/internal/adapters/agent/cursor/cursor_test.go
git commit -m "feat: enable Cursor interface identity handoff"
```

### Task 2: Prove generic transition admission for Cursor

**Files:**
- Modify: `backend/internal/session_manager/interface_transition_test.go`

**Interfaces:**
- Consumes: Task 1's `AgentInterfaceHandoff` and the existing `Manager.InterfaceTransitionStatus` launch-generation fence.
- Produces: coverage that drives Desktop's existing capability-based switch control with no renderer-specific code.

- [ ] **Step 1: Add real-adapter status tests**

Import `cursoragent "github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/cursor"` and add:

```go
func TestInterfaceTransitionStatusOffersCursorWithCurrentLaunchIdentity(t *testing.T) {
	manager, store, _, _, _ := newTransitionManager(t, domain.SessionModeTUI)
	manager.agents = singleAgent{agent: cursoragent.New()}
	rec := store.sessions["session-1"]
	rec.Harness = domain.HarnessCursor
	rec.Metadata.AgentSessionID = "cursor-native-1"
	rec.Metadata.AgentSessionIDLaunchID = rec.Metadata.RuntimeLaunchID
	store.sessions["session-1"] = rec
	status, err := manager.InterfaceTransitionStatus(context.Background(), rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !status.Supported || status.TargetMode != domain.SessionModeChat {
		t.Fatalf("Cursor interface status = %+v", status)
	}
}

func TestInterfaceTransitionStatusRejectsCursorIdentityFromOldLaunch(t *testing.T) {
	manager, store, _, _, _ := newTransitionManager(t, domain.SessionModeTUI)
	manager.agents = singleAgent{agent: cursoragent.New()}
	rec := store.sessions["session-1"]
	rec.Harness = domain.HarnessCursor
	rec.Metadata.AgentSessionID = "cursor-native-1"
	rec.Metadata.AgentSessionIDLaunchID = "older-launch"
	store.sessions["session-1"] = rec
	status, err := manager.InterfaceTransitionStatus(context.Background(), rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if status.Supported || status.ReasonCode != "NATIVE_SESSION_UNVERIFIED" {
		t.Fatalf("Cursor stale identity status = %+v", status)
	}
}
```

- [ ] **Step 2: Run focused and full transition tests**

Run:

```bash
(cd backend && go test ./internal/session_manager -run 'TestInterfaceTransitionStatus.*Cursor' -count=1)
(cd backend && go test ./internal/session_manager -run InterfaceTransition -count=1)
```

Expected: PASS. The real Cursor adapter is supported only with a current-generation native ID; existing same-ID resume, required-history, rollback, cancellation, and restart tests stay green.

- [ ] **Step 3: Commit**

```bash
git add backend/internal/session_manager/interface_transition_test.go
git commit -m "test: cover Cursor interface handoff admission"
```

### Task 3: Add opt-in native CLI ↔ ACP continuity conformance

**Files:**
- Modify: `backend/internal/adapters/chatdriver/cursoracp/live_test.go`

**Interfaces:**
- Consumes: native `cursor-agent create-chat`, `cursor-agent --print --resume <id>`, `ChatDriver.Resume`, and `ChatHistoryReader.ReadHistory`.
- Produces: `TestLiveCursorCrossInterfaceContinuity`, gated by `AO_LIVE_CURSOR_ACP=1`.

- [ ] **Step 1: Add deterministic CLI and replay helpers**

Import `os/exec`, then add:

```go
func runLiveCursorCLI(ctx context.Context, t *testing.T, binary, dataDir, workspace string, args ...string) string {
	t.Helper()
	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.Dir = workspace
	cmd.Env = append(os.Environ(), "CURSOR_DATA_DIR="+filepath.Join(dataDir, "cursor"))
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("cursor-agent %v: %v\n%s", args, err, output)
	}
	return strings.TrimSpace(string(output))
}

func historyContains(events []ports.ChatEvent, marker string) bool {
	for _, event := range events {
		if (event.Kind == ports.ChatEventUserMessageCompleted || event.Kind == ports.ChatEventMessageCompleted) &&
			strings.Contains(event.Text, marker) {
			return true
		}
	}
	return false
}
```

- [ ] **Step 2: Add the gated bidirectional test**

The test must:

1. Skip unless `AO_LIVE_CURSOR_ACP=1`.
2. Resolve the installed Cursor binary and use `liveDataDir(t)` plus one temporary workspace.
3. Run `cursor-agent create-chat` and validate the returned ID is one non-empty token.
4. Run `cursor-agent --force --print --resume <id> <prompt>` with a unique `CURSOR_NATIVE_TO_ACP_*` marker.
5. Call `New(plugin, nil).Resume` with that exact ID and require `conv.(ports.ChatHistoryReader).ReadHistory(ctx)` to contain the native marker.
6. Send an ACP turn containing a unique `CURSOR_ACP_TO_NATIVE_*` marker and require a completed answer containing it.
7. Exercise Cursor's provider interrupt before the handoff boundary: send a turn that runs `sleep 30`, resolve its approval, interrupt it with the existing helper, and require `TurnStateInterrupted`.
8. Close ACP, run native `--print --resume <same-id>` asking for the most recent completed marker, and require the native answer to contain the ACP marker rather than presenting the interrupted turn as complete.

Use a six-minute context and existing `sendLiveTurn`/`waitForLiveTurn` helpers. Print mode is deterministic automation of the same native `--resume` path used by interactive TUI; never delete the provider conversation.

- [ ] **Step 3: Verify the opt-in guard**

Run: `cd backend && go test ./internal/adapters/chatdriver/cursoracp -run TestLiveCursorCrossInterfaceContinuity -count=1 -v`

Expected without the gate: PASS with an explicit skip mentioning `AO_LIVE_CURSOR_ACP=1`.

- [ ] **Step 4: Run live conformance only with authorization to consume Cursor turns**

Run: `cd backend && AO_LIVE_CURSOR_ACP=1 go test ./internal/adapters/chatdriver/cursoracp -run TestLiveCursorCrossInterfaceContinuity -count=1 -v -timeout 8m`

Expected: PASS; ACP replay contains the native marker and native resume contains the ACP marker.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/adapters/chatdriver/cursoracp/live_test.go
git commit -m "test: prove Cursor cross-interface continuity"
```

### Task 4: Update status and run final verification

**Files:**
- Modify: `docs/STATUS.md`

**Interfaces:**
- Consumes: completed capability and conformance coverage.
- Produces: accurate shipped documentation and final verification evidence.

- [ ] **Step 1: Update status wording**

Replace the sentence saying Cursor is Chat-only with:

```text
Cursor supports the same capability-gated TUI↔Chat handoff as Claude Code and Codex. AO carries Cursor's hook-captured native chat id across controllers and requires ACP `session/load` replay before activating Chat.
```

Keep the documented settled-boundary limitation and the prohibition on reconstructing PTY scrollback or migrating in-flight tools.

- [ ] **Step 2: Format and run focused packages**

Run:

```bash
gofmt -w backend/internal/adapters/agent/cursor/cursor.go backend/internal/adapters/agent/cursor/cursor_test.go backend/internal/adapters/chatdriver/cursoracp/live_test.go backend/internal/session_manager/interface_transition_test.go
cd backend && go test ./internal/adapters/agent/cursor ./internal/adapters/chatdriver/cursoracp ./internal/session_manager -count=1
```

Expected: PASS.

- [ ] **Step 3: Run repository backend verification**

Run: `cd backend && go build ./... && go test ./...`

Expected: PASS.

- [ ] **Step 4: Run diff hygiene checks**

Run:

```bash
git diff --check
git status --short
git diff --stat untrivial/main...HEAD
```

Expected: no whitespace errors and only the design, plan, Cursor adapter/tests, interface-transition test, and status documentation changed.

- [ ] **Step 5: Commit documentation**

```bash
git add docs/STATUS.md docs/superpowers/plans/2026-08-25-cursor-interface-handoff.md
git commit -m "docs: mark Cursor interface handoff supported"
```

- [ ] **Step 6: Re-run the final changed-scope gate**

Run:

```bash
cd backend && go test ./internal/adapters/agent/cursor ./internal/adapters/chatdriver/cursoracp ./internal/session_manager -count=1
git diff --check
```

Expected: PASS with a clean worktree.
