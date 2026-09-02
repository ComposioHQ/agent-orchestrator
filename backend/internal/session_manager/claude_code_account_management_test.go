package sessionmanager

import (
	"context"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestClaudeCodeAccountSwitchFingerprintBindsTargetAndRevision(t *testing.T) {
	first := claudeCodeAccountSwitchFingerprint("account-b", 7)
	if first == "" || first != claudeCodeAccountSwitchFingerprint("account-b", 7) {
		t.Fatalf("fingerprint is unstable: %q", first)
	}
	if first == claudeCodeAccountSwitchFingerprint("account-c", 7) {
		t.Fatal("fingerprint did not bind target")
	}
	if first == claudeCodeAccountSwitchFingerprint("account-b", 8) {
		t.Fatal("fingerprint did not bind revision")
	}
}

type claudeSwitchTestStore struct {
	*fakeStore
	mu       sync.Mutex
	switches map[string]domain.ClaudeCodeAccountSwitch
	byKey    map[string]string
	phases   []domain.ClaudeCodeAccountSwitchPhase
}

func (s *claudeSwitchTestStore) CreateClaudeCodeAccountSwitch(_ context.Context, sw domain.ClaudeCodeAccountSwitch) (domain.ClaudeCodeAccountSwitch, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if id := s.byKey[sw.IdempotencyKey]; id != "" {
		return s.switches[id], false, nil
	}
	s.switches[sw.ID], s.byKey[sw.IdempotencyKey] = sw, sw.ID
	s.phases = append(s.phases, sw.Phase)
	return sw, true, nil
}
func (s *claudeSwitchTestStore) GetClaudeCodeAccountSwitch(_ context.Context, id string) (domain.ClaudeCodeAccountSwitch, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sw, ok := s.switches[id]
	return sw, ok, nil
}
func (s *claudeSwitchTestStore) GetClaudeCodeAccountSwitchByIdempotency(_ context.Context, key string) (domain.ClaudeCodeAccountSwitch, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := s.byKey[key]
	sw, ok := s.switches[id]
	return sw, ok, nil
}
func (s *claudeSwitchTestStore) GetActiveClaudeCodeAccountSwitch(context.Context) (domain.ClaudeCodeAccountSwitch, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, sw := range s.switches {
		if !sw.Phase.Terminal() {
			return sw, true, nil
		}
	}
	return domain.ClaudeCodeAccountSwitch{}, false, nil
}
func (s *claudeSwitchTestStore) UpdateClaudeCodeAccountSwitch(_ context.Context, sw domain.ClaudeCodeAccountSwitch, expected domain.ClaudeCodeAccountSwitchPhase) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.switches[sw.ID]
	if !ok || current.Phase != expected {
		return false, nil
	}
	s.switches[sw.ID] = sw
	s.phases = append(s.phases, sw.Phase)
	return true, nil
}

type fakeClaudeCredentialSwitch struct {
	mu    sync.Mutex
	calls []string
}

func (f *fakeClaudeCredentialSwitch) call(value string) {
	f.mu.Lock()
	f.calls = append(f.calls, value)
	f.mu.Unlock()
}
func (f *fakeClaudeCredentialSwitch) CheckpointSource(context.Context) error {
	f.call("checkpoint")
	return nil
}
func (f *fakeClaudeCredentialSwitch) ActivateTarget(context.Context) error {
	f.call("activate")
	return nil
}
func (f *fakeClaudeCredentialSwitch) UpdateIdentity(context.Context) (time.Time, error) {
	f.call("identity")
	return time.Now().UTC(), nil
}
func (f *fakeClaudeCredentialSwitch) ReleaseNativeLocks() { f.call("release") }
func (f *fakeClaudeCredentialSwitch) VerifyGlobal(context.Context) error {
	f.call("verify")
	return nil
}
func (f *fakeClaudeCredentialSwitch) CommitActivePointer(context.Context) (domain.ClaudeCodeActiveAccount, error) {
	f.call("commit")
	return domain.ClaudeCodeActiveAccount{AccountID: "account-b", Revision: 2}, nil
}
func (f *fakeClaudeCredentialSwitch) Rollback(context.Context) error { f.call("rollback"); return nil }
func (f *fakeClaudeCredentialSwitch) Cleanup(context.Context) error  { f.call("cleanup"); return nil }

type fakeClaudeCredentialManager struct {
	txn      *fakeClaudeCredentialSwitch
	active   domain.ClaudeCodeActiveAccount
	mutation bool
}

