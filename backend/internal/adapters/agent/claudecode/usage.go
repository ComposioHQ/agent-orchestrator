package claudecode

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	claudeOAuthUsageEndpoint = "https://api.anthropic.com/api/oauth/usage"
	claudeOAuthBetaHeader    = "oauth-2025-04-20"
	claudeUsageBodyLimit     = 1 << 20
	claudeConfigReadLimit    = 8 << 20
)

type claudeHTTPDoer interface {
	Do(*http.Request) (*http.Response, error)
}

type claudeCodeUsageReader struct {
	keychain   Keychain
	home       string
	httpClient claudeHTTPDoer
	endpoint   string
	now        func() time.Time
}

// NewUsageReader returns a reader for Claude subscription limits.
func NewUsageReader(keychain Keychain, home string) ports.ClaudeCodeUsageReader {
	return &claudeCodeUsageReader{
		keychain: keychain, home: home,
		httpClient: &http.Client{Timeout: 5 * time.Second}, endpoint: claudeOAuthUsageEndpoint,
		now: time.Now,
	}
}

type claudeOAuthCredential struct {
	ClaudeAIOAuth struct {
		AccessToken      string `json:"accessToken"`
		SubscriptionType string `json:"subscriptionType"`
		RateLimitTier    string `json:"rateLimitTier"`
	} `json:"claudeAiOauth"`
}

type claudeUsageWindowWire struct {
	Utilization *float64 `json:"utilization"`
	ResetsAt    *string  `json:"resets_at"`
}

type claudeUsageScopedLimitWire struct {
	Kind     string   `json:"kind"`
	Percent  *float64 `json:"percent"`
	ResetsAt *string  `json:"resets_at"`
	Scope    *struct {
		Model *struct {
			DisplayName string `json:"display_name"`
		} `json:"model"`
	} `json:"scope"`
}

func (r *claudeCodeUsageReader) ReadPlanUsage(ctx context.Context, accountID string) (ports.ClaudeCodePlanUsageObservation, error) {
	credential, found, err := r.keychain.Get(ctx, ClaudeAccountVaultService, accountID)
	if err != nil || !found {
		return ports.ClaudeCodePlanUsageObservation{}, ports.ErrClaudeCodePlanUsageUnavailable
	}
	var stored claudeOAuthCredential
	if json.Unmarshal(credential, &stored) != nil || strings.TrimSpace(stored.ClaudeAIOAuth.AccessToken) == "" {
		return ports.ClaudeCodePlanUsageObservation{}, ports.ErrClaudeCodePlanUsageInvalid
	}
	observation := ports.ClaudeCodePlanUsageObservation{ObservedAt: r.now().UTC()}
	if plan := claudeOAuthPlan(stored.ClaudeAIOAuth.SubscriptionType, stored.ClaudeAIOAuth.RateLimitTier); plan != "" {
		observation.Plan = &plan
	}
	if promotion, promotionErr := r.readCachedPromotion(ctx, accountID); promotionErr == nil {
		observation.Promotion = promotion
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.endpoint, http.NoBody)
	if err != nil {
		return observation, ports.ErrClaudeCodePlanUsageUnavailable
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+stored.ClaudeAIOAuth.AccessToken)
	req.Header.Set("anthropic-beta", claudeOAuthBetaHeader)
	req.Header.Set("User-Agent", "claude-cli/2.1.220")
	response, err := r.httpClient.Do(req)
	if err != nil {
		return observation, ports.ErrClaudeCodePlanUsageUnavailable
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode == http.StatusTooManyRequests {
		return observation, ports.ErrClaudeCodePlanUsageRateLimited
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return observation, ports.ErrClaudeCodePlanUsageUnavailable
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, claudeUsageBodyLimit+1))
	if err != nil || len(body) > claudeUsageBodyLimit {
		return observation, ports.ErrClaudeCodePlanUsageInvalid
	}
	var wire map[string]json.RawMessage
	if json.Unmarshal(body, &wire) != nil {
		return observation, ports.ErrClaudeCodePlanUsageInvalid
	}
	windows := normalizeClaudeUsageWindows(wire)
	windows = append(windows, normalizeClaudeScopedUsageLimits(wire["limits"], windows)...)
	if len(windows) == 0 {
		return observation, ports.ErrClaudeCodePlanUsageInvalid
	}
	observation.Windows = windows
	return observation, nil
}

