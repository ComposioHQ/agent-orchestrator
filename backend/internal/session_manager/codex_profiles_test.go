package sessionmanager

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type fakeCodexLaunchResolver struct {
	validated   []domain.CodexSessionBinding
	invalidated []string
}

func (f *fakeCodexLaunchResolver) ResolveCodexProfileForLaunch(_ context.Context, profileID string) (domain.CodexLaunchContext, error) {
	return domain.CodexLaunchContext{Binding: domain.CodexSessionBinding{ProfileID: profileID}}, nil
}

func (f *fakeCodexLaunchResolver) ResolveCodexLegacyBinding(_ context.Context, sessionID domain.SessionID, _ string, createdAt time.Time) (domain.CodexSessionBinding, error) {
	return domain.CodexSessionBinding{SessionID: sessionID, ProfileID: "existing", Source: domain.CodexProfileSourceExisting, CreatedAt: createdAt}, nil
}

func (f *fakeCodexLaunchResolver) ValidateCodexSessionBinding(_ context.Context, binding domain.CodexSessionBinding) (domain.CodexLaunchContext, error) {
	f.validated = append(f.validated, binding)
	return domain.CodexLaunchContext{
		Binding: binding,
		Env:     map[string]string{"CODEX_HOME": binding.Home},
		Managed: binding.Source == domain.CodexProfileSourceManaged,
	}, nil
}

func (*fakeCodexLaunchResolver) CodexSessionProfileSummary(binding domain.CodexSessionBinding) domain.CodexSessionProfileSummary {
	return domain.CodexSessionProfileSummary{ID: binding.ProfileID, Source: binding.Source}
}

func (f *fakeCodexLaunchResolver) InvalidateCodexProfileAuthentication(profileID string) {
	f.invalidated = append(f.invalidated, profileID)
}

func TestCodexLaunchForRecordReusesBindingWhileSwitchedAway(t *testing.T) {
	resolver := &fakeCodexLaunchResolver{}
	binding := domain.CodexSessionBinding{
		SessionID: "ao-1", ProfileID: "managed-profile", Source: domain.CodexProfileSourceManaged,
		Home: "/safe/codex-home", CreatedAt: time.Unix(1, 0),
	}
	record := domain.SessionRecord{ID: "ao-1", Harness: domain.HarnessClaudeCode, CodexProfileBinding: &binding}
	m := &Manager{codexProfiles: resolver}

	launch, err := m.codexLaunchForRecord(context.Background(), &record)
	if err != nil {
		t.Fatalf("codexLaunchForRecord: %v", err)
	}
	if launch == nil || launch.Binding != binding || !launch.Managed || launch.Env["CODEX_HOME"] != binding.Home {
		t.Fatalf("launch = %#v, want exact managed binding", launch)
	}
	if len(resolver.validated) != 1 || resolver.validated[0] != binding {
		t.Fatalf("validated = %#v, want exact binding", resolver.validated)
	}
}

func TestResolveInitialCodexLaunchRejectsMissingParentBeforeExplicitSelection(t *testing.T) {
	for _, cfg := range []ports.SpawnConfig{
		portsSpawnConfigForTest(domain.HarnessCodex, "existing", "missing"),
		portsSpawnConfigForTest(domain.HarnessClaudeCode, "", "missing"),
	} {
		m := &Manager{store: newFakeStore(), codexProfiles: &fakeCodexLaunchResolver{}}
		_, err := m.resolveInitialCodexLaunch(context.Background(), cfg)
		var apiError *apierr.Error
		if !errors.As(err, &apiError) || apiError.Code != "PARENT_SESSION_NOT_FOUND" {
			t.Fatalf("config %#v: err = %v, want PARENT_SESSION_NOT_FOUND", cfg, err)
		}
	}
}

func portsSpawnConfigForTest(harness domain.AgentHarness, profileID string, parentID domain.SessionID) ports.SpawnConfig {
	return ports.SpawnConfig{Harness: harness, ProfileID: profileID, ParentSessionID: parentID}
}

func TestManagedCodexCommandIsolationIsInvocationScopedAndIdempotent(t *testing.T) {
	argv := []string{"codex", "resume", "thread-1"}
	isolated := isolateManagedCodexCommand(argv, true)
	want := []string{"codex", "-c", `cli_auth_credentials_store="file"`, "resume", "thread-1"}
	if strings.Join(isolated, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("isolated = %#v, want %#v", isolated, want)
	}
	again := isolateManagedCodexCommand(isolated, true)
	if strings.Join(again, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("second isolation = %#v, want idempotent %#v", again, want)
	}
	if got := isolateManagedCodexCommand(argv, false); strings.Join(got, "\x00") != strings.Join(argv, "\x00") {
		t.Fatalf("existing profile argv changed: %#v", got)
	}
}

func TestCodexAuthenticationFailureInvalidatesOnlyBoundProfile(t *testing.T) {
	resolver := &fakeCodexLaunchResolver{}
	binding := domain.CodexSessionBinding{ProfileID: "managed-profile", Source: domain.CodexProfileSourceManaged}
	m := &Manager{codexProfiles: resolver}
	m.invalidateCodexAuthenticationAfterFailure(domain.SessionRecord{CodexProfileBinding: &binding}, ports.ErrChatAuthRequired)
	m.invalidateCodexAuthenticationAfterFailure(domain.SessionRecord{CodexProfileBinding: &binding}, errors.New("unrelated"))
	if len(resolver.invalidated) != 1 || resolver.invalidated[0] != "managed-profile" {
		t.Fatalf("invalidated = %#v, want exact bound profile", resolver.invalidated)
	}
}
