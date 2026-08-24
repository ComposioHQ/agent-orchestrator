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

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type fakeKimiQuotaPlugin struct {
	binary string
	err    error
}

func (f fakeKimiQuotaPlugin) ResolveBinary(context.Context) (string, error) {
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

	snapshot, err := normalizeUsagePayload(payload, observedAt)
	if err != nil {
		t.Fatalf("normalizeUsagePayload: %v", err)
	}
	if snapshot.Provider != "kimi" || snapshot.AccountID != "default" {
		t.Fatalf("identity = %s/%s", snapshot.Provider, snapshot.AccountID)
	}
	if snapshot.PlanType != "Ultra" {
		t.Fatalf("plan type = %q", snapshot.PlanType)
	}
	if snapshot.Completeness != domain.QuotaComplete {
		t.Fatalf("completeness = %q", snapshot.Completeness)
	}
	if !snapshot.Capabilities.SupportsRead || !snapshot.Capabilities.SupportsHistory {
		t.Fatalf("capabilities = %#v", snapshot.Capabilities)
	}
	if len(snapshot.Limits) != 3 {
		t.Fatalf("limits = %d, want 3", len(snapshot.Limits))
	}

	weekly := snapshot.Limits[0]
	if weekly.ID != "weekly" || weekly.Name != "Weekly limit" {
		t.Fatalf("weekly identity = %q/%q", weekly.ID, weekly.Name)
	}
	assertFloat(t, weekly.UsedPercent, 9)
	assertFloat(t, weekly.TotalValue, 100)
	assertFloat(t, weekly.RemainingValue, 91)
	if weekly.ResetsAt == nil || !weekly.ResetsAt.Equal(time.Date(2026, 8, 30, 2, 0, 0, 0, time.UTC)) {
		t.Fatalf("weekly reset = %v", weekly.ResetsAt)
	}

	fiveHour := snapshot.Limits[1]
	if fiveHour.ID != "5h" || fiveHour.WindowDuration == nil || *fiveHour.WindowDuration != 5*time.Hour {
		t.Fatalf("five-hour limit = %#v", fiveHour)
	}
	assertFloat(t, fiveHour.UsedPercent, 0)
	if fiveHour.ResetsAt == nil || !fiveHour.ResetsAt.Equal(observedAt.Add(4*time.Hour+54*time.Minute)) {
		t.Fatalf("five-hour reset = %v", fiveHour.ResetsAt)
	}

	burst := snapshot.Limits[2]
	if burst.ID != "burst_pool" {
		t.Fatalf("future limit id = %q", burst.ID)
	}
	assertFloat(t, burst.UsedPercent, 25)
	assertFloat(t, burst.RemainingValue, 75)
}

func TestNormalizeKimiUsageRejectsEmptyPayload(t *testing.T) {
	_, err := normalizeUsagePayload(kimiUsagePayload{}, time.Now().UTC())
	if err == nil {
		t.Fatal("expected empty payload error")
	}
}

func TestNormalizeKimiUsageRejectsRemainingAboveLimit(t *testing.T) {
	var payload kimiUsagePayload
	if err := json.Unmarshal([]byte(`{"usage":{"remaining":"101","limit":"100"}}`), &payload); err != nil {
		t.Fatal(err)
	}
	if _, err := normalizeUsagePayload(payload, time.Now().UTC()); err == nil {
		t.Fatal("expected inconsistent usage to be rejected")
	}
}

func assertFloat(t *testing.T, value *float64, want float64) {
	t.Helper()
	if value == nil || *value != want {
		t.Fatalf("value = %v, want %v", value, want)
	}
}

