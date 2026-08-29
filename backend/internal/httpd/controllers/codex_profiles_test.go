package controllers_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	agentsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/agent"
)

type fakeCodexProfiles struct {
	result            agentsvc.CodexProfiles
	ensureIDs         []string
	ensurePurpose     domain.AgentReadinessPurpose
	capacityEnsureIDs []string
	events            chan domain.CodexProfileLoginEvent
	capacityEvents    chan agentsvc.CodexProfileCapacityEvent
}

func (f *fakeCodexProfiles) CachedCodexProfiles(context.Context) (agentsvc.CodexProfiles, error) {
	return f.result, nil
}
func (f *fakeCodexProfiles) EnsureCodexProfiles(_ context.Context, ids []string, purpose domain.AgentReadinessPurpose) (agentsvc.CodexProfiles, error) {
	f.ensureIDs, f.ensurePurpose = ids, purpose
	return f.result, nil
}
func (f *fakeCodexProfiles) EnsureCodexProfileCapacity(_ context.Context, ids []string) (agentsvc.CodexProfiles, error) {
	f.capacityEnsureIDs = ids
	return f.result, nil
}
func (f *fakeCodexProfiles) SubscribeCodexProfileCapacity(ctx context.Context) (<-chan agentsvc.CodexProfileCapacityEvent, error) {
	if f.capacityEvents != nil {
		return f.capacityEvents, nil
	}
	ch := make(chan agentsvc.CodexProfileCapacityEvent)
	go func() { <-ctx.Done(); close(ch) }()
	return ch, nil
}
func (f *fakeCodexProfiles) CreateCodexProfile(_ context.Context, label string) (domain.CodexProfileSnapshot, error) {
	profile := f.result.Profiles[0]
	profile.Label = label
	return profile, nil
}
func (f *fakeCodexProfiles) StartCodexProfileLogin(_ context.Context, profileID string) (agentsvc.CodexProfileLoginStart, error) {
	return agentsvc.CodexProfileLoginStart{OperationID: "op-1", ProfileID: profileID, Status: domain.CodexProfileLoginPending, AuthURL: "https://auth.example.test"}, nil
}
func (f *fakeCodexProfiles) SubscribeCodexProfileLogin(context.Context, string, string) (<-chan domain.CodexProfileLoginEvent, error) {
	return f.events, nil
}
func (f *fakeCodexProfiles) CancelCodexProfileLogin(_ context.Context, profileID, operationID string) (domain.CodexProfileLoginEvent, error) {
	return domain.CodexProfileLoginEvent{OperationID: operationID, ProfileID: profileID, Status: domain.CodexProfileLoginCancelled, ReasonCode: domain.CodexProfileLoginReasonCancelled, Reason: "cancelled"}, nil
}

func codexProfilesFixture() agentsvc.CodexProfiles {
	return agentsvc.CodexProfiles{
		Profiles: []domain.CodexProfileSnapshot{{
			ID: "existing", Label: "Existing Codex profile", Source: domain.CodexProfileSourceExisting,
			Status: domain.CodexProfileStatusValid, ReasonCode: domain.CodexProfileReasonValid, Reason: "available",
			Authentication: domain.AgentAuthenticationObservation{State: domain.AgentAuthenticationAuthorized, Freshness: domain.AgentReadinessFresh, ReasonCode: domain.AgentReadinessReasonAuthorized, Reason: "signed in"},
			AuthMethod:     domain.CodexAuthMethodChatGPT, UsableByCurrentLaunches: true,
			Capacity: domain.CodexCapacitySnapshot{State: domain.CodexCapacityAvailable, Freshness: domain.AgentReadinessFresh,
				ReasonCode: domain.CodexCapacityReasonAvailable, Reason: "available", AdditionalBuckets: []domain.CodexCapacityBucket{}},
		}},
		Capabilities: domain.CodexProfileCapabilities{
			AccountRead:  domain.CodexCapabilityObservation{State: domain.CodexCapabilitySupported, ReasonCode: "supported", Reason: "available"},
			BrowserLogin: domain.CodexCapabilityObservation{State: domain.CodexCapabilitySupported, ReasonCode: "supported", Reason: "available"},
			CapacityRead: domain.CodexCapabilityObservation{State: domain.CodexCapabilitySupported, ReasonCode: "supported", Reason: "available"},
		},
	}
}

