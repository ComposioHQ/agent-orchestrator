# Prime Agent Functionalities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Prime Agent full AO parity for role system prompts, automatic model discovery, persistent native sessions, safe termination, and native restore.

**Architecture:** Keep Session Manager as the source of worker/orchestrator prompts and role model overrides. The Prime adapter stores transcripts under `AO_DATA_DIR`, captures the native transcript ID through its managed extension, resumes with Prime's public `--resume` option, and implements a narrow optional native-session terminator so AO can stop a resident Prime worker before removing its worktree. The existing model-catalog command runner discovers Prime's provider-qualified models.

**Tech Stack:** Go 1.x backend and tests, embedded TypeScript Prime extension, Prime Agent 0.7.1 public CLI, existing AO hook and model-catalog infrastructure.

## Global Constraints

- Deliver the complete integration in one branch and pull request.
- Do not change AO's project configuration, session metadata schema, HTTP API, or generated frontend API types.
- Store AO-managed Prime transcripts under `<AO_DATA_DIR>/agent-runtime/prime-agent/sessions`.
- Append AO role instructions with `--append-system-prompt`; do not replace Prime's built-in prompt.
- Never invoke `prime-agent shutdown` or stop an unmatched Prime session.
- Use the existing saved-prompt/fresh-launch fallback when no native Prime session ID was captured.
- Keep the CLI and frontend as thin clients; all lifecycle decisions remain in Session Manager and agent ports.

---

## File Map

- `backend/internal/adapters/agent/modelcatalog/catalog.go` — register Prime's documented model-list command and reuse the provider-table parser.
- `backend/internal/adapters/agent/modelcatalog/catalog_test.go` — protect the Prime command and normalized model IDs.
- `backend/internal/adapters/agent/primeagent/primeagent.go` — construct persistent launch and native restore commands with shared prompt/model arguments.
- `backend/internal/adapters/agent/primeagent/primeagent_test.go` — protect launch, restore, session-directory, prompt, model, fallback, and cancellation behavior.
- `backend/internal/adapters/agent/primeagent/hooks.go` — derive the stable AO-owned transcript directory beside the managed extension.
- `backend/internal/adapters/agent/primeagent/assets/ao-activity.ts` — report Prime's native session ID on every session-start event.
- `backend/internal/adapters/agent/primeagent/hooks_test.go` — execute the real embedded extension and assert its hook payload.
- `backend/internal/adapters/agent/primeagent/lifecycle.go` — list live Prime sessions, resolve the exact transcript match, and stop only its active worker.
- `backend/internal/adapters/agent/primeagent/lifecycle_test.go` — cover exact match, inactive transcript, malformed/ambiguous responses, command failure, and cancellation.
- `backend/internal/ports/agent.go` — define the optional native-session termination capability.
- `backend/internal/session_manager/manager.go` — invoke the optional capability before destructive Prime teardown paths.
- `backend/internal/session_manager/manager_test.go` — protect teardown ordering, no-op compatibility, and failure safety.

---

### Task 1: Prime Model Discovery

**Files:**
- Modify: `backend/internal/adapters/agent/modelcatalog/catalog_test.go`
- Modify: `backend/internal/adapters/agent/modelcatalog/catalog.go:44-58`

**Interfaces:**
- Consumes: existing `commandSpec`, `parsePiModels`, and `Base(agentID string)`.
- Produces: `commandSpecs["prime-agent"]` with args `[]string{"model", "list"}` and provider-qualified `AgentModelInfo` results.

- [ ] **Step 1: Write failing discovery tests**

Add Prime to `TestBaseClassifiesStaticTextAndModeAgents`, then add:

```go
func TestPrimeAgentDiscoveryUsesDocumentedModelCommand(t *testing.T) {
	spec := commandSpecs["prime-agent"]
	want := []string{"model", "list"}
	if strings.Join(spec.args, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("prime-agent discovery args = %q, want %q", spec.args, want)
	}
	if spec.parser == nil {
		t.Fatal("prime-agent parser is nil")
	}
}

func TestParsePrimeAgentModelsBuildsProviderQualifiedIDs(t *testing.T) {
	got, err := parsePiModels([]byte(`provider   model                 context  max-out  thinking  images
