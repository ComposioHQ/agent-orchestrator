package kimi

import (
	"context"
	"encoding/json"
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
		"usage":{"name":"Weekly limit","used":9,"limit":100,"resetAt":"2026-08-30T02:00:00Z"},
		"limits":[
			{"window":{"duration":300,"timeUnit":"MINUTE"},"detail":{"used":0,"limit":100,"resetIn":17640}},
			{"name":"Burst pool","window":{"duration":2,"timeUnit":"HOUR"},"detail":{"remaining":75,"limit":100}}
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
			t.Errorf("authorization = %q", got)
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
}

func TestKimiQuotaRefresherRejectsCustomProviderWithoutRequest(t *testing.T) {
	clearKimiCredentialEnv(t)
	dataDir := t.TempDir()
	home := filepath.Join(dataDir, "kimi")
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

func writeHostedKimiCredential(t *testing.T, home, token string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(home, "credentials"), 0o700); err != nil {
		t.Fatal(err)
	}
	config := `
default_model = "kimi-code/kimi-for-coding"
[providers."managed:kimi-code"]
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