func TestCodexProfileRoutesExposeSafeCachedAndEnsureShapes(t *testing.T) {
	fake := &fakeCodexProfiles{result: codexProfilesFixture()}
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, slog.New(slog.DiscardHandler), nil, httpd.APIDeps{CodexProfiles: fake}, httpd.ControlDeps{}))
	defer srv.Close()
	body, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/agents/codex/profiles", "")
	bodyText := string(body)
	if status != http.StatusOK || !strings.Contains(bodyText, `"id":"existing"`) || !strings.Contains(bodyText, `"accountRead"`) {
		t.Fatalf("GET status=%d body=%s", status, body)
	}
	for _, forbidden := range []string{"authUrl", "homePath", "planType", "quota"} {
		if strings.Contains(bodyText, forbidden) {
			t.Fatalf("GET leaked %q: %s", forbidden, body)
		}
	}
	body, status, _ = doRequest(t, srv, http.MethodPost, "/api/v1/agents/codex/profiles/ensure", `{"profileIds":["existing","existing"],"purpose":"display"}`)
	if status != http.StatusOK {
		t.Fatalf("ensure status=%d body=%s", status, body)
	}
	if len(fake.ensureIDs) != 2 || fake.ensurePurpose != domain.AgentReadinessPurposeDisplay {
		t.Fatalf("ensure args = %#v %q", fake.ensureIDs, fake.ensurePurpose)
	}
	body, status, _ = doRequest(t, srv, http.MethodPost, "/api/v1/agents/codex/profiles/capacity/ensure", `{"profileIds":["existing","existing"]}`)
	if status != http.StatusOK || len(fake.capacityEnsureIDs) != 2 {
		t.Fatalf("capacity ensure status=%d ids=%#v body=%s", status, fake.capacityEnsureIDs, body)
	}
}

func TestCodexProfileCapacityStreamSendsNamedCachedEvent(t *testing.T) {
	events := make(chan agentsvc.CodexProfileCapacityEvent, 1)
	snapshot := codexProfilesFixture().Profiles[0].Capacity
	events <- agentsvc.CodexProfileCapacityEvent{ProfileID: "existing", Capacity: &snapshot}
	close(events)
	fake := &fakeCodexProfiles{result: codexProfilesFixture(), capacityEvents: events}
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, slog.New(slog.DiscardHandler), nil, httpd.APIDeps{CodexProfiles: fake}, httpd.ControlDeps{}))
	defer srv.Close()
	response, err := http.Get(srv.URL + "/api/v1/agents/codex/profiles/capacity/events")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	if response.StatusCode != http.StatusOK || !strings.Contains(text, "event: codex_profile_capacity") || !strings.Contains(text, `"profileId":"existing"`) {
		t.Fatalf("status=%d body=%s", response.StatusCode, text)
	}
}

func TestCreateCodexProfileReturnsCreatedSnapshotWithoutFilesystemFields(t *testing.T) {
	fake := &fakeCodexProfiles{result: codexProfilesFixture()}
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, slog.New(slog.DiscardHandler), nil, httpd.APIDeps{CodexProfiles: fake}, httpd.ControlDeps{}))
	defer srv.Close()
	body, status, _ := doRequest(t, srv, http.MethodPost, "/api/v1/agents/codex/profiles", `{"label":"Work"}`)
	if status != http.StatusCreated || !strings.Contains(string(body), `"label":"Work"`) || strings.Contains(string(body), `"profile":`) {
		t.Fatalf("create status=%d body=%s", status, body)
	}
	for _, forbidden := range []string{"home", "path", "token", "quota"} {
		if strings.Contains(strings.ToLower(string(body)), forbidden) {
			t.Fatalf("create leaked %q: %s", forbidden, body)
		}
	}
}

func TestCodexProfileLoginStreamSendsNamedCurrentEvent(t *testing.T) {
	events := make(chan domain.CodexProfileLoginEvent, 1)
	events <- domain.CodexProfileLoginEvent{OperationID: "op-1", ProfileID: "existing", Status: domain.CodexProfileLoginPending, ReasonCode: domain.CodexProfileLoginReasonPending, Reason: "waiting"}
	close(events)
	fake := &fakeCodexProfiles{result: codexProfilesFixture(), events: events}
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, slog.New(slog.DiscardHandler), nil, httpd.APIDeps{CodexProfiles: fake}, httpd.ControlDeps{}))
	defer srv.Close()
	response, err := http.Get(srv.URL + "/api/v1/agents/codex/profiles/existing/login/op-1/events")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	if response.StatusCode != http.StatusOK || !strings.Contains(text, "event: codex_profile_login") || !strings.Contains(text, `"status":"pending"`) {
		t.Fatalf("status=%d body=%s", response.StatusCode, text)
	}
}