func normalizeClaudeSubscriptionType(value string) string {
	switch normalized := strings.ToLower(strings.TrimSpace(value)); normalized {
	case "free", "pro", "max", "team", "business", "enterprise":
		return normalized
	case "claude_free", "claude_pro", "claude_max", "claude_team", "claude_business", "claude_enterprise":
		return strings.TrimPrefix(normalized, "claude_")
	default:
		return ""
	}
}

func claudeOAuthPlan(subscriptionType, rateLimitTier string) string {
	if plan := normalizeClaudeSubscriptionType(subscriptionType); plan != "" {
		return plan
	}
	// Older Claude credentials may omit subscriptionType but retain a stable
	// provider rate-limit tier. Map only recognized values; never expose the raw
	// credential field through AO's display APIs.
	normalized := strings.ToLower(strings.TrimSpace(rateLimitTier))
	switch {
	case strings.Contains(normalized, "claude_pro"):
		return "pro"
	case strings.Contains(normalized, "claude_max"):
		return "max"
	case strings.Contains(normalized, "claude_team"):
		return "team"
	case strings.Contains(normalized, "claude_enterprise"):
		return "enterprise"
	default:
		return ""
	}
}

func normalizeClaudeScopedUsageLimits(raw json.RawMessage, existing []domain.ClaudeCodePlanUsageWindow) []domain.ClaudeCodePlanUsageWindow {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var values []claudeUsageScopedLimitWire
	if json.Unmarshal(raw, &values) != nil {
		return nil
	}
	seen := make(map[string]struct{}, len(existing)+len(values))
	for _, window := range existing {
		seen[window.ID] = struct{}{}
	}
	windows := make([]domain.ClaudeCodePlanUsageWindow, 0, len(values))
	for _, value := range values {
		if value.Kind != "weekly_scoped" || value.Scope == nil || value.Scope.Model == nil || value.Percent == nil {
			continue
		}
		displayName := strings.TrimSpace(value.Scope.Model.DisplayName)
		if displayName == "" || math.IsNaN(*value.Percent) || math.IsInf(*value.Percent, 0) || *value.Percent < 0 || *value.Percent > 100 {
			continue
		}
		id := "weekly_scoped:" + strings.ToLower(displayName)
		if _, duplicate := seen[id]; duplicate {
			continue
		}
		seen[id] = struct{}{}
		window := domain.ClaudeCodePlanUsageWindow{ID: id, DisplayName: "Weekly — " + displayName, UsedPercent: *value.Percent}
		if value.ResetsAt != nil && strings.TrimSpace(*value.ResetsAt) != "" {
			if parsed, err := time.Parse(time.RFC3339, strings.TrimSpace(*value.ResetsAt)); err == nil {
				parsed = parsed.UTC()
				window.ResetsAt = &parsed
			}
		}
		windows = append(windows, window)
	}
	return windows
}

var claudeUsageWindowOrder = []string{
	"five_hour", "seven_day", "seven_day_fable", "seven_day_opus", "seven_day_sonnet", "seven_day_oauth_apps",
}

var claudeUsageWindowNames = map[string]string{
	"five_hour":            "5-hour limit",
	"seven_day":            "Weekly — all models",
	"seven_day_fable":      "Weekly — Fable",
	"seven_day_opus":       "Weekly — Opus",
	"seven_day_sonnet":     "Weekly — Sonnet",
	"seven_day_oauth_apps": "Weekly — connected apps",
}

