package coder

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/cloud/internal/sandbox"
	"github.com/google/uuid"
)

// TestLiveLifecycle exercises the real Coder API when explicitly configured.
// It is skipped in ordinary and CI test runs and always requests workspace
// deletion before returning.
func TestLiveLifecycle(t *testing.T) {
	baseURL := os.Getenv("CODER_LIVE_URL")
	if baseURL == "" {
		t.Skip("CODER_LIVE_URL is not set")
	}
	parameters := map[string]string{}
	if raw := os.Getenv("CODER_LIVE_PARAMETERS_JSON"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &parameters); err != nil {
			t.Fatalf("decode CODER_LIVE_PARAMETERS_JSON: %v", err)
		}
	}
	client, err := New(Config{
		BaseURL: baseURL, Token: os.Getenv("CODER_LIVE_TOKEN"),
		Owner: os.Getenv("CODER_LIVE_OWNER"), TemplateID: os.Getenv("CODER_LIVE_TEMPLATE_ID"),
		AgentName: os.Getenv("CODER_LIVE_AGENT_NAME"), Parameters: parameters,
	})
	if err != nil {
		t.Fatalf("new live client: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
	defer cancel()
	sessionID := "live-" + uuid.NewString()
	environment, err := client.Create(ctx, sandbox.Spec{SessionID: sessionID})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	t.Logf("created workspace %s", environment.ID)
	deleted := false
	defer func() {
		if !deleted {
			cleanupContext, cleanupCancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cleanupCancel()
			if cleanupErr := client.Delete(cleanupContext, environment.ID); cleanupErr != nil {
				t.Errorf("cleanup workspace %s: %v", environment.ID, cleanupErr)
			}
		}
	}()

	environment = waitForState(t, ctx, client, environment.ID, sandbox.StateRunning)
	if environment.Target == "" {
		t.Fatal("running workspace carried no healthy agent target")
	}
	bootstrapFailure := client.BootstrapWorker(ctx, environment.ID, sandbox.WorkerBootstrap{
		Binary: []byte("#!/bin/sh\nexit 0\n"), Destination: "/proc/ao-worker", User: "ao-worker",
		Environment: map[string]string{"AO_CODER_LIVE_TEST": "expected-install-failure"},
	})
	if bootstrapFailure == nil {
		t.Fatal("bootstrap to unwritable destination succeeded")
	}
	if !strings.Contains(bootstrapFailure.Error(), bootstrapFailed) {
		t.Fatalf("bootstrap to unwritable destination did not report post-upload failure: %v", bootstrapFailure)
	}
	t.Log("observed expected post-upload bootstrap failure")
	if err := client.BootstrapWorker(ctx, environment.ID, sandbox.WorkerBootstrap{
		Binary:      []byte("#!/bin/sh\nmkdir -p /workspace/.ao/worker\necho live > /workspace/.ao/worker/coder-live-test\nsleep 300\n"),
		Destination: "/usr/local/bin/ao-worker", User: "ao-worker",
		Environment: map[string]string{"AO_CODER_LIVE_TEST": "true"},
	}); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	if err := client.Stop(ctx, environment.ID); err != nil {
		t.Fatalf("stop: %v", err)
	}
	waitForState(t, ctx, client, environment.ID, sandbox.StateStopped)
	if err := client.Start(ctx, environment.ID); err != nil {
		t.Fatalf("start: %v", err)
	}
	waitForState(t, ctx, client, environment.ID, sandbox.StateRunning)
	if err := client.Delete(ctx, environment.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	waitForDeleted(t, ctx, client, environment.ID)
	deleted = true
}

func waitForState(t *testing.T, ctx context.Context, client *Client, id sandbox.ID, state string) sandbox.Environment {
	t.Helper()
	for {
		environment, err := client.Get(ctx, id)
		if err != nil {
			t.Fatalf("get workspace while waiting for %s: %v", state, err)
		}
		if environment.State == state {
			return environment
		}
		select {
		case <-ctx.Done():
			t.Fatalf("wait for workspace %s: %v", state, ctx.Err())
		case <-time.After(5 * time.Second):
		}
	}
}

func waitForDeleted(t *testing.T, ctx context.Context, client *Client, id sandbox.ID) {
	t.Helper()
	for {
		environment, err := client.Get(ctx, id)
		if errors.Is(err, sandbox.ErrNotFound) || (err == nil && environment.State == sandbox.StateDeleted) {
			return
		}
		if err != nil {
			t.Fatalf("get workspace while waiting for deletion: %v", err)
		}
		select {
		case <-ctx.Done():
			t.Fatalf("wait for workspace deletion: %v", ctx.Err())
		case <-time.After(5 * time.Second):
		}
	}
}
