package agent

import (
	"context"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type fakeCodexAccountFactory struct {
	mu               sync.Mutex
	opens            int
	capabilityChecks int
	capabilities     domain.CodexProfileCapabilities
	open             func(ports.CodexAccountProfile) ports.CodexAccountClient
}

func (f *fakeCodexAccountFactory) Open(_ context.Context, profile ports.CodexAccountProfile) (ports.CodexAccountClient, error) {
	f.mu.Lock()
	f.opens++
	open := f.open
	f.mu.Unlock()
	return open(profile), nil
}
func (f *fakeCodexAccountFactory) Capabilities(context.Context) domain.CodexProfileCapabilities {
	f.mu.Lock()
	f.capabilityChecks++
	capabilities := f.capabilities
	f.mu.Unlock()
	return capabilities
}

type fakeCodexAccountClient struct {
	mu          sync.Mutex
	reads       []ports.CodexAccountObservation
	readErr     error
	readStarted chan struct{}
	readRelease chan struct{}
	events      chan ports.CodexAccountEvent
	cancelled   string
}

func (c *fakeCodexAccountClient) Read(ctx context.Context, _ bool) (ports.CodexAccountObservation, error) {
	if c.readStarted != nil {
		select {
		case c.readStarted <- struct{}{}:
		default:
		}
	}
	if c.readRelease != nil {
		select {
		case <-c.readRelease:
		case <-ctx.Done():
			return ports.CodexAccountObservation{}, ctx.Err()
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.readErr != nil {
		return ports.CodexAccountObservation{}, c.readErr
	}
	if len(c.reads) == 0 {
		return ports.CodexAccountObservation{}, errors.New("no fake account read result")
	}
	result := c.reads[0]
	if len(c.reads) > 1 {
		c.reads = c.reads[1:]
	}
	return result, nil
}
func (c *fakeCodexAccountClient) StartBrowserLogin(context.Context) (ports.CodexLoginStart, error) {
	return ports.CodexLoginStart{AuthURL: "https://auth.example.test/login", LoginID: "login-1"}, nil
}
func (c *fakeCodexAccountClient) CancelLogin(_ context.Context, loginID string) error {
	c.cancelled = loginID
	return nil
}
func (c *fakeCodexAccountClient) Events() <-chan ports.CodexAccountEvent { return c.events }
func (c *fakeCodexAccountClient) Close() error                           { return nil }

func supportedCodexProfileCapabilities() domain.CodexProfileCapabilities {
	value := domain.CodexCapabilityObservation{State: domain.CodexCapabilitySupported, ReasonCode: domain.CodexCapabilityReasonSupported, Reason: "supported"}
	return domain.CodexProfileCapabilities{AccountRead: value, BrowserLogin: value}
}

func TestCachedCodexProfilesPerformsNoNativeWork(t *testing.T) {
	factory := &fakeCodexAccountFactory{capabilities: supportedCodexProfileCapabilities(), open: func(ports.CodexAccountProfile) ports.CodexAccountClient {
		t.Fatal("opened native client from cached read")
		return nil
	}}
	manager := newCodexProfileManager(context.Background(), t.TempDir(), t.TempDir(), factory, nil)
	result := manager.cached()
	if len(result.Profiles) != 1 || result.Profiles[0].ID != codexExistingProfileID {
		t.Fatalf("profiles = %#v", result.Profiles)
	}
	if factory.opens != 0 || factory.capabilityChecks != 0 {
		t.Fatalf("native work = capabilities %d opens %d", factory.capabilityChecks, factory.opens)
	}
}

func TestCodexProfileAuthenticationSingleFlightAndSafeMetadata(t *testing.T) {
	readStarted := make(chan struct{}, 1)
	readRelease := make(chan struct{})
	client := &fakeCodexAccountClient{
		reads:       []ports.CodexAccountObservation{{Authentication: domain.AgentAuthenticationAuthorized, Method: domain.CodexAuthMethodChatGPT, Email: ptr("person@example.com")}},
		readStarted: readStarted, readRelease: readRelease, events: make(chan ports.CodexAccountEvent),
	}
	factory := &fakeCodexAccountFactory{capabilities: supportedCodexProfileCapabilities(), open: func(ports.CodexAccountProfile) ports.CodexAccountClient { return client }}
	manager := newCodexProfileManager(context.Background(), t.TempDir(), t.TempDir(), factory, nil)
	record, _ := manager.catalog.record(codexExistingProfileID)
	results := make(chan domain.AgentAuthenticationObservation, 2)
	for range 2 {
		go func() {
			observation, _ := manager.ensureAuthentication(context.Background(), record, domain.AgentReadinessPurposeDisplay, false, false)
			results <- observation
		}()
	}
	<-readStarted
	close(readRelease)
	for range 2 {
		if got := <-results; got.State != domain.AgentAuthenticationAuthorized {
			t.Fatalf("authentication = %#v", got)
		}
	}
	if factory.opens != 1 {
		t.Fatalf("native opens = %d, want 1", factory.opens)
	}
	profile, _ := manager.catalog.record(codexExistingProfileID)
	if profile.Snapshot.AuthMethod != domain.CodexAuthMethodChatGPT || profile.Snapshot.AccountEmail == nil || *profile.Snapshot.AccountEmail != "person@example.com" {
		t.Fatalf("profile = %#v", profile.Snapshot)
	}
}

func TestCodexProfileLoginRequiresFinalAccountConfirmation(t *testing.T) {
	client := &fakeCodexAccountClient{
		reads: []ports.CodexAccountObservation{
			{Authentication: domain.AgentAuthenticationUnauthorized},
			{Authentication: domain.AgentAuthenticationAuthorized, Method: domain.CodexAuthMethodChatGPT, Email: ptr("person@example.com")},
		},
		events: make(chan ports.CodexAccountEvent, 1),
	}
	factory := &fakeCodexAccountFactory{capabilities: supportedCodexProfileCapabilities(), open: func(ports.CodexAccountProfile) ports.CodexAccountClient { return client }}
	manager := newCodexProfileManager(context.Background(), t.TempDir(), t.TempDir(), factory, nil)
	manager.newID = func() string { return "operation-1" }
	start, err := manager.startLogin(context.Background(), codexExistingProfileID)
	if err != nil {
		t.Fatal(err)
	}
	if start.Status != domain.CodexProfileLoginPending || start.AuthURL == "" {
		t.Fatalf("start = %#v", start)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	events, err := manager.subscribeLogin(ctx, codexExistingProfileID, start.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	if pending := <-events; pending.Status != domain.CodexProfileLoginPending {
		t.Fatalf("pending = %#v", pending)
	}
	client.events <- ports.CodexAccountEvent{Kind: ports.CodexAccountEventLoginCompleted, LoginID: "login-1", Success: true}
	completed := <-events
	if completed.Status != domain.CodexProfileLoginCompleted || completed.Profile == nil || completed.Profile.Authentication.State != domain.AgentAuthenticationAuthorized {
		t.Fatalf("completed = %#v", completed)
	}
}

func TestCodexProfileAuthenticationCancellationStopsWaitingNotSharedRead(t *testing.T) {
	readStarted := make(chan struct{}, 1)
	readRelease := make(chan struct{})
	client := &fakeCodexAccountClient{
		reads:       []ports.CodexAccountObservation{{Authentication: domain.AgentAuthenticationAuthorized}},
		readStarted: readStarted, readRelease: readRelease, events: make(chan ports.CodexAccountEvent),
	}
	factory := &fakeCodexAccountFactory{capabilities: supportedCodexProfileCapabilities(), open: func(ports.CodexAccountProfile) ports.CodexAccountClient { return client }}
	managerCtx, stop := context.WithCancel(context.Background())
	defer stop()
	manager := newCodexProfileManager(managerCtx, t.TempDir(), t.TempDir(), factory, nil)
	record, _ := manager.catalog.record(codexExistingProfileID)
	waitCtx, cancelWait := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, err := manager.ensureAuthentication(waitCtx, record, domain.AgentReadinessPurposeDisplay, false, false)
		result <- err
	}()
	<-readStarted
	cancelWait()
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatalf("waiting error = %v", err)
	}
	close(readRelease)
	deadline := time.After(time.Second)
	for {
		updated, _ := manager.catalog.record(codexExistingProfileID)
		if updated.Snapshot.Authentication.State == domain.AgentAuthenticationAuthorized {
			break
		}
		select {
		case <-deadline:
			t.Fatal("shared read did not finish after caller cancellation")
		default:
			time.Sleep(time.Millisecond)
		}
	}
}

func TestCodexProfileAuthenticationFailurePreservesKnownStateAsStale(t *testing.T) {
	client := &fakeCodexAccountClient{readErr: errors.New("refresh failed"), events: make(chan ports.CodexAccountEvent)}
	factory := &fakeCodexAccountFactory{capabilities: supportedCodexProfileCapabilities(), open: func(ports.CodexAccountProfile) ports.CodexAccountClient { return client }}
	managerCtx, stop := context.WithCancel(context.Background())
	defer stop()
	manager := newCodexProfileManager(managerCtx, t.TempDir(), t.TempDir(), factory, nil)
	checkedAt := time.Now().Add(-time.Hour).UTC()
	manager.catalog.updateSnapshot(codexExistingProfileID, func(profile *domain.CodexProfileSnapshot) {
		profile.Authentication = successfulAuthentication(checkedAt, domain.AgentAuthenticationAuthorized, domain.AgentReadinessReasonAuthorized, "signed in")
	})
	manager.invalidate(codexExistingProfileID)
	record, _ := manager.catalog.record(codexExistingProfileID)
	observation, err := manager.ensureAuthentication(context.Background(), record, domain.AgentReadinessPurposeDisplay, false, true)
	if err != nil {
		t.Fatal(err)
	}
	if observation.State != domain.AgentAuthenticationAuthorized || observation.Freshness != domain.AgentReadinessStale || observation.CheckedAt == nil || !observation.CheckedAt.Equal(checkedAt) {
		t.Fatalf("preserved authentication = %#v", observation)
	}
}

func TestCodexProfileLoginAllowsOnlyOneStartPerProfile(t *testing.T) {
	readStarted := make(chan struct{}, 1)
	readRelease := make(chan struct{})
	client := &fakeCodexAccountClient{
		reads:       []ports.CodexAccountObservation{{Authentication: domain.AgentAuthenticationUnauthorized}},
		readStarted: readStarted, readRelease: readRelease, events: make(chan ports.CodexAccountEvent),
	}
	factory := &fakeCodexAccountFactory{capabilities: supportedCodexProfileCapabilities(), open: func(ports.CodexAccountProfile) ports.CodexAccountClient { return client }}
	managerCtx, stop := context.WithCancel(context.Background())
	defer stop()
	manager := newCodexProfileManager(managerCtx, t.TempDir(), t.TempDir(), factory, nil)
	first := make(chan error, 1)
	go func() { _, err := manager.startLogin(context.Background(), codexExistingProfileID); first <- err }()
	<-readStarted
	_, err := manager.startLogin(context.Background(), codexExistingProfileID)
	var typed *apierr.Error
	if !errors.As(err, &typed) || typed.Code != "CODEX_PROFILE_LOGIN_IN_PROGRESS" {
		t.Fatalf("second login error = %#v", err)
	}
	close(readRelease)
	if err := <-first; err != nil {
		t.Fatalf("first login: %v", err)
	}
}

func TestEnsureBrokenCodexProfileSkipsNativeCapabilityAndAccountChecks(t *testing.T) {
	root := t.TempDir()
	factory := &fakeCodexAccountFactory{capabilities: supportedCodexProfileCapabilities(), open: func(ports.CodexAccountProfile) ports.CodexAccountClient { t.Fatal("opened broken profile"); return nil }}
	manager := newCodexProfileManager(context.Background(), root, t.TempDir(), factory, nil)
	manager.catalog.newID = func() string { return "72d4db6e-da2c-414c-a6a9-fdbd09a006b6" }
	record, err := manager.catalog.create("Broken")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(record.Home); err != nil {
		t.Fatal(err)
	}
	result, err := manager.ensure(context.Background(), []string{record.Snapshot.ID}, domain.AgentReadinessPurposeDisplay, domain.AgentInstallationUnknown)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Profiles) != 1 || result.Profiles[0].Status != domain.CodexProfileStatusBroken {
		t.Fatalf("profiles = %#v", result.Profiles)
	}
	if factory.capabilityChecks != 0 || factory.opens != 0 {
		t.Fatalf("native work = capabilities %d opens %d", factory.capabilityChecks, factory.opens)
	}
}

func ptr(value string) *string { return &value }