anthropic  claude-opus-4-8       200K     64K      yes       yes
openai     gpt-5.6-sol           400K     128K     yes       yes
`))
	if err != nil {
		t.Fatal(err)
	}
	want := []ports.AgentModelInfo{
		{ID: "anthropic/claude-opus-4-8", Label: "claude-opus-4-8", Provider: "anthropic"},
		{ID: "openai/gpt-5.6-sol", Label: "gpt-5.6-sol", Provider: "openai"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("models = %#v, want %#v", got, want)
	}
}
```

- [ ] **Step 2: Run the focused tests and observe RED**

Run:

```bash
cd backend
GOCACHE=/private/tmp/go-build-prime-agent go test ./internal/adapters/agent/modelcatalog -run 'TestPrimeAgent|TestBaseClassifies' -count=1
```

Expected: failure because `commandSpecs["prime-agent"]` is absent and `Base("prime-agent")` still selects free text.

- [ ] **Step 3: Register the Prime command**

Add this entry to `commandSpecs`:

```go
"prime-agent": {args: []string{"model", "list"}, parser: parsePiModels},
```

- [ ] **Step 4: Run the model-catalog package tests and observe GREEN**

```bash
cd backend
GOCACHE=/private/tmp/go-build-prime-agent go test ./internal/adapters/agent/modelcatalog -count=1
```

Expected: PASS.

- [ ] **Step 5: Commit the model discovery slice**

```bash
git add backend/internal/adapters/agent/modelcatalog/catalog.go backend/internal/adapters/agent/modelcatalog/catalog_test.go
git commit -m "feat: discover Prime Agent models"
```

---

### Task 2: Persistent Launch, Role Prompt, and Native Restore Commands

**Files:**
- Modify: `backend/internal/adapters/agent/primeagent/hooks.go`
- Modify: `backend/internal/adapters/agent/primeagent/primeagent_test.go`
- Modify: `backend/internal/adapters/agent/primeagent/primeagent.go`

**Interfaces:**
- Consumes: `ports.LaunchConfig`, `ports.RestoreConfig`, `ports.MetadataKeyAgentSessionID`, and existing `resolveSystemPrompt` behavior.
- Produces: `sessionDir(dataDir string) (string, error)`, persistent launch argv, and `GetRestoreCommand` returning Prime's native `--resume` argv.

- [ ] **Step 1: Replace ephemeral launch expectations with persistent-session expectations**

Change `TestGetLaunchCommandOrdersFlagsAndProtectsPrompt` so its literal expected argv is:

```go
want := []string{
	"/bin/prime-agent",
	"--session-dir", filepath.Join(dataDir, "agent-runtime", "prime-agent", "sessions"),
	"--extension", filepath.Join(dataDir, "agent-runtime", "prime-agent", "ao-activity.ts"),
	"--append-system-prompt", "follow repository rules",
	"--model", "prime/model",
	"--", "--delete-nothing",
}
```

Update the blank-optional-arguments test to expect the required session-directory and extension pairs, with no `--no-session` argument.

- [ ] **Step 2: Add failing native restore tests**

Replace `TestGetRestoreCommandUnavailable` with table-driven coverage containing these concrete cases:

