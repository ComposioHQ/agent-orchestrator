//go:build integration

package daytona

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/runtime"
)

// TestStagingLifecycle is intentionally opt-in because it creates billable
// provider compute. It exercises the same HTTP adapter used in production,
// including bootstrap execution and lifecycle idempotency.
func TestStagingLifecycle(t *testing.T) {
	keyPath := strings.TrimSpace(os.Getenv("AO_CLOUD_DAYTONA_API_KEY_FILE"))
	snapshot := strings.TrimSpace(os.Getenv("AO_CLOUD_WORKER_SNAPSHOT"))
	if keyPath == "" || snapshot == "" {
		t.Skip("AO_CLOUD_DAYTONA_API_KEY_FILE and AO_CLOUD_WORKER_SNAPSHOT are required")
	}
	key, err := os.ReadFile(keyPath)
	if err != nil {
		t.Fatal(err)
	}
	defer clear(key)
	provider, err := New(Options{
		BaseURL:        os.Getenv("AO_CLOUD_DAYTONA_API_URL"),
		APIKey:         strings.TrimSpace(string(key)),
		OrganizationID: os.Getenv("AO_CLOUD_DAYTONA_ORGANIZATION_ID"),
		Target:         os.Getenv("AO_CLOUD_DAYTONA_TARGET"),
		Timeout:        2 * time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}

	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	ref := runtime.Ref{OrgID: "staging", WorkspaceID: "provider-acceptance", SessionID: "session-" + suffix, UserID: "acceptance", Role: runtime.RoleWorker}
	request := runtime.CreateRequest{
		Ref: ref, Labels: runtime.Labels("staging-acceptance", ref, "runtime-"+suffix),
		Snapshot: snapshot, CapabilityFilePath: runtime.CapabilityFilePath,
		ControlPlaneRedeemURL: "https://control.staging.example/api/internal/sandbox-tickets/redeem",
		SecretFiles:           []runtime.FileSecret{{Path: "/run/ao/acceptance-ticket", Content: []byte("one-time-staging-acceptance-ticket"), Mode: 0o600}},
		Command:               "/bin/sh", Args: []string{"-c", "while :; do sleep 60; done"},
		AutoStopInterval: 15 * time.Minute, AutoDeleteInterval: time.Hour,
		IdempotencyKey: "ao-provider-acceptance-" + suffix,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()
	sandbox, err := provider.Create(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cleanupCancel()
		if err := provider.Delete(cleanupCtx, sandbox.ID); err != nil {
			t.Errorf("cleanup sandbox: %v", err)
		}
	})
	if _, err := provider.Get(ctx, sandbox.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := provider.Stop(ctx, sandbox.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := provider.Stop(ctx, sandbox.ID); err != nil {
		t.Fatalf("idempotent stop: %v", err)
	}
	if _, err := provider.Start(ctx, sandbox.ID, runtime.StartRequest{
		Ref: ref, CapabilityFilePath: runtime.CapabilityFilePath,
		ControlPlaneRedeemURL: "https://control.staging.example/api/internal/sandbox-tickets/redeem",
		SecretFiles:           []runtime.FileSecret{{Path: "/run/ao/acceptance-ticket", Content: []byte("fresh-staging-acceptance-ticket"), Mode: 0o600}},
		Command:               "/bin/sh", Args: []string{"-c", "while :; do sleep 60; done"}, BootstrapKey: "restart-" + suffix,
	}); err != nil {
		t.Fatal(err)
	}
	if err := provider.Delete(ctx, sandbox.ID); err != nil {
		t.Fatal(err)
	}
	if err := provider.Delete(ctx, sandbox.ID); err != nil {
		t.Fatalf("idempotent delete: %v", err)
	}
}
