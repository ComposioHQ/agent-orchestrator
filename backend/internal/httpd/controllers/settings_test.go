package controllers_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	settingssvc "github.com/aoagents/agent-orchestrator/backend/internal/service/settings"
)

type fakeSettingsService struct {
	snapshot settingssvc.Snapshot
	offering settingssvc.Offering
}

func (f *fakeSettingsService) Get(context.Context) (settingssvc.Snapshot, error) {
	return f.snapshot, nil
}

func (f *fakeSettingsService) SetDefaultSessionMode(_ context.Context, mode domain.SessionMode) (settingssvc.Snapshot, error) {
	f.snapshot.DefaultSessionMode = mode
	return f.snapshot, nil
}

func (f *fakeSettingsService) ChatHarnesses([]domain.AgentHarness) []domain.AgentHarness {
	return nil
}

func (f *fakeSettingsService) Offering() settingssvc.Offering {
	return f.offering
}

func newSettingsTestServer(t *testing.T, svc *fakeSettingsService) *httptest.Server {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{Settings: svc}, httpd.ControlDeps{}))
	t.Cleanup(srv.Close)
	return srv
}

type settingsWireResponse struct {
	DefaultSessionMode   string `json:"defaultSessionMode"`
	Client               string `json:"client"`
	LocalEnabled         bool   `json:"localEnabled"`
	CloudEnabled         bool   `json:"cloudEnabled"`
	CloudControlPlaneURL string `json:"cloudControlPlaneUrl"`
}

// cloudEnabled reaches the wire only when all three gates hold: the cloud
// offering flag, the entitled client, and a configured control plane. Each
// missing gate must report cloud off.
func TestSettingsAPIGatesCloudOffering(t *testing.T) {
	enabled := config.Config{
		Client:               config.ClientElevenX,
		CloudOffering:        true,
		LocalOffering:        true,
		CloudControlPlaneURL: "https://cp.example.com",
	}

	tests := []struct {
		name             string
		mutate           func(cfg *config.Config)
		wantCloudEnabled bool
	}{
		{"all three gates hold", func(*config.Config) {}, true},
		{"cloud offering flag off", func(cfg *config.Config) { cfg.CloudOffering = false }, false},
		{"client not entitled", func(cfg *config.Config) { cfg.Client = "other_client" }, false},
		{"no control plane configured", func(cfg *config.Config) { cfg.CloudControlPlaneURL = "" }, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cfg := enabled
			tc.mutate(&cfg)
			svc := &fakeSettingsService{
				snapshot: settingssvc.Snapshot{DefaultSessionMode: domain.DefaultSessionMode},
				offering: settingssvc.OfferingFromConfig(cfg),
			}
			srv := newSettingsTestServer(t, svc)

			body, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/settings", "")
			if status != http.StatusOK {
				t.Fatalf("status = %d, want 200; body=%s", status, body)
			}
			var got settingsWireResponse
			mustJSON(t, body, &got)
			if got.CloudEnabled != tc.wantCloudEnabled {
				t.Fatalf("cloudEnabled = %v, want %v; body=%s", got.CloudEnabled, tc.wantCloudEnabled, body)
			}
		})
	}
}

// The offering fields ride on the same settings snapshot the endpoint already
// serves, so one GET tells a client both its preferences and its gates.
func TestSettingsAPIReportsOfferingFields(t *testing.T) {
	svc := &fakeSettingsService{
		snapshot: settingssvc.Snapshot{DefaultSessionMode: domain.DefaultSessionMode},
		offering: settingssvc.OfferingFromConfig(config.Config{
			Client:               config.ClientElevenX,
			CloudOffering:        true,
			LocalOffering:        false,
			CloudControlPlaneURL: "https://cp.example.com",
		}),
	}
	srv := newSettingsTestServer(t, svc)

	body, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/settings", "")
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	var got settingsWireResponse
	mustJSON(t, body, &got)
	if got.DefaultSessionMode != string(domain.DefaultSessionMode) {
		t.Errorf("defaultSessionMode = %q, want %q", got.DefaultSessionMode, domain.DefaultSessionMode)
	}
	if got.Client != config.ClientElevenX {
		t.Errorf("client = %q, want %q", got.Client, config.ClientElevenX)
	}
	if got.LocalEnabled {
		t.Error("localEnabled = true, want false")
	}
	if !got.CloudEnabled {
		t.Error("cloudEnabled = false, want true")
	}
	if got.CloudControlPlaneURL != "https://cp.example.com" {
		t.Errorf("cloudControlPlaneUrl = %q, want https://cp.example.com", got.CloudControlPlaneURL)
	}
}
