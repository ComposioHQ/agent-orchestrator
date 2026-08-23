package remote

import (
	"context"
	"reflect"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type fakeClient struct {
	calls     []string
	rollbacks int
}

func (*fakeClient) WorkspaceClient() ports.Workspace                    { return nil }
func (*fakeClient) RuntimeClient() ports.Runtime                        { return nil }
func (*fakeClient) MessengerClient() ports.AgentMessenger               { return nil }
func (*fakeClient) ObservationClient() ports.WorkspaceObservationClient { return nil }
func (f *fakeClient) add(v string)                                      { f.calls = append(f.calls, v) }
func (f *fakeClient) BeginExecution(context.Context, ports.ExecutionSpec) (string, error) {
	f.add("begin")
	return "txn", nil
}
func (f *fakeClient) StageExecutionSystemPrompt(context.Context, string, domain.SessionID, string) (string, error) {
	f.add("prompt")
	return "/remote/system.md", nil
}
func (f *fakeClient) CreateExecutionWorkspace(context.Context, string, ports.WorkspaceCreateSpec) (ports.WorkspaceInfo, *ports.WorkspaceProjectInfo, error) {
	f.add("workspace")
	return ports.WorkspaceInfo{Path: "/remote/workspace"}, nil, nil
}
func (f *fakeClient) ProvisionExecutionWorkspace(context.Context, string, ports.WorkspaceProvisionSpec) error {
	f.add("provision")
	return nil
}
func (f *fakeClient) StageExecutionAttachments(context.Context, string, domain.SessionID, string, []ports.SpawnAttachment) ([]string, error) {
	f.add("attachments")
	return []string{".ao/attachments/a"}, nil
}
func (f *fakeClient) InstallExecutionAgent(context.Context, string, ports.RemoteAgentPrepareSpec) error {
	f.add("agent")
	return nil
}
func (f *fakeClient) ResolveExecutionLaunch(context.Context, string, []string, map[string]string) (map[string]string, error) {
	f.add("resolve")
	return nil, nil
}
func (f *fakeClient) BindExecutionRuntime(_ context.Context, _ string, cfg ports.RuntimeConfig) (ports.RuntimeConfig, error) {
	f.add("bind")
	return cfg, nil
}
func (f *fakeClient) LaunchExecutionRuntime(context.Context, string, ports.RuntimeConfig) (ports.RuntimeHandle, error) {
	f.add("launch")
	return ports.RuntimeHandle{ID: "remote"}, nil
}
func (f *fakeClient) ResolveExecutionDiffBase(context.Context, string, string, string) (string, string) {
	f.add("diff")
	return "sha", "main"
}
func (f *fakeClient) CommitExecution(context.Context, string) error { f.add("commit"); return nil }
func (f *fakeClient) RollbackExecution(context.Context, string) ports.ExecutionRollback {
	f.add("rollback")
	f.rollbacks++
	return ports.ExecutionRollback{WorkspaceDestroyed: true}
}
func (f *fakeClient) StageExistingSystemPrompt(context.Context, domain.SessionID, string) (string, error) {
	return "/remote/system.md", nil
}
func (f *fakeClient) DiscardExistingSystemPrompt(context.Context, domain.SessionID) error { return nil }
func (f *fakeClient) InstallExistingAgent(context.Context, ports.RemoteAgentPrepareSpec) error {
	return nil
}
func (f *fakeClient) ResolveExistingLaunch(context.Context, []string, map[string]string) (map[string]string, error) {
	return nil, nil
}
func (f *fakeClient) BindExistingRuntime(_ context.Context, cfg ports.RuntimeConfig) (ports.RuntimeConfig, error) {
	return cfg, nil
}
func (f *fakeClient) ReadExecutionProjectFile(context.Context, string, string) ([]byte, error) {
	return nil, nil
}
func (f *fakeClient) ImportExecutionAttachments(context.Context, domain.SessionID, string) error {
	return nil
}
func (f *fakeClient) RestoreExecutionAttachments(context.Context, domain.SessionID, string) (bool, error) {
	return true, nil
}
func (f *fakeClient) RemoveExecutionAttachments(context.Context, domain.SessionID) error { return nil }

func TestProvisionEnforcesRemoteLifecycleOrderAndAtomicCommit(t *testing.T) {
	client := &fakeClient{}
	execution := &execution{client: client}
	p, err := execution.BeginSession(context.Background(), ports.ExecutionSpec{})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err = p.StageSystemPrompt(ctx, "s", "prompt"); err != nil {
		t.Fatal(err)
	}
	if _, _, err = p.CreateWorkspace(ctx, ports.WorkspaceCreateSpec{}); err != nil {
		t.Fatal(err)
	}
	if err = p.ProvisionWorkspace(ctx, ports.WorkspaceProvisionSpec{}); err != nil {
		t.Fatal(err)
	}
	if _, err = p.StageAttachments(ctx, "s", "/remote/workspace", nil); err != nil {
		t.Fatal(err)
	}
	if err = p.InstallAgent(ctx, ports.RemoteAgentPrepareSpec{}); err != nil {
		t.Fatal(err)
	}
	if _, err = p.ResolveLaunch(ctx, []string{"agent"}, nil); err != nil {
		t.Fatal(err)
	}
	cfg, err := p.BindRuntime(ctx, ports.RuntimeConfig{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = p.LaunchRuntime(ctx, cfg); err != nil {
		t.Fatal(err)
	}
	p.ResolveDiffBase(ctx, "/remote/workspace", "main")
	if err = p.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	want := []string{"begin", "prompt", "workspace", "provision", "attachments", "agent", "resolve", "bind", "launch", "diff", "commit"}
	if !reflect.DeepEqual(client.calls, want) {
		t.Fatalf("calls = %v, want %v", client.calls, want)
	}
	if out := p.Rollback(ctx); out.WorkspaceDestroyed {
		t.Fatal("committed transaction rolled back")
	}
}

func TestProvisionRejectsOutOfOrderLaunchAndRollsBackOnce(t *testing.T) {
	client := &fakeClient{}
	p, err := (&execution{client: client}).BeginSession(context.Background(), ports.ExecutionSpec{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.LaunchRuntime(context.Background(), ports.RuntimeConfig{}); err == nil {
		t.Fatal("out-of-order launch succeeded")
	}
	first := p.Rollback(context.Background())
	second := p.Rollback(context.Background())
	if !first.WorkspaceDestroyed || !second.WorkspaceDestroyed || client.rollbacks != 1 {
		t.Fatalf("rollback = %#v %#v calls=%d", first, second, client.rollbacks)
	}
}