func normalizeClaudeUsageWindows(values map[string]json.RawMessage) []domain.ClaudeCodePlanUsageWindow {
	ordered := append([]string(nil), claudeUsageWindowOrder...)
	known := make(map[string]struct{}, len(ordered))
	for _, id := range ordered {
		known[id] = struct{}{}
	}
	additional := make([]string, 0)
	for id := range values {
		if _, ok := known[id]; !ok && strings.HasPrefix(id, "seven_day_") {
			additional = append(additional, id)
		}
	}
	sort.Strings(additional)
	ordered = append(ordered, additional...)
	windows := make([]domain.ClaudeCodePlanUsageWindow, 0, len(ordered))
	for _, id := range ordered {
		raw, ok := values[id]
		if !ok || string(raw) == "null" {
			continue
		}
		var wire claudeUsageWindowWire
		if json.Unmarshal(raw, &wire) != nil || wire.Utilization == nil || math.IsNaN(*wire.Utilization) || math.IsInf(*wire.Utilization, 0) || *wire.Utilization < 0 || *wire.Utilization > 100 {
			continue
		}
		window := domain.ClaudeCodePlanUsageWindow{ID: id, DisplayName: claudeUsageWindowName(id), UsedPercent: *wire.Utilization}
		if wire.ResetsAt != nil && strings.TrimSpace(*wire.ResetsAt) != "" {
			if parsed, err := time.Parse(time.RFC3339, strings.TrimSpace(*wire.ResetsAt)); err == nil {
				parsed = parsed.UTC()
				window.ResetsAt = &parsed
			}
		}
		windows = append(windows, window)
	}
	return windows
}

func claudeUsageWindowName(id string) string {
	if name := claudeUsageWindowNames[id]; name != "" {
		return name
	}
	name := strings.TrimPrefix(id, "seven_day_")
	name = strings.ReplaceAll(name, "_", " ")
	if name == "" {
		return "Weekly limit"
	}
	return "Weekly — " + strings.ToUpper(name[:1]) + name[1:]
}

type claudePromotionWire struct {
	Bar  string `json:"bar"`
	Text string `json:"text"`
}

var claudeWeeklyPromotionPattern = regexp.MustCompile(`(?i)\+?(\d+)%\s+weekly\s+limits?\s+promo\s+through\s+([a-z]+)\s+(\d{1,2})`)

func (r *claudeCodeUsageReader) readCachedPromotion(ctx context.Context, accountID string) (*domain.ClaudeCodePlanPromotion, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	path := filepath.Join(r.home, ".claude.json")
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Size() > claudeConfigReadLimit {
		return nil, ports.ErrClaudeCodePlanUsageInvalid
	}
	data, err := os.ReadFile(path)
	if err != nil || len(data) > claudeConfigReadLimit {
		return nil, ports.ErrClaudeCodePlanUsageInvalid
	}
	var config struct {
		OAuthAccount struct {
			AccountUUID string `json:"accountUuid"`
		} `json:"oauthAccount"`
		CachedGrowthBookFeatures map[string]json.RawMessage `json:"cachedGrowthBookFeatures"`
	}
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, ports.ErrClaudeCodePlanUsageInvalid
	}
	if strings.TrimSpace(config.OAuthAccount.AccountUUID) != accountID {
		return nil, nil
	}
	raw := config.CachedGrowthBookFeatures["tengu_rate_limit_promo_notices"]
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var notices []claudePromotionWire
	if json.Unmarshal(raw, &notices) != nil {
		return nil, ports.ErrClaudeCodePlanUsageInvalid
	}
	for _, notice := range notices {
		if notice.Bar != "seven_day" {
			continue
		}
		if promotion := parseClaudeWeeklyPromotion(notice.Text, r.now()); promotion != nil {
			return promotion, nil
		}
	}
	return nil, nil
}

func parseClaudeWeeklyPromotion(text string, now time.Time) *domain.ClaudeCodePlanPromotion {
	match := claudeWeeklyPromotionPattern.FindStringSubmatch(strings.TrimSpace(text))
	if len(match) != 4 {
		return nil
	}
	percent, err := strconv.Atoi(match[1])
	if err != nil || percent <= 0 {
		return nil
	}
	var end time.Time
	for _, layout := range []string{"Jan 2 2006", "January 2 2006"} {
		end, err = time.ParseInLocation(layout, match[2]+" "+match[3]+" "+strconv.Itoa(now.Year()), time.UTC)
		if err == nil {
			break
		}
	}
	if err != nil {
		return nil
	}
	today := time.Date(now.UTC().Year(), now.UTC().Month(), now.UTC().Day(), 0, 0, 0, 0, time.UTC)
	if end.Before(today) {
		return nil
	}
	return &domain.ClaudeCodePlanPromotion{PercentIncrease: percent, EndsOn: end.Format("2006-01-02")}
}

var _ ports.ClaudeCodeUsageReader = (*claudeCodeUsageReader)(nil)
