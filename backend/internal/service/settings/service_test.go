package settings_test

import (
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	settingssvc "github.com/aoagents/agent-orchestrator/backend/internal/service/settings"
)

// Cloud is enabled only when all three gates hold: the flag is on, the client
// is the entitled one, and a control plane is configured. Any single missing
// gate must fail closed.
func TestOfferingFromConfigCloudEnabled(t *testing.T) {
	enabled := config.Config{
		Client:               config.ClientElevenX,
		CloudOffering:        true,
		CloudControlPlaneURL: "https://cp.example.com",
	}

	tests := []struct {
		name   string
		mutate func(cfg *config.Config)
		want   bool
	}{
		{"all three gates hold", func(*config.Config) {}, true},
		{"cloud offering flag off", func(cfg *config.Config) { cfg.CloudOffering = false }, false},
		{"client not entitled", func(cfg *config.Config) { cfg.Client = "other_client" }, false},
		{"client empty", func(cfg *config.Config) { cfg.Client = "" }, false},
		{"no control plane configured", func(cfg *config.Config) { cfg.CloudControlPlaneURL = "" }, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cfg := enabled
			tc.mutate(&cfg)
			offering := settingssvc.OfferingFromConfig(cfg)
			if offering.CloudEnabled != tc.want {
				t.Fatalf("CloudEnabled = %v, want %v", offering.CloudEnabled, tc.want)
			}
		})
	}
}

// The remaining gates pass through untransformed: local follows the config
// flag, and the client/control-plane identity is reported as configured so
// clients can name the deployment and dial the control plane.
func TestOfferingFromConfigPassthrough(t *testing.T) {
	offering := settingssvc.OfferingFromConfig(config.Config{
		Client:               config.ClientElevenX,
		CloudOffering:        true,
		LocalOffering:        false,
		CloudControlPlaneURL: "https://cp.example.com",
	})
	if offering.Client != config.ClientElevenX {
		t.Errorf("Client = %q, want %q", offering.Client, config.ClientElevenX)
	}
	if offering.LocalEnabled {
		t.Error("LocalEnabled = true, want false")
	}
	if offering.CloudControlPlaneURL != "https://cp.example.com" {
		t.Errorf("CloudControlPlaneURL = %q, want https://cp.example.com", offering.CloudControlPlaneURL)
	}
}

// The service hands back exactly the offering it was built with: gates are
// boot-time config, never recomputed or mutated per request.
func TestServiceOffering(t *testing.T) {
	want := settingssvc.Offering{
		Client:               config.ClientElevenX,
		LocalEnabled:         true,
		CloudEnabled:         true,
		CloudControlPlaneURL: "https://cp.example.com",
	}
	svc := settingssvc.New(nil, nil, want, nil)
	if got := svc.Offering(); got != want {
		t.Fatalf("Offering() = %+v, want %+v", got, want)
	}
}
