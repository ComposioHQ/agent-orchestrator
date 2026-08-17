package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
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

func TestParseAgyStopOutcome(t *testing.T) {
	outcome := parseAgyStopOutcome([]byte(`{
		"executionNum": 4,
		"terminationReason": "error",
		"error": "Out of credits",
		"fullyIdle": true
	}`))
	if outcome.ExecutionNum != 4 || outcome.TerminationReason != "error" || outcome.Error != "Out of credits" {
		t.Fatalf("unexpected outcome: %+v", outcome)
	}
	if outcome.FullyIdle == nil || !*outcome.FullyIdle {
		t.Fatalf("fullyIdle = %v, want true", outcome.FullyIdle)
	}
	if !outcome.readyForRelay() {
		t.Fatal("fully-idle Stop should be relayed")
	}
}

func TestParseAgyStopOutcomeBackgroundWorkIsNotReadyForRelay(t *testing.T) {
	outcome := parseAgyStopOutcome([]byte(`{"terminationReason":"model_stop","fullyIdle":false}`))
	if outcome.FullyIdle == nil || *outcome.FullyIdle {
		t.Fatalf("fullyIdle = %v, want false", outcome.FullyIdle)
	}
	if outcome.readyForRelay() {
		t.Fatal("Stop with active background work must not be relayed")
	}
}

func TestFormatAgyCompletionMessageSeparatesProviderOutcomeFromTaskSuccess(t *testing.T) {
	fullyIdle := true
	msg := formatAgyCompletionMessage("worker-1", hookConversationSnapshot{}, agyStopOutcome{
		ExecutionNum:      2,
		TerminationReason: "error",
		Error:             "Out of credits",
		FullyIdle:         &fullyIdle,
	})
	for _, want := range []string{
		"Worker worker-1 reached its native Stop execution boundary",
		"does not prove the requested task succeeded",
		"Execution: 2",
		"Provider termination: error",
		"Provider error: Out of credits",
		"Provider fully idle: true",
		"verify durable workspace state",
	} {
		if !strings.Contains(msg, want) {
			t.Fatalf("message %q does not contain %q", msg, want)
		}
	}
}

func TestHooksAgyStopRelaysProviderFailureToCodexOrchestrator(t *testing.T) {
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

	payload := `{
		"conversationId":"agy-native-1",
		"transcriptPath":"/tmp/agy-transcript.jsonl",
		"executionNum":2,
		"terminationReason":"error",
		"error":"Out of credits",
		"fullyIdle":true
	}`
	out, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(payload),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "agy", "stop")
	if err != nil {
		t.Fatal(err)
	}

	if activityRequest.State != "idle" || activityRequest.Event != "stop" {
		t.Fatalf("activity request = %+v", activityRequest)
	}
	if activityRequest.AgentSessionID != "agy-native-1" || activityRequest.TranscriptPath != "/tmp/agy-transcript.jsonl" {
		t.Fatalf("native metadata = %+v", activityRequest)
	}
	mu.Lock()
	gotRelay := relayRequest.Message
	mu.Unlock()
	for _, want := range []string{
		"Worker worker-1 reached its native Stop execution boundary",
		"Provider termination: error",
		"Provider error: Out of credits",
	} {
		if !strings.Contains(gotRelay, want) {
			t.Fatalf("relay %q does not contain %q", gotRelay, want)
		}
	}

	var hookOutput agyStopHookOutput
	if err := json.Unmarshal([]byte(out), &hookOutput); err != nil {
		t.Fatalf("decode Stop hook stdout %q: %v", out, err)
	}
	if hookOutput.Decision != "allow" {
		t.Fatalf("Stop decision = %q, want allow", hookOutput.Decision)
	}
}

func TestHooksAgyStopWithBackgroundWorkDoesNotRelay(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "worker-1")
	t.Setenv("AO_PROJECT_ID", "mer")
	t.Setenv("AO_RUNTIME_LAUNCH_ID", "launch-1")
	cfg := setConfigEnv(t)

	var listCalls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/sessions/worker-1/activity":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/sessions":
			listCalls.Add(1)
			http.Error(w, "relay should not run", http.StatusInternalServerError)
		default:
			http.Error(w, "unexpected request", http.StatusNotFound)
		}
	}))
	defer srv.Close()
	writeRunFileFor(t, cfg, srv)

	out, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"conversationId":"agy-native-1","terminationReason":"model_stop","fullyIdle":false}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "agy", "stop")
	if err != nil {
		t.Fatal(err)
	}
	if listCalls.Load() != 0 {
		t.Fatalf("project session list calls = %d, want 0", listCalls.Load())
	}
	var hookOutput agyStopHookOutput
	if err := json.Unmarshal([]byte(out), &hookOutput); err != nil {
		t.Fatalf("decode Stop hook stdout %q: %v", out, err)
	}
	if hookOutput.Decision != "allow" {
		t.Fatalf("Stop decision = %q, want allow", hookOutput.Decision)
	}
}
