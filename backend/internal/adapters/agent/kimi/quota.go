package kimi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/pelletier/go-toml/v2"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	kimiUsageEndpoint = "https://api.kimi.com/coding/v1/usages"
	kimiUsageTimeout  = 20 * time.Second
	maxUsageBody      = 1 << 20
)

// QuotaPlugin is the installed Kimi capability required by the quota reader.
type QuotaPlugin interface {
	ResolveBinary(context.Context) (string, error)
}

// QuotaRefresher reads hosted Kimi Code subscription usage without a session.
type QuotaRefresher struct {
	plugin   QuotaPlugin
	dataDir  string
	client   *http.Client
	endpoint string
	now      func() time.Time
}

// NewQuotaRefresher creates a daemon-owned Kimi plan-usage reader.
func NewQuotaRefresher(plugin QuotaPlugin, dataDir string) *QuotaRefresher {
	return &QuotaRefresher{
		plugin:   plugin,
		dataDir:  dataDir,
		client:   &http.Client{},
		endpoint: kimiUsageEndpoint,
		now:      func() time.Time { return time.Now().UTC() },
	}
}

// QuotaAccountPresent reports whether a hosted Kimi Code account is readable.
func (r *QuotaRefresher) QuotaAccountPresent(ctx context.Context, provider domain.QuotaProviderID, accountID domain.QuotaAccountID) (bool, error) {
	if r == nil || r.plugin == nil || provider != "kimi" || accountID != "default" {
		return false, nil
	}
	if _, err := r.plugin.ResolveBinary(ctx); err != nil {
		if errors.Is(err, ports.ErrAgentBinaryNotFound) {
			return false, nil
		}
		return false, err
	}
	_, err := resolveHostedKimiCredential(r.dataDir)
	if errors.Is(err, ports.ErrQuotaRefreshUnsupported) {
		return false, nil
	}
	return err == nil, err
}