```go
func TestGetRestoreCommandUsesNativeSessionAndRoleConfig(t *testing.T) {
	dataDir := t.TempDir()
	p := &Plugin{resolvedBinary: "/bin/prime-agent"}
	cmd, ok, err := p.GetRestoreCommand(context.Background(), ports.RestoreConfig{
		DataDir:      dataDir,
		SystemPrompt: "coordinate workers only",
		Config:       ports.AgentConfig{Model: " anthropic/claude-opus-4-8 "},
		Session: ports.SessionRef{
			WorkspacePath: "/work/session",
			Metadata: map[string]string{
				ports.MetadataKeyAgentSessionID: " prime-session-123 ",
			},
		},
	})
	if err != nil || !ok {
		t.Fatalf("GetRestoreCommand ok=%v err=%v", ok, err)
	}
	want := []string{
		"/bin/prime-agent",
		"--session-dir", filepath.Join(dataDir, "agent-runtime", "prime-agent", "sessions"),
		"--extension", filepath.Join(dataDir, "agent-runtime", "prime-agent", "ao-activity.ts"),
		"--append-system-prompt", "coordinate workers only",
		"--model", "anthropic/claude-opus-4-8",
		"--resume", "prime-session-123",
	}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("command\n got: %#v\nwant: %#v", cmd, want)
	}
}
```

Also add:

- `TestGetRestoreCommandReadsSystemPromptFile` with a real temporary prompt file and literal appended text.
- `TestGetRestoreCommandUnavailableWithoutNativeSessionID` covering nil metadata, missing key, and whitespace value; each must return `(nil, false, nil)`.
- A restore cancellation assertion beside the existing launch/config cancellation checks.

- [ ] **Step 3: Run Prime adapter command tests and observe RED**

```bash
cd backend
GOCACHE=/private/tmp/go-build-prime-agent go test ./internal/adapters/agent/primeagent -run 'TestGet(Launch|Restore)Command' -count=1
```

Expected: failures showing `--no-session` remains and restore returns unavailable.

- [ ] **Step 4: Implement shared persistent command construction**

In `hooks.go`, add:

```go
const sessionDirName = "sessions"

func sessionDir(dataDir string) (string, error) {
	dataDir = strings.TrimSpace(dataDir)
	if dataDir == "" {
		return "", errors.New("prime-agent: DataDir is required for session storage")
	}
	return filepath.Join(dataDir, extensionDirName, adapterID, sessionDirName), nil
}
```

In `primeagent.go`, create an internal builder that resolves the binary, session directory, extension, system prompt, and model once:

```go
func (p *Plugin) baseCommand(ctx context.Context, dataDir, systemPrompt, systemPromptFile string, cfg ports.AgentConfig) ([]string, error) {
	binary, err := p.primeAgentBinary(ctx)
	if err != nil {
		return nil, err
	}
	sessions, err := sessionDir(dataDir)
	if err != nil {
		return nil, err
	}
	extension, err := extensionPath(dataDir)
	if err != nil {
		return nil, err
	}
	cmd := []string{binary, "--session-dir", sessions, "--extension", extension}
	prompt, err := resolveSystemPrompt(ctx, systemPrompt, systemPromptFile)
	if err != nil {
		return nil, err
	}
	if prompt != "" {
		cmd = append(cmd, "--append-system-prompt", prompt)
	}
	agentbase.AppendModelFlag(&cmd, cfg, "--model")
	return cmd, nil
}
```

Use it from launch, appending `--` plus the initial task only when non-empty. Implement restore as:

```go
func (p *Plugin) GetRestoreCommand(ctx context.Context, cfg ports.RestoreConfig) ([]string, bool, error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	id := strings.TrimSpace(cfg.Session.Metadata[ports.MetadataKeyAgentSessionID])
	if id == "" {
		return nil, false, nil
	}
	cmd, err := p.baseCommand(ctx, cfg.DataDir, cfg.SystemPrompt, cfg.SystemPromptFile, cfg.Config)
	if err != nil {
		return nil, false, err
	}
	return append(cmd, "--resume", id), true, nil
}
```

- [ ] **Step 5: Run the Prime adapter package tests and observe GREEN**

```bash
cd backend
GOCACHE=/private/tmp/go-build-prime-agent go test ./internal/adapters/agent/primeagent -count=1
```

Expected: PASS.

- [ ] **Step 6: Commit persistent launch and restore**

```bash
git add backend/internal/adapters/agent/primeagent/hooks.go backend/internal/adapters/agent/primeagent/primeagent.go backend/internal/adapters/agent/primeagent/primeagent_test.go
git commit -m "feat: restore Prime Agent sessions"
```