func (*fakeClaudeCredentialManager) EnsureAgentReadiness(context.Context, string, domain.AgentReadinessPurpose) (domain.AgentReadinessSnapshot, error) {
	return domain.AgentReadinessSnapshot{}, nil
}
func (*fakeClaudeCredentialManager) InvalidateAgentInstallation(string)                   {}
func (*fakeClaudeCredentialManager) InvalidateAgentAuthentication(string)                 {}
func (*fakeClaudeCredentialManager) RecheckAgent(string)                                  {}
func (*fakeClaudeCredentialManager) WaitClaudeCodeAccountBootstrap(context.Context) error { return nil }
func (f *fakeClaudeCredentialManager) CurrentClaudeCodeActiveAccount() domain.ClaudeCodeActiveAccount {
	return f.active
}
func (*fakeClaudeCredentialManager) ClaudeCodeAccountLoginInProgress() bool { return false }
func (f *fakeClaudeCredentialManager) BeginClaudeCodeAccountMutation(context.Context) error {
	f.mutation = true
	return nil
}
func (f *fakeClaudeCredentialManager) EndClaudeCodeAccountMutation() { f.mutation = false }
func (*fakeClaudeCredentialManager) StageClaudeCodeAccountForSwitch(context.Context, string, string) error {
	return nil
}
func (f *fakeClaudeCredentialManager) BeginClaudeCodeCredentialSwitch(context.Context, domain.ClaudeCodeAccountSwitch) (ports.ClaudeCodeCredentialSwitch, error) {
	return f.txn, nil
}
func (*fakeClaudeCredentialManager) RecoverClaudeCodeCredentialSwitch(context.Context, domain.ClaudeCodeAccountSwitch) (ports.ClaudeCodeCredentialRecoveryOutcome, *time.Time, error) {
	return ports.ClaudeCodeCredentialRecoveryFailed, nil, nil
}
func (*fakeClaudeCredentialManager) CleanupClaudeCodeSwitchArtifacts(context.Context, string) error {
	return nil
}
func (*fakeClaudeCredentialManager) PublishClaudeCodeAccounts() {}

func TestClaudeCodeHotSwitchRunsDurablePhasesWithoutSessionRestart(t *testing.T) {
	m, base, _, _ := newManager()
	store := &claudeSwitchTestStore{fakeStore: base, switches: map[string]domain.ClaudeCodeAccountSwitch{}, byKey: map[string]string{}}
	txn := &fakeClaudeCredentialSwitch{}
	credentials := &fakeClaudeCredentialManager{txn: txn, active: domain.ClaudeCodeActiveAccount{AccountID: "account-a", Revision: 1}}
	m.store, m.agentReadiness = store, credentials

	sw, err := m.StartClaudeCodeAccountSwitch(context.Background(), ports.ClaudeCodeAccountSwitchConfig{
		TargetAccountID: "account-b", ExpectedAccountRevision: 1, IdempotencyKey: "request-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	m.agentSwitchWorkers.Wait()
	stored, ok, err := store.GetClaudeCodeAccountSwitch(context.Background(), sw.ID)
	if err != nil || !ok || stored.Phase != domain.ClaudeCodeAccountSwitchCompleted || stored.PropagationUncertainUntil == nil || stored.CredentialsCommittedAt == nil {
		t.Fatalf("completed switch = %+v ok=%v err=%v", stored, ok, err)
	}
	wantPhases := []domain.ClaudeCodeAccountSwitchPhase{
		domain.ClaudeCodeAccountSwitchRequested, domain.ClaudeCodeAccountSwitchVerifyingTarget,
		domain.ClaudeCodeAccountSwitchCheckpointingSource, domain.ClaudeCodeAccountSwitchActivatingTarget,
		domain.ClaudeCodeAccountSwitchUpdatingIdentity, domain.ClaudeCodeAccountSwitchVerifyingGlobal,
		domain.ClaudeCodeAccountSwitchCompleted,
	}
	if !reflect.DeepEqual(store.phases, wantPhases) {
		t.Fatalf("phases = %v, want %v", store.phases, wantPhases)
	}
	if got := strings.Join(txn.calls, ","); !strings.Contains(got, "checkpoint,activate,identity,release,verify,commit,cleanup") {
		t.Fatalf("credential calls = %s", got)
	}
	if len(base.sessions) != 0 {
		t.Fatalf("hot switch touched sessions: %+v", base.sessions)
	}
}
