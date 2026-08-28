package agentswitch

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestHeadlessAuthorityTruthTable(t *testing.T) {
	tests := []struct {
		name, file         string
		explicit, envOn    bool
		wantEnabled        bool
		wantFileGeneration bool
	}{
		{name: "valid off always off", file: "off", explicit: true, envOn: true},
		{name: "valid on and explicit environment on", file: "on", explicit: true, envOn: true, wantEnabled: true, wantFileGeneration: true},
		{name: "valid on without explicit environment is off", file: "on", envOn: true},
		{name: "valid on and explicit environment off is off", file: "on", explicit: true},
		{name: "missing and explicit on uses boot token", explicit: true, envOn: true, wantEnabled: true},
		{name: "missing without explicit on is off"},
		{name: "malformed is off even with explicit on", file: "malformed", explicit: true, envOn: true},
		{name: "unsafe is off even with explicit on", file: "unsafe", explicit: true, envOn: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			generation := "7f80c8a9-ec67-4a16-a067-a444ffcc5cca"
			path := filepath.Join(dir, PolicyFileName)
			switch tc.file {
			case "on", "off":
				writePolicy(t, path, tc.file == "on", generation, 0o600)
			case "malformed":
				if err := os.WriteFile(path, []byte("not-json"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "unsafe":
				writePolicy(t, path, true, generation, 0o644)
			}
			store := &policyStoreFake{}
			coordinator := NewPolicyCoordinator(store, PolicyOptions{
				DataDir: dir, TelemetryEvents: tc.envOn, TelemetryEventsExplicit: tc.explicit,
				DestinationFingerprint: "destination", ProductionEnabled: boolPtr(true),
				Metadata: validMetadata(), NewBootToken: func() string { return "boot-token" },
			})
			if err := coordinator.ForceDisabled(context.Background()); err != nil {
				t.Fatal(err)
			}
			if err := coordinator.Synchronize(context.Background()); err != nil {
				t.Fatal(err)
			}
			got := coordinator.Authorization()
			if got.Enabled != tc.wantEnabled {
				t.Fatalf("Enabled = %v, want %v", got.Enabled, tc.wantEnabled)
			}
			if tc.wantFileGeneration && got.ConsentGeneration != generation {
				t.Fatalf("generation = %q", got.ConsentGeneration)
			}
			if tc.wantEnabled && !tc.wantFileGeneration && got.ConsentGeneration != "boot-token" {
				t.Fatalf("boot generation = %q", got.ConsentGeneration)
			}
		})
	}
}

func TestApplyPolicyTreatsBodyAsHintAndCannotForgeEnablement(t *testing.T) {
	dir := t.TempDir()
	generation := "7f80c8a9-ec67-4a16-a067-a444ffcc5cca"
	writePolicy(t, filepath.Join(dir, PolicyFileName), false, generation, 0o600)
	store := &policyStoreFake{}
	coordinator := NewPolicyCoordinator(store, PolicyOptions{DataDir: dir, TelemetryEvents: true, TelemetryEventsExplicit: true, DestinationFingerprint: "destination", ProductionEnabled: boolPtr(true), Metadata: validMetadata()})
	if err := coordinator.ApplyPolicy(context.Background(), generation, true); err == nil {
		t.Fatal("forged enabled hint was accepted for an off authority file")
	}
	if got := coordinator.Authorization(); got.Enabled {
		t.Fatal("forged hint opened the gate")
	}
}

func TestGateChangeCancelsAndAwaitsRegisteredDeliveryWithoutInventingGeneration(t *testing.T) {
	dir := t.TempDir()
	generation := "7f80c8a9-ec67-4a16-a067-a444ffcc5cca"
	writePolicy(t, filepath.Join(dir, PolicyFileName), true, generation, 0o600)
	store := &policyStoreFake{}
	coordinator := NewPolicyCoordinator(store, PolicyOptions{DataDir: dir, TelemetryEvents: true, TelemetryEventsExplicit: true, DestinationFingerprint: "destination", ProductionEnabled: boolPtr(true), Metadata: validMetadata()})
	if err := coordinator.Synchronize(context.Background()); err != nil {
		t.Fatal(err)
	}
	epoch := coordinator.DeliveryEpoch()
	callContext, release, ok := coordinator.EnterDelivery(context.Background(), generation, epoch)
	if !ok {
		t.Fatal("delivery gate rejected matching authority")
	}
	done := make(chan struct{})
	go func() { <-callContext.Done(); release(); close(done) }()
	writePolicy(t, filepath.Join(dir, PolicyFileName), false, "19549322-5832-4d4e-9206-7268e0228db3", 0o600)
	if err := coordinator.Synchronize(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("gate close did not await the registered call")
	}
	if coordinator.DeliveryEpoch() != epoch+1 {
		t.Fatalf("delivery epoch did not advance exactly once")
	}
	if got := coordinator.Authorization().ConsentGeneration; got != "19549322-5832-4d4e-9206-7268e0228db3" {
		t.Fatalf("generation = %q", got)
	}
}

type policyStoreFake struct {
	forced   int
	applied  []ports.AgentSwitchFailurePolicy
	metadata bool
}

func (s *policyStoreFake) ConfigureAgentSwitchFailureEventMetadata(_ context.Context, metadata domain.AgentSwitchEventMetadata) error {
	s.metadata = domain.ValidateAgentSwitchEventMetadata(metadata) == nil
	return domain.ValidateAgentSwitchEventMetadata(metadata)
}
func (s *policyStoreFake) ForceDisableAgentSwitchFailurePolicy(context.Context, time.Time) error {
	s.forced++
	return nil
}
func (s *policyStoreFake) ApplyAgentSwitchFailurePolicy(_ context.Context, policy ports.AgentSwitchFailurePolicy) error {
	s.applied = append(s.applied, policy)
	return nil
}
func (s *policyStoreFake) PurgeAgentSwitchFailurePayloads(context.Context) (int64, error) {
	return 0, nil
}
func (s *policyStoreFake) EnrollCurrentAgentSwitchRecoveryMarkers(context.Context, ports.AgentSwitchFailureRecoveryEnrollment) (int64, error) {
	return 0, nil
}

func validMetadata() domain.AgentSwitchEventMetadata {
	return domain.AgentSwitchEventMetadata{Release: "1.2.3", Environment: domain.AgentSwitchEnvironmentStable, Channel: domain.AgentSwitchChannelStable, Platform: domain.AgentSwitchPlatformDaemon, OS: domain.AgentSwitchOSLinux, ElapsedTimeBucket: domain.AgentSwitchElapsedNotApplicable}
}
func boolPtr(value bool) *bool { return &value }
func writePolicy(t *testing.T, path string, enabled bool, generation string, mode os.FileMode) {
	t.Helper()
	record := policyDiskRecord{SchemaVersion: 1, EventsEnabled: enabled, ConsentGeneration: generation, UpdatedAt: "2026-08-28T10:15:30.000Z"}
	raw, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}