---

### Task 3: Capture Prime's Native Session ID

**Files:**
- Modify: `backend/internal/adapters/agent/primeagent/hooks_test.go`
- Modify: `backend/internal/adapters/agent/primeagent/assets/ao-activity.ts`

**Interfaces:**
- Consumes: Prime extension context `context.sessionManager.getSessionId()` and AO's existing `session_id` hook payload convention.
- Produces: every valid Prime `session_start` report includes `session_id` for `SessionMetadata.AgentSessionID` persistence.

- [ ] **Step 1: Extend the executable extension test with a real session-manager context**

Change the test harness to call lifecycle handlers with:

```js
const context = {
  cwd,
  sessionManager: { getSessionId() { return "prime-native-123"; } },
};
```

Pass that object to valid handler invocations. Extend each session-start payload assertion to decode:

```go
var payload struct {
	Reason    string `json:"reason"`
	SessionID string `json:"session_id"`
}
```

and require `payload.SessionID == "prime-native-123"`.

- [ ] **Step 2: Run the extension behavior test and observe RED**

```bash
cd backend
GOCACHE=/private/tmp/go-build-prime-agent go test ./internal/adapters/agent/primeagent -run TestManagedExtensionMapsPrimeLifecycleEventsAndIgnoresHookFailures -count=1
```

Expected: failure because the installed extension reports only `reason`.

- [ ] **Step 3: Report the native session ID**

Update the handler to:

```ts
prime.on("session_start", bestEffort((event, context) => {
  report("session-start", {
    reason: event.reason ?? "",
    session_id: context.sessionManager.getSessionId(),
  }, context.cwd);
}));
```

Keep malformed/undefined lifecycle invocations contained by `bestEffort`.

- [ ] **Step 4: Run all Prime hook and CLI-hook tests and observe GREEN**

```bash
cd backend
GOCACHE=/private/tmp/go-build-prime-agent go test ./internal/adapters/agent/primeagent ./internal/cli -run 'TestManagedExtension|TestHooks_RegisteredHarnessSessionStart' -count=1
```

Expected: PASS, proving both extension emission and existing registered-harness extraction.

- [ ] **Step 5: Commit native identity capture**

```bash
git add backend/internal/adapters/agent/primeagent/assets/ao-activity.ts backend/internal/adapters/agent/primeagent/hooks_test.go
git commit -m "feat: capture Prime Agent session ids"
```

---

### Task 4: Stop Only the Matching Prime Resident Session

**Files:**
- Modify: `backend/internal/ports/agent.go`
- Create: `backend/internal/adapters/agent/primeagent/lifecycle.go`
- Create: `backend/internal/adapters/agent/primeagent/lifecycle_test.go`
- Modify: `backend/internal/adapters/agent/primeagent/primeagent.go`

**Interfaces:**
- Produces in `ports`: `AgentNativeSessionTerminator` with `TerminateNativeSession(context.Context, SessionRef) error`.
- Produces in Prime adapter: exact transcript-to-active-session resolution through `prime-agent list --json`, followed by `prime-agent stop <activeSessionId> --json`.
- Consumes later: Session Manager uses only the optional interface and remains compatible with every existing adapter.

- [ ] **Step 1: Write failing Prime lifecycle tests around the external CLI boundary**

Define a package-private runner field on the test `Plugin` through the production function type planned below. Use a strict fake that accepts only these commands:

```go
listJSON := []byte(`{"sessions":[{"id":"active-7","sessionId":"native-7","activeSessionId":"active-7","cwd":"/work","lifecycle":"active","activity":"idle","isSessionActive":true,"isStreaming":false,"isCompacting":false,"attachedClients":0,"messageCount":2,"sessionActions":{"queuedCount":0,"steering":[],"followUps":[]}}]}`)
```

Use this strict runner shape so a wrong command fails through real adapter
behavior rather than a call-count assertion:

```go
func TestTerminateNativeSessionStopsTheActiveOwnerOfTheTranscript(t *testing.T) {
	var stopped string
	p := &Plugin{
		resolvedBinary: "prime-agent",
		runCommand: func(_ context.Context, binary, cwd string, args ...string) ([]byte, error) {
			if binary != "prime-agent" || cwd != "/work" {
				return nil, fmt.Errorf("binary=%q cwd=%q", binary, cwd)
			}
			switch strings.Join(args, " ") {
			case "list --json":
				return listJSON, nil
			case "stop active-7 --json":
				stopped = "active-7"
				return []byte(`{"stopped":true}`), nil
			default:
				return nil, fmt.Errorf("unexpected args: %q", args)
			}
		},
	}
	err := p.TerminateNativeSession(context.Background(), ports.SessionRef{
		WorkspacePath: "/work",
		Metadata: map[string]string{
			ports.MetadataKeyAgentSessionID: "native-7",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if stopped != "active-7" {
		t.Fatalf("stopped = %q, want active-7", stopped)
	}
}
```

Add a table-driven `TestTerminateNativeSessionSafety` whose literal rows are:

```go
tests := []struct {
	name       string
	nativeID   string
	listOutput string
	listErr    error
	stopErr    error
	wantStop   bool
	wantErr    string
}{
	{name: "inactive transcript", nativeID: "native-7", listOutput: `{"sessions":[]}`},
	{name: "row without active owner", nativeID: "native-7", listOutput: `{"sessions":[{"sessionId":"native-7"}]}`},
	{name: "ambiguous active owners", nativeID: "native-7", listOutput: `{"sessions":[{"sessionId":"native-7","activeSessionId":"a"},{"sessionId":"native-7","activeSessionId":"b"}]}`, wantErr: "multiple live Prime sessions"},
	{name: "malformed list", nativeID: "native-7", listOutput: `{`, wantErr: "decode session list"},
	{name: "list failure", nativeID: "native-7", listErr: errors.New("daemon unavailable"), wantErr: "list live sessions"},
	{name: "stop failure", nativeID: "native-7", listOutput: `{"sessions":[{"sessionId":"native-7","activeSessionId":"active-7"}]}`, stopErr: errors.New("refused"), wantStop: true, wantErr: "stop active session"},
	{name: "blank AO id", nativeID: "   ", listOutput: `not consulted`},
}
```

For every row, the runner accepts only `list --json` and, when `wantStop` is
true, `stop active-7 --json`. Assert the returned error contains `wantErr`, or
is nil when `wantErr` is empty. Add a separate canceled-context test that uses
a runner returning `errors.New("must not run")` and requires
`errors.Is(err, context.Canceled)`.

- [ ] **Step 2: Run the new lifecycle tests and observe RED**

```bash
cd backend
GOCACHE=/private/tmp/go-build-prime-agent go test ./internal/adapters/agent/primeagent -run 'TestTerminateNativeSession' -count=1
```

Expected: compile failure because the port, runner, and Prime implementation do not exist.

- [ ] **Step 3: Add the optional port**

In `ports/agent.go`, add:

```go
// AgentNativeSessionTerminator is an optional adapter capability used before
// AO destroys a terminal runtime or worktree whose agent may keep running in a
// detached native process. Implementations must affect only the supplied
// session and leave its transcript resumable.
type AgentNativeSessionTerminator interface {
	TerminateNativeSession(ctx context.Context, session SessionRef) error
}
```

- [ ] **Step 4: Implement the bounded Prime CLI runner and exact resolver**

In `primeagent.go`, add the compile-time assertion:

```go
var _ ports.AgentNativeSessionTerminator = (*Plugin)(nil)
```

In `lifecycle.go`, define:

```go
type primeCommandRunner func(ctx context.Context, binary, workingDir string, args ...string) ([]byte, error)

type primeListResponse struct {
	Sessions []primeSessionSummary `json:"sessions"`
}

type primeSessionSummary struct {
	SessionID       string `json:"sessionId"`
	ActiveSessionID string `json:"activeSessionId"`
}
```

Add `runCommand primeCommandRunner` to `Plugin`. Implement the production
boundary and resolver with this concrete structure:

```go
const maxPrimeCommandOutput = 4 << 10

func runPrimeCommand(ctx context.Context, binary, workingDir string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, binary, args...) //nolint:gosec // binary is adapter-resolved; args are adapter-owned
	if strings.TrimSpace(workingDir) != "" {
		cmd.Dir = workingDir
	}
	return cmd.CombinedOutput()
}

func (p *Plugin) executePrimeCommand(ctx context.Context, workingDir string, args ...string) ([]byte, error) {
	binary, err := p.primeAgentBinary(ctx)
	if err != nil {
		return nil, err
	}
	runner := p.runCommand
	if runner == nil {
		runner = runPrimeCommand
	}
	return runner(ctx, binary, workingDir, args...)
}

func activeSessionForTranscript(output []byte, nativeID string) (string, bool, error) {
	var response primeListResponse
	if err := json.Unmarshal(output, &response); err != nil {
		return "", false, fmt.Errorf("decode session list: %w", err)
	}
	var matches []string
	for _, session := range response.Sessions {
		if strings.TrimSpace(session.SessionID) == nativeID && strings.TrimSpace(session.ActiveSessionID) != "" {
			matches = append(matches, strings.TrimSpace(session.ActiveSessionID))
		}
	}
	if len(matches) == 0 {
		return "", false, nil
	}
	if len(matches) != 1 {
		return "", false, fmt.Errorf("multiple live Prime sessions match transcript %q", nativeID)
	}
	return matches[0], true, nil
}

func boundedPrimeOutput(output []byte) string {
	if len(output) > maxPrimeCommandOutput {
		output = output[:maxPrimeCommandOutput]
	}
	return strings.TrimSpace(string(output))
}

func (p *Plugin) TerminateNativeSession(ctx context.Context, session ports.SessionRef) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	nativeID := strings.TrimSpace(session.Metadata[ports.MetadataKeyAgentSessionID])
	if nativeID == "" {
		return nil
	}
	output, err := p.executePrimeCommand(ctx, session.WorkspacePath, "list", "--json")
	if err != nil {
		return fmt.Errorf("prime-agent: list live sessions: %w: %s", err, boundedPrimeOutput(output))
	}
	activeID, ok, err := activeSessionForTranscript(output, nativeID)
	if err != nil || !ok {
		return err
	}
	output, err = p.executePrimeCommand(ctx, session.WorkspacePath, "stop", activeID, "--json")
	if err != nil {
		return fmt.Errorf("prime-agent: stop active session %q: %w: %s", activeID, err, boundedPrimeOutput(output))
	}
	return nil
}
```

- [ ] **Step 5: Run Prime lifecycle and adapter tests and observe GREEN**

```bash
cd backend
GOCACHE=/private/tmp/go-build-prime-agent go test ./internal/adapters/agent/primeagent -count=1
```

Expected: PASS.

- [ ] **Step 6: Commit the native termination capability**

```bash
git add backend/internal/ports/agent.go backend/internal/adapters/agent/primeagent/primeagent.go backend/internal/adapters/agent/primeagent/lifecycle.go backend/internal/adapters/agent/primeagent/lifecycle_test.go
git commit -m "feat: stop Prime Agent resident sessions"
```

---

### Task 5: Enforce Native Termination Before Worktree Teardown

**Files:**
- Modify: `backend/internal/session_manager/manager_test.go`
- Modify: `backend/internal/session_manager/manager.go`

**Interfaces:**
- Consumes: `ports.AgentNativeSessionTerminator`, `domain.SessionRecord.Harness`, and stored `AgentSessionID`.
- Produces: `terminateNativeSession(ctx context.Context, rec domain.SessionRecord) error`, called before destructive runtime/worktree teardown.

- [ ] **Step 1: Add a strict terminating-agent test double**

Add:

```go
type nativeTerminatingAgent struct {
	fakeAgent
	wantID string
	err    error
	calls  int
}

func (a *nativeTerminatingAgent) TerminateNativeSession(_ context.Context, session ports.SessionRef) error {
	a.calls++
	if got := session.Metadata[ports.MetadataKeyAgentSessionID]; got != a.wantID {
		return fmt.Errorf("native id = %q, want %q", got, a.wantID)
	}
	return a.err
}
```

- [ ] **Step 2: Write failing Session Manager safety tests**

Start with the destructive-boundary regression:

```go
func TestKill_NativeTerminationFailurePreservesRuntimeAndWorkspace(t *testing.T) {
	m, st, rt, ws := newManager()
	agent := &nativeTerminatingAgent{wantID: "native-7", err: errors.New("prime stop failed")}
	m.agents = singleAgent{agent: agent}
	rec := mkLive("mer-1")
	rec.Metadata.AgentSessionID = "native-7"
	st.sessions[rec.ID] = rec

	freed, err := m.Kill(ctx, rec.ID)
	if err == nil || !strings.Contains(err.Error(), "prime stop failed") {
		t.Fatalf("freed=%v err=%v, want native termination error", freed, err)
	}
	if freed || rt.destroyed != 0 || ws.destroyed != 0 {
		t.Fatalf("freed=%v runtime=%d workspace=%d, want no destructive teardown", freed, rt.destroyed, ws.destroyed)
	}
	if st.sessions[rec.ID].IsTerminated {
		t.Fatal("session must remain active when native termination fails")
	}
}
```

Add a successful `TestKill_TerminatesNativeSessionBeforeRuntime` with the same
record and a nil terminator error; require `agent.calls == 1`, runtime/workspace
destruction once, and a terminated row. Add
`TestKill_AgentWithoutNativeTerminatorIsUnchanged` using the existing
`fakeAgents{}` and requiring the same successful Kill outcome.

For shutdown and replacement, use the failure as the ordering oracle:

```go
func TestSaveAndTeardownOne_NativeTerminationFailurePreservesWorkspace(t *testing.T) {
	m, st, rt, ws := newLifecycleManager()
	agent := &nativeTerminatingAgent{wantID: "native-7", err: errors.New("prime stop failed")}
	m.agents = singleAgent{agent: agent}
	rec := domain.SessionRecord{
		ID: "mer-1", ProjectID: "mer", Kind: domain.KindWorker,
		Metadata: domain.SessionMetadata{
			WorkspacePath: "/ws/mer-1", Branch: "ao/mer-1/root",
			RuntimeHandleID: "h1", AgentSessionID: "native-7",
		},
		Activity: domain.Activity{State: domain.ActivityActive},
	}
	st.sessions[rec.ID] = rec
	err := m.saveAndTeardownOne(ctx, rec, true)
	if err == nil || !strings.Contains(err.Error(), "prime stop failed") {
		t.Fatalf("err=%v, want native termination error", err)
	}
	if rt.destroyed != 0 || st.sessions[rec.ID].IsTerminated {
		t.Fatalf("runtime=%d terminated=%v", rt.destroyed, st.sessions[rec.ID].IsTerminated)
	}
	for _, call := range ws.calls {
		if strings.HasPrefix(call, "ForceDestroy:") {
			t.Fatalf("worktree must remain after native termination failure: calls=%v", ws.calls)
		}
	}
}
```

Add the equivalent `TestRetireForReplacement_NativeTerminationFailurePreservesRuntimeAndWorkspace`. Seed a normal workspace record, make stash succeed, and require no runtime destruction, no force-destroy, and no termination. Duplicate these two failure tests with a workspace project containing root and child repository rows; require all repo inventory to remain and every force-destroy count to stay zero.

- [ ] **Step 3: Run focused lifecycle tests and observe RED**

```bash
cd backend
GOCACHE=/private/tmp/go-build-prime-agent go test ./internal/session_manager -run 'Test(Kill|SaveAndTeardownOne|RetireForReplacement).*NativeTermin' -count=1
```

Expected: failures because Session Manager never asks the optional adapter capability to stop its resident session.

- [ ] **Step 4: Implement the Session Manager helper**

Add:

```go
func (m *Manager) terminateNativeSession(ctx context.Context, rec domain.SessionRecord) error {
	if strings.TrimSpace(rec.Metadata.AgentSessionID) == "" {
		return nil
	}
	agent, ok := m.agents.Agent(rec.Harness)
	if !ok {
		return fmt.Errorf("%w: %s", ErrUnknownHarness, rec.Harness)
	}
	terminator, ok := agent.(ports.AgentNativeSessionTerminator)
	if !ok {
		return nil
	}
	return terminator.TerminateNativeSession(ctx, ports.SessionRef{
		ID:            string(rec.ID),
		WorkspacePath: rec.Metadata.WorkspacePath,
		Metadata: map[string]string{
			ports.MetadataKeyAgentSessionID: rec.Metadata.AgentSessionID,
		},
	})
}
```

- [ ] **Step 5: Call the helper at every approved destructive boundary**

Insert it before runtime destruction and before worktree removal in:

- `Kill`, after preview/browser cleanup and before the TUI runtime is destroyed.
- `RetireForReplacement`'s no-workspace branch, after state lookup and before runtime destruction.
- Single-repo replacement, after `StashUncommitted` and before runtime destruction.
- `retireWorkspaceProjectForReplacement`, after all repositories are stashed and before runtime destruction.
- `saveAndTeardownOne`, after the restore marker and reviewer terminal are preserved but before `MarkTerminated`.
- `saveAndTeardownWorkspaceProject`, after every restore marker and reviewer terminal are preserved but before `MarkTerminated`.

Wrap failures with the operation and session ID, for example:

```go
if err := m.terminateNativeSession(ctx, rec); err != nil {
	return fmt.Errorf("kill %s: native session: %w", rec.ID, err)
}
```

- [ ] **Step 6: Run Session Manager tests and observe GREEN**

```bash
cd backend
GOCACHE=/private/tmp/go-build-prime-agent go test ./internal/session_manager -count=1
```

Expected: PASS, including all pre-existing teardown and restore behavior.

- [ ] **Step 7: Commit lifecycle integration**

```bash
git add backend/internal/session_manager/manager.go backend/internal/session_manager/manager_test.go
git commit -m "feat: terminate native agents before teardown"
```

---

### Task 6: Cross-Boundary Verification and PR Readiness

**Files:**
- Verify only; modify production or tests only if a failing check exposes a defect in the approved behavior.

**Interfaces:**
- Consumes: all behavior produced by Tasks 1-5.
- Produces: a clean branch whose focused and repository checks demonstrate model selection, prompt forwarding, native ID capture, termination safety, and restore.

- [ ] **Step 1: Run focused Prime and lifecycle tests**

```bash
cd backend
GOCACHE=/private/tmp/go-build-prime-agent go test ./internal/adapters/agent/primeagent ./internal/adapters/agent/modelcatalog ./internal/session_manager ./internal/cli -count=1
```

Expected: PASS.

- [ ] **Step 2: Run the full backend suite**

```bash
cd backend
GOCACHE=/private/tmp/go-build-prime-agent go test ./...
```

Expected: PASS.

- [ ] **Step 3: Run repository lint and frontend typecheck**

```bash
npm run lint
npm run frontend:typecheck
```

Expected: both commands PASS.

- [ ] **Step 4: Inspect the final diff and branch state**

```bash
git diff main...HEAD --check
git status --short --branch
git log --oneline main..HEAD
```

Expected: no whitespace errors, no uncommitted files, and only Prime functionality/design commits on `codex/prime-agent-functionalities`.

- [ ] **Step 5: Request code review before PR creation**

Review the final diff against `docs/superpowers/specs/2026-08-09-prime-agent-functionalities-design.md`. Resolve correctness findings, rerun the affected checks, and only then prepare the single PR requested by the user.