// RefreshQuota fetches and normalizes Kimi's current subscription limits.
func (r *QuotaRefresher) RefreshQuota(ctx context.Context, provider domain.QuotaProviderID, accountID domain.QuotaAccountID) (domain.QuotaSnapshot, error) {
	if r == nil || r.plugin == nil || provider != "kimi" || accountID != "default" {
		return domain.QuotaSnapshot{}, ports.ErrQuotaRefreshUnsupported
	}
	if _, err := r.plugin.ResolveBinary(ctx); err != nil {
		return domain.QuotaSnapshot{}, fmt.Errorf("resolve Kimi: %w", err)
	}
	token, err := resolveHostedKimiCredential(r.dataDir)
	if err != nil {
		return domain.QuotaSnapshot{}, err
	}
	readCtx, cancel := context.WithTimeout(ctx, kimiUsageTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(readCtx, http.MethodGet, r.endpoint, nil)
	if err != nil {
		return domain.QuotaSnapshot{}, fmt.Errorf("create Kimi usage request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	resp, err := r.client.Do(req)
	if err != nil {
		if errors.Is(readCtx.Err(), context.DeadlineExceeded) {
			return domain.QuotaSnapshot{}, fmt.Errorf("Kimi usage read timed out: %w", readCtx.Err())
		}
		return domain.QuotaSnapshot{}, fmt.Errorf("read Kimi usage: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return domain.QuotaSnapshot{}, fmt.Errorf("Kimi usage request failed with HTTP %d", resp.StatusCode)
	}
	decoder := json.NewDecoder(io.LimitReader(resp.Body, maxUsageBody))
	var payload kimiUsagePayload
	if err := decoder.Decode(&payload); err != nil {
		return domain.QuotaSnapshot{}, fmt.Errorf("decode Kimi usage response: %w", err)
	}
	return normalizeUsagePayload(payload, r.now())
}

func resolveHostedKimiCredential(dataDir string) (string, error) {
	if baseURL := strings.TrimSpace(os.Getenv("KIMI_CODE_BASE_URL")); baseURL != "" &&
		strings.TrimRight(baseURL, "/") != "https://api.kimi.com/coding/v1" {
		return "", ports.ErrQuotaRefreshUnsupported
	}
	for _, name := range []string{"KIMI_API_KEY", "KIMI_CODE_API_KEY"} {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
			return value, nil
		}
	}
	homes := make([]string, 0, 3)
	if strings.TrimSpace(dataDir) != "" {
		homes = append(homes, kimiCodeHomeDir(dataDir))
	}
	if discovered, ok := kimiAuthHomes(); ok {
		homes = append(homes, discovered...)
	}
	seen := make(map[string]struct{}, len(homes))
	for _, home := range homes {
		home = filepath.Clean(home)
		if _, ok := seen[home]; ok {
			continue
		}
		seen[home] = struct{}{}
		for _, name := range []string{"config.toml", "config.json"} {
			token, found, err := hostedCredentialFromConfig(filepath.Join(home, name))
			if err != nil {
				return "", err
			}
			if found {
				return token, nil
			}
		}
	}
	return "", ports.ErrQuotaRefreshUnsupported
}

func hostedCredentialFromConfig(path string) (string, bool, error) {
	data, err := os.ReadFile(path) //nolint:gosec // Kimi user/AO config selected by the same adapter lookup as auth detection.
	if os.IsNotExist(err) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("read Kimi configuration: %w", err)
	}
	var config kimiAuthConfig
	if strings.EqualFold(filepath.Ext(path), ".json") {
		err = json.Unmarshal(data, &config)
	} else {
		err = toml.Unmarshal(data, &config)
	}
	if err != nil {
		return "", false, fmt.Errorf("decode Kimi configuration: %w", err)
	}
	providerID := ""
	if model, ok := config.Models[config.DefaultModel]; ok {
		providerID = strings.TrimSpace(model.Provider)
	}
	if providerID == "" {
		if _, ok := config.Providers["managed:kimi-code"]; ok {
			providerID = "managed:kimi-code"
		}
	}
	if providerID != "" && providerID != "managed:kimi-code" {
		return "", false, ports.ErrQuotaRefreshUnsupported
	}
	if providerID != "managed:kimi-code" {
		return "", false, nil
	}
	provider := config.Providers[providerID]
	if token := strings.TrimSpace(provider.APIKey); token != "" {
		return token, true, nil
	}
	if provider.OAuth == nil || strings.TrimSpace(provider.OAuth.Key) == "" {
		return "", false, nil
	}
	credentialPath := kimiOAuthCredentialPath(filepath.Dir(path), provider.OAuth.Key)
	data, err = os.ReadFile(credentialPath) //nolint:gosec // referenced by the selected managed Kimi config.
	if os.IsNotExist(err) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("read Kimi credential: %w", err)
	}
	var credential struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(data, &credential); err != nil {
		return "", false, fmt.Errorf("decode Kimi credential: %w", err)
	}
	if token := strings.TrimSpace(credential.AccessToken); token != "" {
		return token, true, nil
	}
	return "", false, nil
}

type kimiUsagePayload struct {
	Usage  *kimiUsageDetail `json:"usage"`
	Limits []kimiUsageLimit `json:"limits"`
}

type kimiUsageLimit struct {
	Name   string          `json:"name"`
	Title  string          `json:"title"`
	Scope  string          `json:"scope"`
	Detail kimiUsageDetail `json:"detail"`
	Window kimiUsageWindow `json:"window"`
}

type kimiUsageWindow struct {
	Duration *int64 `json:"duration"`
	TimeUnit string `json:"timeUnit"`
}

type kimiUsageDetail struct {
	Name      string   `json:"name"`
	Title     string   `json:"title"`
	Used      *float64 `json:"used"`
	Remaining *float64 `json:"remaining"`
	Limit     *float64 `json:"limit"`
	ResetAt   string   `json:"resetAt"`
	ResetAtV1 string   `json:"reset_at"`
	ResetIn   *int64   `json:"resetIn"`
	ResetInV1 *int64   `json:"reset_in"`
	TTL       *int64   `json:"ttl"`
}

var nonQuotaID = regexp.MustCompile(`[^a-z0-9]+`)

func normalizeUsagePayload(payload kimiUsagePayload, observedAt time.Time) (domain.QuotaSnapshot, error) {
	limits := make([]domain.QuotaLimit, 0, len(payload.Limits)+1)
	if payload.Usage != nil {
		if limit, ok := normalizeKimiLimit(*payload.Usage, kimiUsageWindow{}, "Weekly limit", "weekly", observedAt); ok {
			limits = append(limits, limit)
		}
	}
	for i, raw := range payload.Limits {
		label := firstNonBlank(raw.Name, raw.Title, raw.Scope, windowLabel(raw.Window), fmt.Sprintf("Limit #%d", i+1))
		id := quotaID(label)
		if label == windowLabel(raw.Window) {
			id = windowID(raw.Window)
		}
		if limit, ok := normalizeKimiLimit(raw.Detail, raw.Window, label, id, observedAt); ok {
			limits = append(limits, limit)
		}
	}
	if len(limits) == 0 {
		return domain.QuotaSnapshot{}, errors.New("Kimi usage response contained no valid limits")
	}
	return domain.NormalizeQuotaSnapshot(domain.QuotaSnapshot{
		Provider:     "kimi",
		AccountID:    "default",
		AccountLabel: "Kimi",
		Capabilities: domain.QuotaCapabilities{SupportsRead: true, SupportsHistory: true},
		Limits:       limits,
		ObservedAt:   observedAt,
		Completeness: domain.QuotaComplete,
	}), nil
}

func normalizeKimiLimit(raw kimiUsageDetail, window kimiUsageWindow, fallbackLabel, fallbackID string, observedAt time.Time) (domain.QuotaLimit, bool) {
	if raw.Used == nil && raw.Remaining == nil && raw.Limit == nil {
		return domain.QuotaLimit{}, false
	}
	if negative(raw.Used) || negative(raw.Remaining) || negative(raw.Limit) {
		return domain.QuotaLimit{}, false
	}
	used := raw.Used
	remaining := raw.Remaining
	if used == nil && remaining != nil && raw.Limit != nil {
		value := *raw.Limit - *remaining
		used = &value
	}
	if remaining == nil && used != nil && raw.Limit != nil {
		value := max(0, *raw.Limit-*used)
		remaining = &value
	}
	var usedPercent *float64
	if used != nil && raw.Limit != nil && *raw.Limit > 0 {
		value := *used / *raw.Limit * 100
		usedPercent = &value
	}
	label := firstNonBlank(raw.Name, raw.Title, fallbackLabel)
	limit := domain.QuotaLimit{
		ID:             domain.QuotaLimitID(firstNonBlank(fallbackID, quotaID(label))),
		Name:           label,
		Category:       domain.QuotaRateLimit,
		Scope:          domain.QuotaAccountScope,
		UsedPercent:    usedPercent,
		RemainingValue: remaining,
		TotalValue:     raw.Limit,
		Unit:           "requests",
		WindowType:     firstNonBlank(windowID(window), string(fallbackID)),
		ObservedAt:     observedAt,
	}
	if duration, ok := windowDuration(window); ok {
		limit.WindowDuration = &duration
	}
	limit.ResetsAt = kimiResetAt(raw, observedAt)
	if remaining != nil {
		reached := *remaining <= 0
		limit.Reached = &reached
	}
	return limit, true
}

func kimiResetAt(raw kimiUsageDetail, observedAt time.Time) *time.Time {
	if value := firstNonBlank(raw.ResetAt, raw.ResetAtV1); value != "" {
		if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
			parsed = parsed.UTC()
			return &parsed
		}
	}
	for _, seconds := range []*int64{raw.ResetIn, raw.ResetInV1, raw.TTL} {
		if seconds != nil && *seconds > 0 {
			reset := observedAt.Add(time.Duration(*seconds) * time.Second)
			return &reset
		}
	}
	return nil
}

