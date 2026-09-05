package agent

import (
	"context"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const otherCodexAccountID = "bb1e9a5d-37ad-43f8-83bd-13de8168f8af"

// codexLaunchReadinessFixture reproduces the divergence between the two Codex
// account/read modes: the non-refresh read answers from locally present account
// material while the refresh-capable read the launch path uses reports
// requiresOpenaiAuth.
type codexLaunchReadinessFixture struct {
	t             *testing.T
	manager       *codexAccountManager
	service       *Service
	active        codexAccountRecord
	other         codexAccountRecord
	mu            sync.Mutex
	refreshSignsI bool
	reads         []codexReadCall
}

type codexReadCall struct {
	managed bool
	refresh bool
}

func newCodexLaunchReadinessFixture(t *testing.T) *codexLaunchReadinessFixture {
	t.Helper()
	root := t.TempDir()
	globalHome := filepath.Join(root, "global-codex")
	if err := ensurePrivateDirectory(globalHome); err != nil {
		t.Fatal(err)
	}
	state := &fakeCodexAccountStateStore{active: domain.CodexActiveAccount{AccountID: testAccountID, Revision: 1}, found: true}
	manager := newCodexAccountManager(context.Background(),
		filepath.Join(root, "accounts"), filepath.Join(root, "pending"),
		filepath.Join(root, "staging"), globalHome, nil, state, nil)
	ids := []string{testAccountID, otherCodexAccountID, "6f8dfc76-8db4-4621-8974-c480093e0d55"}
	manager.catalog.newID = func() string { id := ids[0]; ids = ids[1:]; return id }
	manager.newID = func() string { return "b9a4e5c6-4f31-4b1a-9d2a-7b4a4c0f9a11" }
	activeEmail, otherEmail := "active@example.com", "other@example.com"
	active := commitTestAccount(t, manager.catalog, manager.pendingRoot, "b60a377d-da68-4a61-86f2-f31f04c571f2", ports.CodexAccountObservation{
		Authentication: domain.AgentAuthenticationAuthorized, Method: domain.CodexAuthMethodChatGPT, Email: &activeEmail,
	})
	other := commitTestAccount(t, manager.catalog, manager.pendingRoot, "1c5de3ab-82d0-4a68-a06b-8495cdeab909", ports.CodexAccountObservation{
		Authentication: domain.AgentAuthenticationAuthorized, Method: domain.CodexAuthMethodChatGPT, Email: &otherEmail,
	})
	activeCredential, err := readOpaqueCredential(filepath.Join(active.Home, codexCredentialFilename))
	if err != nil {
		t.Fatal(err)
	}
	// The active account is backed by the device-global Codex home.
	if err := writeGlobalCredentialAtomic(manager.globalCredentialPath(), activeCredential); err != nil {
		t.Fatal(err)
	}
	manager.active = state.active
	manager.bootstrapped = true
	fixture := &codexLaunchReadinessFixture{t: t, manager: manager, active: active, other: other}
	manager.factory = &fakeCodexAccountFactory{capabilities: supportedCodexAccountCapabilities(), open: func(account ports.CodexAccountContext) (ports.CodexAccountClient, error) {
		global := !account.Managed
		return &fakeCodexAccountClient{readFn: func(_ context.Context, refresh bool) (ports.CodexAccountObservation, error) {
			fixture.mu.Lock()
			fixture.reads = append(fixture.reads, codexReadCall{managed: account.Managed, refresh: refresh})
			signedIn := fixture.refreshSignsI
			fixture.mu.Unlock()
			if account.Home == other.Home {
				return ports.CodexAccountObservation{Authentication: domain.AgentAuthenticationAuthorized, Method: domain.CodexAuthMethodChatGPT, Email: &otherEmail}, nil
			}
			if global && refresh && !signedIn {
				// Codex answers the refresh-capable read with requiresOpenaiAuth.
				return ports.CodexAccountObservation{Authentication: domain.AgentAuthenticationUnauthorized, Method: domain.CodexAuthMethodUnknown}, nil
			}
			return ports.CodexAccountObservation{Authentication: domain.AgentAuthenticationAuthorized, Method: domain.CodexAuthMethodChatGPT, Email: &activeEmail}, nil
		}}, nil
	}}
	fixture.service = &Service{codexAccounts: manager, readiness: newReadinessCoordinator(readinessCoordinatorConfig{})}
	return fixture
}

func (f *codexLaunchReadinessFixture) signIn() {
	f.mu.Lock()
	f.refreshSignsI = true
	f.mu.Unlock()
}

func (f *codexLaunchReadinessFixture) refreshCapableReads() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	count := 0
	for _, read := range f.reads {
		if read.refresh {
			count++
		}
	}
	return count
}

func (f *codexLaunchReadinessFixture) ensureSettings() CodexAccounts {
	f.t.Helper()
	result, err := f.manager.ensure(context.Background(), nil, false, domain.AgentInstallationInstalled)
	if err != nil {
		f.t.Fatal(err)
	}
	return result
}

func (f *codexLaunchReadinessFixture) account(view CodexAccounts, id string) domain.CodexAccountSnapshot {
	f.t.Helper()
	for _, account := range view.Accounts {
		if account.ID == id {
			return account
		}
	}
	f.t.Fatalf("account %q missing from view %#v", id, view.Accounts)
	return domain.CodexAccountSnapshot{}
}

