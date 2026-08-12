package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Untrivial-ai/ao-cloud/internal/worker"
	"github.com/aoagents/agent-orchestrator/backend/pkg/contract"
)

func TestCommandsUseControlPlaneWorkerAPI(t *testing.T) {
	tokenFile := filepath.Join(t.TempDir(), "worker-token")
	if err := os.WriteFile(tokenFile, []byte("rotating-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var routes []string
	var spawnBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Worker rotating-token" {
			t.Errorf("authorization = %q", r.Header.Get("Authorization"))
		}
		if r.Method == http.MethodPost && r.Header.Get("Idempotency-Key") == "" {
			t.Errorf("%s has no idempotency key", r.URL.Path)
		}
		mu.Lock()
		routes = append(routes, r.Method+" "+r.URL.Path)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/cloud/v1/worker/children":
			if err := json.NewDecoder(r.Body).Decode(&spawnBody); err != nil {
				t.Errorf("decode spawn body: %v", err)
			}
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"session": map[string]any{
					"id": "child-1", "status": "provisioning",
				},
			})
		case r.Method == http.MethodGet && r.URL.Path == "/api/cloud/v1/worker/children":
			_ = json.NewEncoder(w).Encode(map[string]any{"items": []any{}})
		default:
			w.WriteHeader(http.StatusAccepted)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
		}
	}))
	defer server.Close()
	t.Setenv("AO_CLOUD_WORKER_API_URL", server.URL+"/api/cloud/v1")
	t.Setenv("AO_CLOUD_WORKER_TOKEN_FILE", tokenFile)

	for _, args := range [][]string{
		{"spawn", "--name", "Research", "--prompt", "Inspect auth"},
		{"list"},
		{"send", "child-1", "Report status"},
		{"kill", "child-1"},
	} {
		if err := run(args); err != nil {
			t.Fatalf("run(%q): %v", args, err)
		}
	}
	want := []string{
		"POST /api/cloud/v1/worker/children",
		"GET /api/cloud/v1/worker/children",
		"POST /api/cloud/v1/worker/children/child-1/messages",
		"DELETE /api/cloud/v1/worker/children/child-1",
	}
	mu.Lock()
	defer mu.Unlock()
	if len(routes) != len(want) {
		t.Fatalf("routes = %q, want %q", routes, want)
	}
	for index := range want {
		if routes[index] != want[index] {
			t.Fatalf("route %d = %q, want %q", index, routes[index], want[index])
		}
	}
	if spawnBody["mode"] != "trusted" || spawnBody["prompt"] != "Inspect auth" {
		t.Fatalf("spawn body = %#v", spawnBody)
	}
}

func TestSpawnRequiresInitialPrompt(t *testing.T) {
	t.Setenv("AO_CLOUD_WORKER_API_URL", "http://127.0.0.1:1")
	t.Setenv("AO_CLOUD_WORKER_TOKEN_FILE", filepath.Join(t.TempDir(), "worker-token"))

	err := run([]string{"spawn", "--name", "Missing task"})
	if err == nil || err.Error() != "spawn requires --prompt" {
		t.Fatalf("error = %v, want prompt requirement", err)
	}
}

func TestRunHookPublishesExplicitActivityWithoutBreakingAgent(t *testing.T) {
	tokenFile := filepath.Join(t.TempDir(), "worker-token")
	if err := os.WriteFile(tokenFile, []byte("rotating-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	var event worker.EventRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/cloud/v1/worker/events" {
			t.Fatalf("path = %q", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&event); err != nil {
			t.Fatal(err)
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()
	client := &client{
		baseURL:   server.URL + "/api/cloud/v1",
		tokenFile: tokenFile,
		http:      &http.Client{Timeout: time.Second},
	}

	if err := runHook(
		context.Background(),
		client,
		[]string{"claude-code", "permission-request"},
		strings.NewReader(`{"tool_name":"Bash","tool_use_id":"tool-1"}`),
	); err != nil {
		t.Fatal(err)
	}
	if event.Type != "agent.activity" {
		t.Fatalf("event type = %q", event.Type)
	}
	payload, err := json.Marshal(event.Payload)
	if err != nil {
		t.Fatal(err)
	}
	var activity worker.ActivityEvent
	if err := json.Unmarshal(payload, &activity); err != nil {
		t.Fatal(err)
	}
	if activity.State != contract.ActivityBlocked ||
		activity.ToolName != "Bash" ||
		activity.ToolUseID != "tool-1" {
		t.Fatalf("activity = %#v", activity)
	}
}
