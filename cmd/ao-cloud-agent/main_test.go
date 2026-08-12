package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestCommandsUseControlPlaneWorkerAPI(t *testing.T) {
	tokenFile := filepath.Join(t.TempDir(), "worker-token")
	if err := os.WriteFile(tokenFile, []byte("rotating-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var routes []string
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
}