func TestSettingsEnsureDoesNotPresentTheActiveAccountAsLaunchReady(t *testing.T) {
	fixture := newCodexLaunchReadinessFixture(t)

	view := fixture.ensureSettings()

	active := fixture.account(view, fixture.active.Snapshot.ID)
	if active.Authentication.State != domain.AgentAuthenticationUnauthorized || active.Authentication.Freshness != domain.AgentReadinessFresh {
		t.Fatalf("Settings reported the active account as launch-ready = %#v", active.Authentication)
	}
	if fixture.refreshCapableReads() == 0 {
		t.Fatal("Settings classified the active account without a refresh-capable read")
	}
	// The launch path agrees without another native read, so a spawn admitted now
	// rejects for the same reason Settings shows.
	before := fixture.refreshCapableReads()
	launch, ok := fixture.service.structuredCodexAuthentication(context.Background(), string(domain.HarnessCodex), domain.AgentReadinessPurposeLaunch)
	if !ok || launch.State != domain.AgentAuthenticationUnauthorized || launch.Freshness != domain.AgentReadinessFresh {
		t.Fatalf("launch readiness = %#v (structured=%t)", launch, ok)
	}
	if fixture.refreshCapableReads() != before {
		t.Fatalf("launch repeated the refresh-capable read: %d then %d", before, fixture.refreshCapableReads())
	}
}

func TestSettingsEnsureCannotOverwriteAFreshLaunchAuthenticationFailure(t *testing.T) {
	fixture := newCodexLaunchReadinessFixture(t)
	if _, ok := fixture.service.structuredCodexAuthentication(context.Background(), string(domain.HarnessCodex), domain.AgentReadinessPurposeLaunch); !ok {
		t.Fatal("launch readiness was not structured")
	}

	// Focusing Settings after the failed spawn re-runs the ensure path once its
	// display window has expired. It must not restore the reassuring result.
	base := time.Now().UTC()
	fixture.manager.now = func() time.Time { return base.Add(codexAccountDisplayTTL + time.Minute) }
	view := fixture.ensureSettings()

	active := fixture.account(view, fixture.active.Snapshot.ID)
	if active.Authentication.State != domain.AgentAuthenticationUnauthorized {
		t.Fatalf("Settings ensure overwrote the launch failure = %#v", active.Authentication)
	}
}

func TestDisplayReadInFlightCannotClearARequiredReauthentication(t *testing.T) {
	started, release := make(chan struct{}, 1), make(chan struct{})
	client := &fakeCodexAccountClient{
		read:        ports.CodexAccountObservation{Authentication: domain.AgentAuthenticationAuthorized, Method: domain.CodexAuthMethodChatGPT},
		readStarted: started, readRelease: release,
	}
	factory := &fakeCodexAccountFactory{open: func(ports.CodexAccountContext) (ports.CodexAccountClient, error) { return client, nil }}
	manager := newTestCodexAccountManager(t, factory, nil)
	manager.catalog.newID = func() string { return testAccountID }
	record := commitTestAccount(t, manager.catalog, manager.pendingRoot, "b60a377d-da68-4a61-86f2-f31f04c571f2", ports.CodexAccountObservation{
		Authentication: domain.AgentAuthenticationAuthorized, Method: domain.CodexAuthMethodChatGPT,
	})
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = manager.ensureAuthentication(context.Background(), record, domain.AgentReadinessPurposeDisplay)
	}()
	<-started

	manager.requireReauthentication(record.Snapshot.ID)
	close(release)
	<-done

	latest, _ := manager.catalog.record(record.Snapshot.ID)
	if latest.Snapshot.Authentication.State != domain.AgentAuthenticationUnauthorized || latest.Snapshot.Authentication.Freshness != domain.AgentReadinessFresh {
		t.Fatalf("display read cleared the required reauthentication = %#v", latest.Snapshot.Authentication)
	}
}

func TestAuthorizedInactiveAccountDoesNotMaskTheActiveAccount(t *testing.T) {
	fixture := newCodexLaunchReadinessFixture(t)

	view := fixture.ensureSettings()

	if other := fixture.account(view, fixture.other.Snapshot.ID); other.Authentication.State != domain.AgentAuthenticationAuthorized {
		t.Fatalf("inactive account authentication = %#v", other.Authentication)
	}
	authentication, ok := fixture.service.structuredCodexAuthentication(context.Background(), string(domain.HarnessCodex), domain.AgentReadinessPurposeDisplay)
	if !ok || authentication.State != domain.AgentAuthenticationUnauthorized {
		t.Fatalf("Codex readiness masked by the inactive account = %#v (structured=%t)", authentication, ok)
	}
	// Inactive accounts are still not refreshed merely to render the list.
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	for _, read := range fixture.reads {
		if read.managed && read.refresh {
			t.Fatalf("an inactive account was refreshed for display: %#v", fixture.reads)
		}
	}
}

func TestSuccessfulReauthenticationRestoresLaunchReadiness(t *testing.T) {
	fixture := newCodexLaunchReadinessFixture(t)
	fixture.ensureSettings()

	fixture.signIn()
	fixture.manager.invalidate(fixture.active.Snapshot.ID)
	view := fixture.ensureSettings()

	active := fixture.account(view, fixture.active.Snapshot.ID)
	if active.Authentication.State != domain.AgentAuthenticationAuthorized || active.Authentication.Freshness != domain.AgentReadinessFresh {
		t.Fatalf("Settings did not recover after reauthentication = %#v", active.Authentication)
	}
	launch, ok := fixture.service.structuredCodexAuthentication(context.Background(), string(domain.HarnessCodex), domain.AgentReadinessPurposeLaunch)
	if !ok || launch.State != domain.AgentAuthenticationAuthorized {
		t.Fatalf("launch readiness after reauthentication = %#v (structured=%t)", launch, ok)
	}
}
