package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSessionProfileSwitchStartPostsOnceAndReturnsAcceptedOperation(t *testing.T) {
	cfg := setConfigEnv(t)
	capture := &agentSwitchRequestCapture{}
	getCount := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capture.record(r)
		if r.Method == http.MethodGet {
			getCount++
		}
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost && r.URL.Path == "/api/v1/sessions/demo-1/profile-switches" {
			_, _ = io.WriteString(w, `{"switch":{"id":"profile-switch-1","sourceSessionId":"demo-1","sourceProfileId":"existing","targetProfileId":"managed-1","trigger":"manual","phase":"requested","handoffClassification":"pending","acknowledgeUnknownCapacity":true,"progressReason":"Waiting for a safe point.","canCancel":true,"canRecover":false,"canRestoreSource":false,"requestedAt":"2026-08-04T10:00:00Z","updatedAt":"2026-08-04T10:00:00Z"}}`)
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{ProcessAlive: func(int) bool { return true }},
		"session", "profile-switch", "start", "demo-1",
		"--profile", "managed-1",
		"--acknowledge-unknown-capacity",
		"--idempotency-key", "retry-1",
	)
	if err != nil {
		t.Fatalf("profile-switch start failed: %v\nstderr=%s", err, errOut)
	}
	method, path, body, count := capture.snapshot()
	if method != http.MethodPost || path != "/api/v1/sessions/demo-1/profile-switches" || count != 1 || getCount != 0 {
		t.Fatalf("request = %s %s (count=%d get=%d)", method, path, count, getCount)
	}
	var request struct {
		TargetProfileID            string `json:"targetProfileId"`
		IdempotencyKey             string `json:"idempotencyKey"`
		AcknowledgeUnknownCapacity bool   `json:"acknowledgeUnknownCapacity"`
	}
	if err := json.Unmarshal(body, &request); err != nil {
		t.Fatalf("decode request: %v; body=%s", err, body)
	}
	if request.TargetProfileID != "managed-1" || request.IdempotencyKey != "retry-1" || !request.AcknowledgeUnknownCapacity {
		t.Fatalf("request = %+v", request)
	}
	for _, value := range []string{"switch: profile-switch-1", "phase: requested", "target profile: managed-1"} {
		if !strings.Contains(out, value) {
			t.Fatalf("output missing %q: %s", value, out)
		}
	}
}

func TestSessionProfileSwitchOptionsUsesEnsureEndpoint(t *testing.T) {
	cfg := setConfigEnv(t)
	capture := &agentSwitchRequestCapture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capture.record(r)
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost && r.URL.Path == "/api/v1/sessions/demo-1/profile-switch-options/ensure" {
			_, _ = io.WriteString(w, `{"sourceProfile":{"id":"existing","label":"Existing Codex profile","source":"existing","availability":"available"},"recommendedProfileId":"managed-1","candidates":[{"id":"managed-1","label":"Work","source":"managed","authentication":{"state":"authorized","freshness":"fresh"},"capacity":{"state":"available","freshness":"fresh","usedPercent":20},"recommended":true,"selectable":true,"requiresCapacityAcknowledgement":false,"reasonCode":"profile_switch_recommended_available","reason":"Recommended."}]}`)
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{ProcessAlive: func(int) bool { return true }}, "session", "profile-switch", "options", "demo-1")
	if err != nil {
		t.Fatalf("profile-switch options failed: %v\nstderr=%s", err, errOut)
	}
	method, path, _, count := capture.snapshot()
	if method != http.MethodPost || path != "/api/v1/sessions/demo-1/profile-switch-options/ensure" || count != 1 {
		t.Fatalf("request = %s %s (count=%d)", method, path, count)
	}
	if !strings.Contains(out, "managed-1") || !strings.Contains(out, "profile_switch_recommended_available") {
		t.Fatalf("unexpected output: %s", out)
	}
}

func TestSessionProfileSwitchStartRequiresProfile(t *testing.T) {
	_, _, err := executeCLI(t, Deps{}, "session", "profile-switch", "start", "demo-1")
	if err == nil || !strings.Contains(err.Error(), "--profile is required") {
		t.Fatalf("error = %v", err)
	}
}
