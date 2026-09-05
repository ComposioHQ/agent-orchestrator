package claudecode

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type usageTestKeychain struct {
	value      []byte
	getService string
	getAccount string
	setCalls   int
}

func (*usageTestKeychain) Supported() bool { return true }
func (k *usageTestKeychain) Get(_ context.Context, service, account string) ([]byte, bool, error) {
	k.getService = service
	k.getAccount = account
	return append([]byte(nil), k.value...), len(k.value) > 0, nil
}
func (k *usageTestKeychain) Set(context.Context, string, string, []byte) error {
	k.setCalls++
	return nil
}
func (*usageTestKeychain) Delete(context.Context, string, string) error { return nil }

type usageTestDoer func(*http.Request) (*http.Response, error)

func (f usageTestDoer) Do(request *http.Request) (*http.Response, error) { return f(request) }

func TestClaudeUsageReaderUsesSavedAccountWithoutChangingGlobalAuth(t *testing.T) {
	const accountID = "11111111-1111-4111-8111-111111111111"
	home := t.TempDir()
	config := `{
		"oauthAccount":{"accountUuid":"` + accountID + `"},
		"cachedGrowthBookFeatures":{"tengu_rate_limit_promo_notices":[
			{"bar":"seven_day","text":"+50% weekly limits promo through Sep 13 · clau.de/cc-50-promo","variant":"claude"}
		]}
	}`
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	keychain := &usageTestKeychain{value: []byte(`{"claudeAiOauth":{"accessToken":"account-secret","subscriptionType":"pro"}}`)}
	reader := &claudeCodeUsageReader{
		keychain: keychain, home: home, endpoint: "https://example.test/api/oauth/usage",
		now: func() time.Time { return time.Date(2026, 9, 3, 10, 0, 0, 0, time.UTC) },
	}
	reader.httpClient = usageTestDoer(func(request *http.Request) (*http.Response, error) {
		if request.Method != http.MethodGet || request.URL.String() != reader.endpoint {
			t.Fatalf("unexpected request: %s %s", request.Method, request.URL)
		}
		if request.Header.Get("Authorization") != "Bearer account-secret" || request.Header.Get("anthropic-beta") != claudeOAuthBetaHeader {
			t.Fatalf("unexpected request headers")
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{
			"five_hour":{"utilization":12.5,"resets_at":"2026-09-03T12:00:00Z"},
			"seven_day":{"utilization":42,"resets_at":"2026-09-08T00:00:00Z"},
			"seven_day_opus":null,
			"limits":[{"kind":"weekly_scoped","percent":21,"resets_at":"2026-09-09T00:00:00Z","scope":{"model":{"display_name":"Opus 5"}}}]
		}`))}, nil
	})

	result, err := reader.ReadPlanUsage(context.Background(), accountID)
	if err != nil {
		t.Fatal(err)
	}
	if keychain.getService != ClaudeAccountVaultService || keychain.getAccount != accountID || keychain.setCalls != 0 {
		t.Fatalf("usage read touched the wrong credential: service=%q account=%q writes=%d", keychain.getService, keychain.getAccount, keychain.setCalls)
	}
	if len(result.Windows) != 3 || result.Windows[0].ID != "five_hour" || result.Windows[0].UsedPercent != 12.5 || result.Windows[1].ID != "seven_day" || result.Windows[2].DisplayName != "Weekly — Opus 5" {
		t.Fatalf("usage windows = %+v", result.Windows)
	}
	if result.Plan == nil || *result.Plan != "pro" {
		t.Fatalf("plan = %v", result.Plan)
	}
	if result.Promotion == nil || result.Promotion.PercentIncrease != 50 || result.Promotion.EndsOn != "2026-09-13" {
		t.Fatalf("promotion = %+v", result.Promotion)
	}
}

func TestClaudeOAuthPlanRecognizesNativeCredentialValues(t *testing.T) {
	tests := []struct {
		name             string
		subscriptionType string
		rateLimitTier    string
		want             string
	}{
		{name: "native pro subscription", subscriptionType: "claude_pro", want: "pro"},
		{name: "native max subscription", subscriptionType: "claude_max", want: "max"},
		{name: "legacy pro tier", rateLimitTier: "default_claude_pro", want: "pro"},
		{name: "legacy max tier", rateLimitTier: "default_claude_max_20x", want: "max"},
		{name: "subscription wins", subscriptionType: "claude_team", rateLimitTier: "default_claude_max_5x", want: "team"},
		{name: "unknown values stay private", subscriptionType: "internal_preview", rateLimitTier: "private_tier", want: ""},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := claudeOAuthPlan(test.subscriptionType, test.rateLimitTier); got != test.want {
				t.Fatalf("claudeOAuthPlan(%q, %q) = %q, want %q", test.subscriptionType, test.rateLimitTier, got, test.want)
			}
		})
	}
}

func TestClaudeUsageReaderDoesNotAttributePromotionToAnotherAccount(t *testing.T) {
	home := t.TempDir()
	config := `{"oauthAccount":{"accountUuid":"11111111-1111-4111-8111-111111111111"},"cachedGrowthBookFeatures":{"tengu_rate_limit_promo_notices":[{"bar":"seven_day","text":"+50% weekly limits promo through Sep 13"}]}}`
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	reader := &claudeCodeUsageReader{home: home, now: func() time.Time { return time.Date(2026, 9, 2, 20, 0, 0, 0, time.Local) }}
	result, err := reader.readCachedPromotion(context.Background(), "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	if result != nil {
		t.Fatalf("promotion was attributed to another account: %+v", result)
	}
}

func TestClaudeUsageReaderRejectsSymlinkedConfig(t *testing.T) {
	home := t.TempDir()
	target := filepath.Join(home, "config.json")
	if err := os.WriteFile(target, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(home, ".claude.json")); err != nil {
		t.Fatal(err)
	}
	reader := &claudeCodeUsageReader{home: home}
	if _, err := reader.readCachedPromotion(context.Background(), "11111111-1111-4111-8111-111111111111"); err == nil {
		t.Fatal("symlinked Claude config was accepted")
	}
}

func TestParseClaudeWeeklyPromotionIgnoresExpiredOrMalformedNotices(t *testing.T) {
	now := time.Date(2026, 9, 14, 10, 0, 0, 0, time.UTC)
	if promotion := parseClaudeWeeklyPromotion("+50% weekly limits promo through Sep 13", now); promotion != nil {
		t.Fatalf("expired promotion = %+v", promotion)
	}
	if promotion := parseClaudeWeeklyPromotion("weekly promotion available", now); promotion != nil {
		t.Fatalf("malformed promotion = %+v", promotion)
	}
}
