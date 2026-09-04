package kimi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type fakeSubscriptionPlugin struct {
	binary string
	err    error
}

func (f fakeSubscriptionPlugin) ResolveBinary(context.Context) (string, error) {
	return f.binary, f.err
}

func TestNormalizeKimiUsageIncludesSummaryAndDynamicLimits(t *testing.T) {
	observedAt := time.Date(2026, 8, 24, 4, 0, 0, 0, time.UTC)
	var payload kimiUsagePayload
	if err := json.Unmarshal([]byte(`{
		"user":{"membership":{"level":"Ultra"}},
		"usage":{"name":"Weekly limit","used":"9","limit":"100","resetTime":"2026-08-30T02:00:00Z"},
		"limits":[
			{"window":{"duration":"300","timeUnit":"TIME_UNIT_MINUTE"},"detail":{"used":"0","limit":"100","resetTime":"2026-08-24T08:54:00Z"}},
			{"name":"Burst pool","window":{"duration":"2","timeUnit":"TIME_UNIT_HOUR"},"detail":{"remaining":"75","limit":"100"}}
		]
	}`), &payload); err != nil {
		t.Fatal(err)
	}

	observation, err := normalizeUsagePayload(payload, observedAt)
	if err != nil {
		t.Fatalf("normalizeUsagePayload: %v", err)
	}
	if observation.Plan == nil || *observation.Plan != "Ultra" {
		t.Fatalf("plan = %v", observation.Plan)
	}
	if len(observation.Limits) != 3 {
		t.Fatalf("limits = %d, want 3", len(observation.Limits))
	}
	weekly := observation.Limits[0]
	if weekly.UsedPercent != 9 || weekly.RemainingPercent != 91 || weekly.WindowDurationMinutes == nil || *weekly.WindowDurationMinutes != 10080 {
		t.Fatalf("weekly = %#v", weekly)
	}
	fiveHour := observation.Limits[1]
	if fiveHour.WindowDurationMinutes == nil || *fiveHour.WindowDurationMinutes != 300 || fiveHour.RemainingPercent != 100 {
		t.Fatalf("five hour = %#v", fiveHour)
	}
	if fiveHour.ResetsAt == nil || !fiveHour.ResetsAt.Equal(time.Date(2026, 8, 24, 8, 54, 0, 0, time.UTC)) {
		t.Fatalf("five hour reset = %v", fiveHour.ResetsAt)
	}
	if got := observation.Limits[2]; got.Name != "Burst pool" || got.UsedPercent != 25 || got.RemainingPercent != 75 {
		t.Fatalf("burst = %#v", got)
	}
}

func TestNormalizeKimiUsageRejectsUntrustworthyPayloads(t *testing.T) {
	for _, body := range []string{`{}`, `{"usage":{"remaining":"101","limit":"100"}}`, `{"usage":{"used":"-1","limit":"100"}}`} {
		var payload kimiUsagePayload
		if err := json.Unmarshal([]byte(body), &payload); err != nil {
			t.Fatal(err)
		}
		if _, err := normalizeUsagePayload(payload, time.Now().UTC()); err == nil {
			t.Fatalf("expected payload rejection: %s", body)
		}
	}
}

func TestKimiSubscriptionReaderReadsHostedUsage(t *testing.T) {
	home := prepareHostedKimiCredential(t, "test-secret")
	var requests int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if got := r.Header.Get("Authorization"); got != "Bearer test-secret" {
			t.Errorf("authorization = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"usage":{"used":9,"limit":100}}`))
	}))
	defer server.Close()

	reader := NewSubscriptionReader(fakeSubscriptionPlugin{binary: "kimi"}, "")
	reader.endpoint = server.URL
	observation, err := reader.ReadKimiSubscription(context.Background())
	if err != nil {
		t.Fatalf("ReadKimiSubscription: %v", err)
	}
	if requests != 1 || len(observation.Limits) != 1 || observation.AuthMethod != "oauth" {
		t.Fatalf("requests=%d observation=%#v", requests, observation)
	}
	if home == "" {
		t.Fatal("test setup did not create a home")
	}
}

func TestKimiSubscriptionReaderRejectsCustomProviderWithoutRequest(t *testing.T) {
	home := t.TempDir()
	setKimiTestHomes(t, home)
	t.Setenv("KIMI_API_KEY", "custom-environment-secret")
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(`
default_model = "custom/model"
[providers.custom]
type = "openai_responses"
api_key = "must-not-leak"
base_url = "https://example.invalid/v1"
[models."custom/model"]
provider = "custom"
`), 0o600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("custom credential was sent to the hosted Kimi endpoint")
	}))
	defer server.Close()
	reader := NewSubscriptionReader(fakeSubscriptionPlugin{binary: "kimi"}, "")
	reader.endpoint = server.URL
	_, err := reader.ReadKimiSubscription(context.Background())
	if !errors.Is(err, ports.ErrKimiSubscriptionUnsupported) {
		t.Fatalf("error = %v", err)
	}
}

func TestKimiSubscriptionReaderSanitizesProviderFailures(t *testing.T) {
	prepareHostedKimiCredential(t, "fixture-secret")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "fixture-secret upstream detail", http.StatusUnauthorized)
	}))
	defer server.Close()
	reader := NewSubscriptionReader(fakeSubscriptionPlugin{binary: "kimi"}, "")
	reader.endpoint = server.URL
	_, err := reader.ReadKimiSubscription(context.Background())
	if err == nil || strings.Contains(err.Error(), "fixture-secret") || !strings.Contains(strings.ToLower(err.Error()), "authentication") {
		t.Fatalf("error = %v", err)
	}
}

func TestKimiSubscriptionReaderHonorsCancellation(t *testing.T) {
	prepareHostedKimiCredential(t, "fixture-secret")
	reader := NewSubscriptionReader(fakeSubscriptionPlugin{binary: "kimi"}, "")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := reader.ReadKimiSubscription(ctx)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context cancellation", err)
	}
}

func prepareHostedKimiCredential(t *testing.T, token string) string {
	t.Helper()
	home := t.TempDir()
	setKimiTestHomes(t, home)
	if err := os.MkdirAll(filepath.Join(home, "credentials"), 0o700); err != nil {
		t.Fatal(err)
	}
	config := `
default_model = "kimi-code/kimi-for-coding"
[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code"
[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
`
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	credential, _ := json.Marshal(map[string]string{"access_token": token, "refresh_token": "refresh-secret"})
	if err := os.WriteFile(filepath.Join(home, "credentials", "kimi-code.json"), credential, 0o600); err != nil {
		t.Fatal(err)
	}
	return home
}

func setKimiTestHomes(t *testing.T, home string) {
	t.Helper()
	t.Setenv("KIMI_SHARE_DIR", home)
	t.Setenv(kimiCodeHomeEnv, home)
	t.Setenv("KIMI_CODE_BASE_URL", "")
	for _, name := range kimiAPIKeyEnvVars {
		t.Setenv(name, "")
	}
}
