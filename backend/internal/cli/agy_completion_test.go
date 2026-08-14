package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestSelectAgyCompletionOrchestratorPrefersNewestSafeSession(t *testing.T) {
	old := time.Date(2026, 8, 14, 10, 0, 0, 0, time.UTC)
	newer := old.Add(time.Minute)
	sessions := []sessionDTO{
		{ID: "worker-1", ProjectID: "mer", Kind: string(domain.KindWorker), Harness: "agy", Activity: sessionActivity{State: string(domain.ActivityIdle)}, UpdatedAt: newer},
		{ID: "orch-blocked", ProjectID: "mer", Kind: string(domain.KindOrchestrator), Harness: "codex", Activity: sessionActivity{State: string(domain.ActivityBlocked)}, UpdatedAt: newer.Add(time.Minute)},
		{ID: "orch-old", ProjectID: "mer", Kind: string(domain.KindOrchestrator), Harness: "claude-code", Activity: sessionActivity{State: string(domain.ActivityIdle)}, UpdatedAt: old},
		{ID: "orch-new", ProjectID: "mer", Kind: string(domain.KindOrchestrator), Harness: "codex", Activity: sessionActivity{State: string(domain.ActivityActive)}, UpdatedAt: newer},
	}

	got, ok := selectAgyCompletionOrchestrator(sessions, "worker-1")
	if !ok {
		t.Fatal("expected a safe orchestrator")
	}
	if got.ID != "orch-new" {
		t.Fatalf("orchestrator = %q, want orch-new", got.ID)
	}
}

func TestSelectAgyCompletionOrchestratorRejectsUnsafeActiveHarness(t *testing.T) {
	sessions := []sessionDTO{{
		ID: "orch-1", ProjectID: "mer", Kind: string(domain.KindOrchestrator), Harness: "claude-code",
		Activity: sessionActivity{State: string(domain.ActivityActive)},
	}}
	if got, ok := selectAgyCompletionOrchestrator(sessions, "worker-1"); ok {
		t.Fatalf("unexpected orchestrator %+v", got)
	}
}

func TestFormatAgyCompletionMessageSeparatesExecutionFromTaskSuccess(t *testing.T) {
	msg := formatAgyCompletionMessage("worker-1", hookConversationSnapshot{
		LatestUserPrompt:      "rebase PR #135",
		LatestAssistantUpdate: "Rebased and resolved conflicts.",
	})
	for _, want := range []string{
		"Worker worker-1 reached its AfterAgent execution boundary",
		"does not prove the requested task succeeded",
		"rebase PR #135",
		"Rebased and resolved conflicts.",
	} {
		if !strings.Contains(msg, want) {
			t.Fatalf("message %q does not contain %q", msg, want)
		}
	}
}

func TestHooksAgyAfterAgentRelaysFinalResultToCodexOrchestrator(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "worker-1")
	t.Setenv("AO_PROJECT_ID", "mer")
	t.Setenv("AO_RUNTIME_LAUNCH_ID", "launch-1")
	cfg := setConfigEnv(t)

	var (
		mu              sync.Mutex
		activityRequest setActivityAPIRequest
		relayRequest    sendAPIRequest
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/sessions/worker-1/activity":
			if err := json.NewDecoder(r.Body).Decode(&activityRequest); err != nil {
				t.Errorf("decode activity request: %v", err)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/sessions":
			if got := r.URL.Query().Get("project"); got != "mer" {
				t.Errorf("project query = %q, want mer", got)
			}
			if got := r.URL.Query().Get("active"); got != "true" {
				t.Errorf("active query = %q, want true", got)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"sessions":[{"id":"orch-1","projectId":"mer","kind":"orchestrator","harness":"codex","activity":{"state":"active","lastActivityAt":"2026-08-14T11:00:00Z"},"isTerminated":false,"createdAt":"2026-08-14T10:00:00Z","updatedAt":"2026-08-14T11:00:00Z","status":"active"}]}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/sessions/orch-1/send":
			mu.Lock()
			defer mu.Unlock()
			if err := json.NewDecoder(r.Body).Decode(&relayRequest); err != nil {
				t.Errorf("decode relay request: %v", err)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true}`))
		default:
			http.Error(w, "unexpected request", http.StatusNotFound)
		}
	}))
	defer srv.Close()
	writeRunFileFor(t, cfg, srv)

	payload := `{"session_id":"agy-native-1","prompt":"rebase PR #135","prompt_response":"Rebased and resolved conflicts."}`
	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(payload),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "agy", "after-agent")
	if err != nil {
		t.Fatal(err)
	}

	if activityRequest.State != "idle" || activityRequest.LatestAssistantUpdate != "Rebased and resolved conflicts." {
		t.Fatalf("activity request = %+v", activityRequest)
	}
	mu.Lock()
	gotRelay := relayRequest.Message
	mu.Unlock()
	if !strings.Contains(gotRelay, "Worker worker-1 reached its AfterAgent execution boundary") {
		t.Fatalf("relay = %q", gotRelay)
	}
	if !strings.Contains(gotRelay, "Rebased and resolved conflicts.") {
		t.Fatalf("relay missing final result: %q", gotRelay)
	}
}