func windowDuration(window kimiUsageWindow) (time.Duration, bool) {
	if window.Duration == nil || *window.Duration <= 0 {
		return 0, false
	}
	multiplier := time.Second
	switch strings.ToUpper(strings.TrimSpace(window.TimeUnit)) {
	case "MINUTE", "MINUTES":
		multiplier = time.Minute
	case "HOUR", "HOURS":
		multiplier = time.Hour
	case "DAY", "DAYS":
		multiplier = 24 * time.Hour
	case "SECOND", "SECONDS", "":
	default:
		return 0, false
	}
	return time.Duration(*window.Duration) * multiplier, true
}

func windowLabel(window kimiUsageWindow) string {
	duration, ok := windowDuration(window)
	if !ok {
		return ""
	}
	if duration%time.Hour == 0 {
		return fmt.Sprintf("%dh limit", int64(duration/time.Hour))
	}
	if duration%time.Minute == 0 {
		return fmt.Sprintf("%dm limit", int64(duration/time.Minute))
	}
	return fmt.Sprintf("%ds limit", int64(duration/time.Second))
}

func windowID(window kimiUsageWindow) string {
	duration, ok := windowDuration(window)
	if !ok {
		return ""
	}
	if duration%time.Hour == 0 {
		return fmt.Sprintf("%dh", int64(duration/time.Hour))
	}
	if duration%time.Minute == 0 {
		return fmt.Sprintf("%dm", int64(duration/time.Minute))
	}
	return fmt.Sprintf("%ds", int64(duration/time.Second))
}

func quotaID(value string) string {
	return strings.Trim(nonQuotaID.ReplaceAllString(strings.ToLower(strings.TrimSpace(value)), "_"), "_")
}

func firstNonBlank(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

func negative(value *float64) bool { return value != nil && *value < 0 }
