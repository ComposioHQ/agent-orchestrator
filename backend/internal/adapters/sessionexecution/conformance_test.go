package sessionexecution_test

import (
	"context"
	"reflect"
	"testing"

	localexecution "github.com/aoagents/agent-orchestrator/backend/internal/adapters/sessionexecution/local"
	remoteexecution "github.com/aoagents/agent-orchestrator/backend/internal/adapters/sessionexecution/remote"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestSessionExecutionLifecycleConformance(t *testing.T) {
	for _, fixture := range executionFixtures(t) {
		t.Run(fixture.name, func(t *testing.T) {
			ctx := context.Background()
			execution := fixture.execution
			workspace, err := execution.Workspace().Restore(ctx, ports.WorkspaceConfig{
				ProjectID: "project", SessionID: "session", Branch: "feature", Path: "/workspace/session",
			})
			if err != nil {
				t.Fatal(err)
			}
			bound, err := execution.BindRuntimeConfig(ctx, ports.RuntimeConfig{
				SessionID: "session", WorkspacePath: workspace.Path, Argv: []string{"agent"},
			})
			if err != nil {
				t.Fatal(err)
			}
			handle, err := execution.Runtime().Create(ctx, bound)
			if err != nil || handle.ID != "runtime-session" {
				t.Fatalf("create runtime = %#v, %v", handle, err)
			}
			if err := execution.Messenger().Send(ctx, "session", "hello"); err != nil {
				t.Fatal(err)
			}
			observation, err := execution.Observation().Snapshot(ctx, workspace)
			if err != nil || observation.Branch != "feature" || observation.HeadSHA != "abc123" {
				t.Fatalf("observation = %#v, err=%v", observation, err)
			}
			// A second bound launch is the same operation used by agent switching.
			switchConfig, err := execution.BindRuntimeConfig(ctx, ports.RuntimeConfig{
				SessionID: "session", WorkspacePath: workspace.Path, Argv: []string{"other-agent"},
			})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := execution.Runtime().Create(ctx, switchConfig); err != nil {
				t.Fatal(err)
			}
			if err := execution.Runtime().Destroy(ctx, handle); err != nil {
				t.Fatal(err)
			}
			if err := execution.Workspace().Destroy(ctx, workspace); err != nil {
				t.Fatal(err)
			}
			if got := fixture.messages(); !reflect.DeepEqual(got, []string{"hello"}) {
				t.Fatalf("messages = %#v", got)
			}
		})
	}
}

func TestSessionProvisionConformance(t *testing.T) {
	for _, fixture := range executionFixtures(t) {
		t.Run(fixture.name, func(t *testing.T) {
			ctx := context.Background()
			provision, err := fixture.execution.BeginSession(ctx, ports.ExecutionSpec{
				SessionID: "session", ProjectID: "project", Kind: domain.KindWorker,
				Harness: domain.HarnessCodex, Branch: "feature",
			})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := provision.StageSystemPrompt(ctx, "session", "rules"); err != nil {
				t.Fatal(err)
			}
			workspace, _, err := provision.CreateWorkspace(ctx, ports.WorkspaceCreateSpec{Workspace: ports.WorkspaceConfig{
				ProjectID: "project", SessionID: "session", Branch: "feature",
			}})
			if err != nil {
				t.Fatal(err)
			}
			if err := provision.Provision(ctx, ports.WorkspaceProvisionSpec{WorkspacePath: workspace.Path}); err != nil {
				t.Fatal(err)
			}
			if _, err := provision.StageAttachments(ctx, "session", workspace.Path, nil); err != nil {
				t.Fatal(err)
			}
			if err := provision.InstallAgentHooks(ctx, ports.AgentPrepareSpec{Harness: domain.HarnessCodex, SessionID: "session"}); err != nil {
				t.Fatal(err)
			}
			env, err := provision.ResolveLaunchBinary(ctx, []string{"agent"}, map[string]string{})
			if err != nil {
				t.Fatal(err)
			}
			bound, err := provision.BindRuntimeConfig(ctx, ports.RuntimeConfig{
				SessionID: "session", WorkspacePath: workspace.Path, Argv: []string{"agent"}, Env: env,
			})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := provision.LaunchRuntime(ctx, bound); err != nil {
				t.Fatal(err)
			}
			provision.ResolveDiffBase(ctx, workspace.Path, "refs/remotes/origin/main")
			if err := provision.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if outcome := provision.Rollback(ctx, ports.RollbackOptions{}); outcome.WorkspaceDestroyed {
				t.Fatal("rollback destroyed a committed environment")
			}
		})
	}
}

func TestRemoteProvisionOrderingAndRollback(t *testing.T) {
	backend := newFakeRemoteBackend()
	execution := remoteexecution.New(backend)
	ctx := context.Background()
	provision, err := execution.BeginSession(ctx, ports.ExecutionSpec{SessionID: "s", ProjectID: "p"})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := provision.CreateWorkspace(ctx, ports.WorkspaceCreateSpec{}); err == nil {
		t.Fatal("workspace creation before prompt staging succeeded")
	}
	if outcome := provision.Rollback(ctx, ports.RollbackOptions{}); !outcome.WorkspaceDestroyed {
		t.Fatal("rollback did not remove partial remote environment")
	}
	if got, want := backend.events, []string{"begin", "rollback"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("rollback events = %#v, want %#v", got, want)
	}

	backend.events = nil
	provision, _ = execution.BeginSession(ctx, ports.ExecutionSpec{SessionID: "s", ProjectID: "p"})
	_, _ = provision.StageSystemPrompt(ctx, "s", "rules")
	workspace, _, _ := provision.CreateWorkspace(ctx, ports.WorkspaceCreateSpec{Workspace: ports.WorkspaceConfig{SessionID: "s", Branch: "feature"}})
	_ = provision.Provision(ctx, ports.WorkspaceProvisionSpec{WorkspacePath: workspace.Path})
	_, _ = provision.StageAttachments(ctx, "s", workspace.Path, []ports.SpawnAttachment{{Ext: ".txt", Data: []byte("x")}})
	_ = provision.InstallAgentHooks(ctx, ports.AgentPrepareSpec{Harness: domain.HarnessCodex, SessionID: "s"})
	_, _ = provision.ResolveLaunchBinary(ctx, []string{"agent"}, map[string]string{})
	bound, _ := provision.BindRuntimeConfig(ctx, ports.RuntimeConfig{SessionID: "s", WorkspacePath: workspace.Path, Argv: []string{"agent"}})
	_, _ = provision.LaunchRuntime(ctx, bound)
	provision.ResolveDiffBase(ctx, workspace.Path, "main")
	if err := provision.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	want := []string{"begin", "prompt", "workspace", "provision", "attachments", "hooks", "binary", "bind", "launch", "diff", "commit"}
	if !reflect.DeepEqual(backend.events, want) {
		t.Fatalf("provision order = %#v, want %#v", backend.events, want)
	}
}

type executionFixture struct {
	name      string
	execution ports.SessionExecution
	messages  func() []string
}

func executionFixtures(t *testing.T) []executionFixture {
	t.Helper()
	localWorkspace := &fakeWorkspace{}
	localRuntime := &fakeRuntime{}
	localMessenger := &fakeMessenger{}
	local := localexecution.New(localexecution.Config{
		Workspace: localWorkspace, Runtime: localRuntime, Messenger: localMessenger,
		DataDir: t.TempDir(), LookPath: func(name string) (string, error) { return "/bin/" + name, nil },
		ResolveDiffBase: func(context.Context, string, string) (string, string) { return "base", "main" },
	})
	remoteBackend := newFakeRemoteBackend()
	remote := remoteexecution.New(remoteBackend)
	return []executionFixture{
		{name: "local", execution: local, messages: func() []string { return localMessenger.messages }},
		{name: "fake-remote", execution: remote, messages: func() []string { return remoteBackend.messenger.messages }},
	}
}

type fakeWorkspace struct{ destroyed int }

func (w *fakeWorkspace) Create(_ context.Context, cfg ports.WorkspaceConfig) (ports.WorkspaceInfo, error) {
	return workspaceInfo(cfg), nil
}
func (w *fakeWorkspace) Restore(_ context.Context, cfg ports.WorkspaceConfig) (ports.WorkspaceInfo, error) {
	return workspaceInfo(cfg), nil
}
func (w *fakeWorkspace) Destroy(context.Context, ports.WorkspaceInfo) error {
	w.destroyed++
	return nil
}
func (w *fakeWorkspace) ForceDestroy(context.Context, ports.WorkspaceInfo) error { return nil }
func (w *fakeWorkspace) StashUncommitted(context.Context, ports.WorkspaceInfo) (string, error) {
	return "", nil
}
func (w *fakeWorkspace) ApplyPreserved(context.Context, ports.WorkspaceInfo, string) error {
	return nil
}
func (w *fakeWorkspace) AddExclude(context.Context, ports.WorkspaceInfo, ...string) error { return nil }
func (w *fakeWorkspace) ObserveWorkspace(_ context.Context, info ports.WorkspaceInfo) (ports.WorkspaceSnapshot, error) {
	return ports.WorkspaceSnapshot{Path: info.Path, Branch: info.Branch, HeadSHA: "abc123"}, nil
}

func workspaceInfo(cfg ports.WorkspaceConfig) ports.WorkspaceInfo {
	path := cfg.Path
	if path == "" {
		path = "/workspace/" + string(cfg.SessionID)
	}
	return ports.WorkspaceInfo{Path: path, Branch: cfg.Branch, SessionID: cfg.SessionID, ProjectID: cfg.ProjectID}
}

type fakeRuntime struct{ events *[]string }

func (r *fakeRuntime) Create(_ context.Context, cfg ports.RuntimeConfig) (ports.RuntimeHandle, error) {
	if r.events != nil {
		*r.events = append(*r.events, "launch")
	}
	return ports.RuntimeHandle{ID: "runtime-" + string(cfg.SessionID)}, nil
}
func (*fakeRuntime) Destroy(context.Context, ports.RuntimeHandle) error { return nil }
func (*fakeRuntime) GetOutput(context.Context, ports.RuntimeHandle, int) (string, error) {
	return "output", nil
}
func (*fakeRuntime) IsAlive(context.Context, ports.RuntimeHandle) (bool, error) { return true, nil }

type fakeMessenger struct{ messages []string }

func (m *fakeMessenger) Send(_ context.Context, _ domain.SessionID, message string) error {
	m.messages = append(m.messages, message)
	return nil
}

type fakeRemoteBackend struct {
	events    []string
	workspace *fakeWorkspace
	runtime   *fakeRuntime
	messenger *fakeMessenger
}

func newFakeRemoteBackend() *fakeRemoteBackend {
	b := &fakeRemoteBackend{workspace: &fakeWorkspace{}, messenger: &fakeMessenger{}}
	b.runtime = &fakeRuntime{events: &b.events}
	return b
}

func (b *fakeRemoteBackend) RuntimeBackend() ports.Runtime                  { return b.runtime }
func (b *fakeRemoteBackend) WorkspaceBackend() ports.Workspace              { return b.workspace }
func (b *fakeRemoteBackend) MessengerBackend() ports.AgentMessenger         { return b.messenger }
func (b *fakeRemoteBackend) ObservationBackend() ports.WorkspaceObservation { return b }
func (b *fakeRemoteBackend) BeginExecution(context.Context, ports.ExecutionSpec) (string, error) {
	b.events = append(b.events, "begin")
	return "tx", nil
}
func (b *fakeRemoteBackend) StageExecutionSystemPrompt(context.Context, string, domain.SessionID, string) (string, error) {
	b.events = append(b.events, "prompt")
	return "/sandbox/system.md", nil
}
func (b *fakeRemoteBackend) CreateExecutionWorkspace(_ context.Context, _ string, spec ports.WorkspaceCreateSpec) (ports.WorkspaceInfo, *ports.WorkspaceProjectInfo, error) {
	b.events = append(b.events, "workspace")
	info, err := b.workspace.Create(context.Background(), spec.Workspace)
	return info, nil, err
}
func (b *fakeRemoteBackend) ProvisionExecutionWorkspace(context.Context, string, ports.WorkspaceProvisionSpec) error {
	b.events = append(b.events, "provision")
	return nil
}
func (b *fakeRemoteBackend) StageExecutionAttachments(context.Context, string, domain.SessionID, string, []ports.SpawnAttachment) ([]string, error) {
	b.events = append(b.events, "attachments")
	return []string{".ao/attachments/attachment-1.txt"}, nil
}
func (b *fakeRemoteBackend) PutExecutionAttachment(context.Context, domain.SessionID, string, string, []byte) error {
	return nil
}
func (b *fakeRemoteBackend) InstallExecutionAgent(context.Context, string, ports.RemoteAgentPrepareSpec) error {
	b.events = append(b.events, "hooks")
	return nil
}
func (b *fakeRemoteBackend) ResolveExecutionBinary(_ context.Context, executionID string, _ []string, env map[string]string) (map[string]string, error) {
	if executionID != "" {
		b.events = append(b.events, "binary")
	}
	return env, nil
}
func (b *fakeRemoteBackend) BindExecutionRuntime(_ context.Context, _ string, cfg ports.RuntimeConfig) (ports.RuntimeConfig, error) {
	b.events = append(b.events, "bind")
	return cfg, nil
}
func (b *fakeRemoteBackend) LaunchExecutionRuntime(ctx context.Context, _ string, cfg ports.RuntimeConfig) (ports.RuntimeHandle, error) {
	return b.runtime.Create(ctx, cfg)
}
func (b *fakeRemoteBackend) ResolveExecutionDiffBase(context.Context, string, string, string) (string, string) {
	b.events = append(b.events, "diff")
	return "base", "main"
}
func (b *fakeRemoteBackend) CommitExecution(context.Context, string) error {
	b.events = append(b.events, "commit")
	return nil
}
func (b *fakeRemoteBackend) RollbackExecution(context.Context, string, ports.RollbackOptions) ports.RollbackOutcome {
	b.events = append(b.events, "rollback")
	return ports.RollbackOutcome{WorkspaceDestroyed: true}
}
func (*fakeRemoteBackend) ValidateExecutionHost(context.Context) error { return nil }
func (*fakeRemoteBackend) ReadExecutionProjectFile(context.Context, string, string) ([]byte, error) {
	return []byte("rules"), nil
}
func (*fakeRemoteBackend) DiscardExecutionSystemPrompt(context.Context, domain.SessionID) error {
	return nil
}
func (*fakeRemoteBackend) ImportExecutionAttachments(context.Context, domain.SessionID, string) error {
	return nil
}
func (*fakeRemoteBackend) RestoreExecutionAttachments(context.Context, domain.SessionID, string) (bool, error) {
	return true, nil
}
func (*fakeRemoteBackend) RemoveExecutionAttachments(context.Context, domain.SessionID) error {
	return nil
}
func (*fakeRemoteBackend) RemoveExecutionAgentState(context.Context, ports.RemoteAgentPrepareSpec) error {
	return nil
}
func (*fakeRemoteBackend) BindExistingRuntime(_ context.Context, cfg ports.RuntimeConfig) (ports.RuntimeConfig, error) {
	return cfg, nil
}
func (b *fakeRemoteBackend) Snapshot(_ context.Context, info ports.WorkspaceInfo) (ports.WorkspaceSnapshot, error) {
	return b.workspace.ObserveWorkspace(context.Background(), info)
}
func (*fakeRemoteBackend) List(context.Context, ports.WorkspaceListRequest) (ports.WorkspaceListResult, error) {
	return ports.WorkspaceListResult{}, nil
}
func (*fakeRemoteBackend) Read(_ context.Context, request ports.WorkspaceReadRequest) (ports.WorkspaceReadResult, error) {
	return ports.WorkspaceReadResult{Path: request.Path, Data: []byte("remote")}, nil
}
func (*fakeRemoteBackend) Watch(ctx context.Context, _ ports.WorkspaceWatchRequest) (<-chan ports.WorkspaceEvent, error) {
	events := make(chan ports.WorkspaceEvent)
	go func() { defer close(events); <-ctx.Done() }()
	return events, nil
}
func (*fakeRemoteBackend) Diff(context.Context, ports.WorkspaceDiffRequest) (ports.WorkspaceDiffResult, error) {
	return ports.WorkspaceDiffResult{UnifiedDiff: "diff"}, nil
}
func (*fakeRemoteBackend) Blob(_ context.Context, request ports.WorkspaceBlobRequest) (ports.WorkspaceBlobResult, error) {
	return ports.WorkspaceBlobResult{Path: request.Path, Data: []byte("blob")}, nil
}
func (*fakeRemoteBackend) ResolveExistingDiffBase(context.Context, string, string) (string, string) {
	return "base", "main"
}