func TestKimiQuotaRefresherReadsHostedUsage(t *testing.T) {
	clearKimiCredentialEnv(t)
	dataDir := t.TempDir()
	home := filepath.Join(dataDir, "kimi")
	writeHostedKimiCredential(t, home, "test-secret")

	var requests int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if got := r.Header.Get("Authorization"); got != "Bearer test-secret" {
			t.Error("authorization did not use the isolated hosted credential")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"usage":{"used":9,"limit":100}}`))
	}))
	defer server.Close()

	refresher := NewQuotaRefresher(fakeKimiQuotaPlugin{binary: "kimi"}, dataDir)
	refresher.endpoint = server.URL
	present, err := refresher.QuotaAccountPresent(context.Background(), "kimi", "default")
	if err != nil || !present {
		t.Fatalf("present = %v, err = %v", present, err)
	}
	snapshot, err := refresher.RefreshQuota(context.Background(), "kimi", "default")
	if err != nil {
		t.Fatalf("RefreshQuota: %v", err)
	}
	if requests != 1 || len(snapshot.Limits) != 1 {
		t.Fatalf("requests = %d, limits = %d", requests, len(snapshot.Limits))
	}
	if snapshot.AuthMode != "oauth" {
		t.Fatalf("auth mode = %q", snapshot.AuthMode)
	}
}

func TestKimiQuotaRefresherRejectsCustomProviderWithoutRequest(t *testing.T) {
	clearKimiCredentialEnv(t)
	t.Setenv("KIMI_API_KEY", "custom-environment-secret")
	dataDir := t.TempDir()
	home := filepath.Join(dataDir, "kimi")
	t.Setenv(kimiCodeHomeEnv, home)
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(`
default_model = "custom/model"
[providers.custom]
api_key = "must-not-leak"
[models."custom/model"]
provider = "custom"
`), 0o600); err != nil {
		t.Fatal(err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("custom provider issued a Kimi usage request")
	}))
	defer server.Close()
	refresher := NewQuotaRefresher(fakeKimiQuotaPlugin{binary: "kimi"}, dataDir)
	refresher.endpoint = server.URL
	if _, err := refresher.RefreshQuota(context.Background(), "kimi", "default"); err == nil {
		t.Fatal("expected unsupported custom provider")
	}
}

func TestKimiQuotaRefresherDoesNotFallBackPastActiveCustomConfig(t *testing.T) {
	clearKimiCredentialEnv(t)
	customHome := t.TempDir()
	t.Setenv(kimiCodeHomeEnv, customHome)
	if err := os.WriteFile(filepath.Join(customHome, "config.toml"), []byte(`
default_model = "custom/model"
[providers.custom]
type = "openai"
api_key = "must-not-leak"
base_url = "https://example.invalid/v1"
[models."custom/model"]
provider = "custom"
`), 0o600); err != nil {
		t.Fatal(err)
	}
	dataDir := t.TempDir()
	writeHostedKimiCredential(t, filepath.Join(dataDir, "kimi"), "stale-managed-secret")

	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("active custom provider issued a hosted Kimi usage request")
	}))
	defer server.Close()
	refresher := NewQuotaRefresher(fakeKimiQuotaPlugin{binary: "kimi"}, dataDir)
	refresher.endpoint = server.URL
	if _, err := refresher.RefreshQuota(context.Background(), "kimi", "default"); err == nil {
		t.Fatal("expected active custom provider to be unsupported")
	}
}

func TestKimiQuotaRefresherRejectsManagedNameWithCustomEndpoint(t *testing.T) {
	clearKimiCredentialEnv(t)
	dataDir := t.TempDir()
	home := filepath.Join(dataDir, "kimi")
	t.Setenv(kimiCodeHomeEnv, home)
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(`
default_model = "kimi-code/kimi-for-coding"
[providers."managed:kimi-code"]
type = "openai"
api_key = "must-not-leak"
base_url = "https://example.invalid/v1"
[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
`), 0o600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("custom endpoint credential issued a hosted Kimi usage request")
	}))
	defer server.Close()
	refresher := NewQuotaRefresher(fakeKimiQuotaPlugin{binary: "kimi"}, dataDir)
	refresher.endpoint = server.URL
	if _, err := refresher.RefreshQuota(context.Background(), "kimi", "default"); err == nil {
		t.Fatal("expected custom managed provider to be unsupported")
	}
}

func TestKimiQuotaRefresherRejectsManagedEnvWithCustomEndpoint(t *testing.T) {
	clearKimiCredentialEnv(t)
	dataDir := t.TempDir()
	home := filepath.Join(dataDir, "kimi")
	t.Setenv(kimiCodeHomeEnv, home)
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(`
default_model = "kimi-code/kimi-for-coding"
[providers."managed:kimi-code"]
type = "kimi"
[providers."managed:kimi-code".env]
KIMI_API_KEY = "must-not-leak"
KIMI_BASE_URL = "https://example.invalid/v1"
[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
`), 0o600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("custom env-table credential issued a hosted Kimi usage request")
	}))
	defer server.Close()
	refresher := NewQuotaRefresher(fakeKimiQuotaPlugin{binary: "kimi"}, dataDir)
	refresher.endpoint = server.URL
	if _, err := refresher.RefreshQuota(context.Background(), "kimi", "default"); err == nil {
		t.Fatal("expected custom env-table endpoint to be unsupported")
	}
}

func TestKimiQuotaRefresherSanitizesHTTPError(t *testing.T) {
	clearKimiCredentialEnv(t)
	dataDir := t.TempDir()
	writeHostedKimiCredential(t, filepath.Join(dataDir, "kimi"), "fixture-secret")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "fixture-secret upstream detail", http.StatusUnauthorized)
	}))
	defer server.Close()
	refresher := NewQuotaRefresher(fakeKimiQuotaPlugin{binary: "kimi"}, dataDir)
	refresher.endpoint = server.URL
	_, err := refresher.RefreshQuota(context.Background(), "kimi", "default")
	if err == nil || strings.Contains(err.Error(), "fixture-secret") {
		t.Fatalf("error = %v", err)
	}
}

func TestKimiQuotaRefresherClassifiesHTTPFailures(t *testing.T) {
	for _, tc := range []struct {
		status int
		want   string
	}{
		{http.StatusUnauthorized, "authentication"},
		{http.StatusTooManyRequests, "rate limited"},
		{http.StatusBadGateway, "service failed"},
	} {
		t.Run(http.StatusText(tc.status), func(t *testing.T) {
			clearKimiCredentialEnv(t)
			dataDir := t.TempDir()
			writeHostedKimiCredential(t, filepath.Join(dataDir, "kimi"), "fixture-secret")
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
			}))
			defer server.Close()
			refresher := NewQuotaRefresher(fakeKimiQuotaPlugin{binary: "kimi"}, dataDir)
			refresher.endpoint = server.URL
			_, err := refresher.RefreshQuota(context.Background(), "kimi", "default")
			if err == nil || !strings.Contains(strings.ToLower(err.Error()), tc.want) {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestKimiQuotaRefresherRejectsMalformedTrailingAndOversizedResponses(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
	}{
		{"malformed", `{"usage":`},
		{"trailing", `{"usage":{"used":1,"limit":2}} trailing`},
		{"oversized", strings.Repeat(" ", maxUsageBody+1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			clearKimiCredentialEnv(t)
			dataDir := t.TempDir()
			writeHostedKimiCredential(t, filepath.Join(dataDir, "kimi"), "fixture-secret")
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			refresher := NewQuotaRefresher(fakeKimiQuotaPlugin{binary: "kimi"}, dataDir)
			refresher.endpoint = server.URL
			if _, err := refresher.RefreshQuota(context.Background(), "kimi", "default"); err == nil {
				t.Fatal("expected invalid response error")
			}
		})
	}
}

func TestKimiQuotaRefresherHonorsTimeout(t *testing.T) {
	clearKimiCredentialEnv(t)
	dataDir := t.TempDir()
	writeHostedKimiCredential(t, filepath.Join(dataDir, "kimi"), "fixture-secret")
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer server.Close()
	refresher := NewQuotaRefresher(fakeKimiQuotaPlugin{binary: "kimi"}, dataDir)
	refresher.endpoint = server.URL
	refresher.timeout = 10 * time.Millisecond
	_, err := refresher.RefreshQuota(context.Background(), "kimi", "default")
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "timed out") {
		t.Fatalf("error = %v", err)
	}
}

func TestKimiQuotaRefresherHonorsCancellation(t *testing.T) {
	clearKimiCredentialEnv(t)
	dataDir := t.TempDir()
	writeHostedKimiCredential(t, filepath.Join(dataDir, "kimi"), "fixture-secret")
	refresher := NewQuotaRefresher(fakeKimiQuotaPlugin{binary: "kimi"}, dataDir)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := refresher.RefreshQuota(ctx, "kimi", "default")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context cancellation", err)
	}
}

func writeHostedKimiCredential(t *testing.T, home, token string) {
	t.Helper()
	if strings.TrimSpace(os.Getenv(kimiCodeHomeEnv)) == "" {
		t.Setenv(kimiCodeHomeEnv, home)
	}
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
	credentials, _ := json.Marshal(map[string]string{"access_token": token, "refresh_token": "refresh-secret"})
	if err := os.WriteFile(filepath.Join(home, "credentials", "kimi-code.json"), credentials, 0o600); err != nil {
		t.Fatal(err)
	}
}

func clearKimiCredentialEnv(t *testing.T) {
	t.Helper()
	for _, name := range kimiAPIKeyEnvVars {
		t.Setenv(name, "")
	}
	t.Setenv("KIMI_SHARE_DIR", "")
	t.Setenv(kimiCodeHomeEnv, "")
}
