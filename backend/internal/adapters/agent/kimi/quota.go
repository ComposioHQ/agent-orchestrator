package kimi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
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
	timeout  time.Duration
}

// NewQuotaRefresher creates a daemon-owned Kimi plan-usage reader.
func NewQuotaRefresher(plugin QuotaPlugin, dataDir string) *QuotaRefresher {
	return &QuotaRefresher{
		plugin:   plugin,
		dataDir:  dataDir,
		client:   &http.Client{},
		endpoint: kimiUsageEndpoint,
		now:      func() time.Time { return time.Now().UTC() },
		timeout:  kimiUsageTimeout,
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
	credential, err := resolveHostedKimiCredential(r.dataDir)
	if err != nil {
		return domain.QuotaSnapshot{}, err
	}
	readCtx, cancel := context.WithTimeout(ctx, r.timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(readCtx, http.MethodGet, r.endpoint, nil)
	if err != nil {
		return domain.QuotaSnapshot{}, fmt.Errorf("create Kimi usage request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+credential.token)
	req.Header.Set("Accept", "application/json")
	resp, err := r.client.Do(req)
	if err != nil {
		if errors.Is(readCtx.Err(), context.DeadlineExceeded) {
			return domain.QuotaSnapshot{}, fmt.Errorf("Kimi usage read timed out: %w", readCtx.Err())
		}
		if readCtx.Err() != nil {
			return domain.QuotaSnapshot{}, fmt.Errorf("read Kimi usage: %w", readCtx.Err())
		}
		return domain.QuotaSnapshot{}, fmt.Errorf("read Kimi usage: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		switch resp.StatusCode {
		case http.StatusUnauthorized:
			return domain.QuotaSnapshot{}, fmt.Errorf("Kimi authentication failed; sign in again (HTTP %d)", resp.StatusCode)
		case http.StatusTooManyRequests:
			return domain.QuotaSnapshot{}, fmt.Errorf("Kimi usage request was rate limited (HTTP %d)", resp.StatusCode)
		default:
			if resp.StatusCode >= http.StatusInternalServerError {
				return domain.QuotaSnapshot{}, fmt.Errorf("Kimi usage service failed (HTTP %d)", resp.StatusCode)
			}
			return domain.QuotaSnapshot{}, fmt.Errorf("Kimi usage request failed with HTTP %d", resp.StatusCode)
		}
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxUsageBody+1))
	if err != nil {
		return domain.QuotaSnapshot{}, fmt.Errorf("read Kimi usage response: %w", err)
	}
	if len(body) > maxUsageBody {
		return domain.QuotaSnapshot{}, errors.New("Kimi usage response exceeded size limit")
	}
	var payload kimiUsagePayload
	if err := json.Unmarshal(body, &payload); err != nil {
		return domain.QuotaSnapshot{}, fmt.Errorf("decode Kimi usage response: %w", err)
	}
	snapshot, err := normalizeUsagePayload(payload, r.now())
	if err != nil {
		return domain.QuotaSnapshot{}, err
	}
	snapshot.AuthMode = credential.authMode
	return snapshot, nil
}

type kimiHostedCredential struct {
	token    string
	authMode string
}

func resolveHostedKimiCredential(dataDir string) (kimiHostedCredential, error) {
	if baseURL := strings.TrimSpace(os.Getenv("KIMI_CODE_BASE_URL")); baseURL != "" &&
		!isHostedKimiBaseURL(baseURL) {
		return kimiHostedCredential{}, ports.ErrQuotaRefreshUnsupported
	}
	homes := make([]string, 0, 3)
	if discovered, ok := kimiAuthHomes(); ok {
		homes = append(homes, discovered...)
	}
	if strings.TrimSpace(dataDir) != "" {
		homes = append(homes, kimiCodeHomeDir(dataDir))
	}
	seen := make(map[string]struct{}, len(homes))
	for _, home := range homes {
		home = filepath.Clean(home)
		if _, ok := seen[home]; ok {
			continue
		}
		seen[home] = struct{}{}
		for _, name := range []string{"config.toml", "config.json"} {
			credential, found, err := hostedCredentialFromConfig(filepath.Join(home, name))
			if err != nil {
				return kimiHostedCredential{}, err
			}
			if found {
				return credential, nil
			}
		}
	}
	// An environment-only token is safe only when the caller explicitly selects
	// Kimi's hosted endpoint. Otherwise it may belong to a custom provider.
	if isHostedKimiBaseURL(strings.TrimSpace(os.Getenv("KIMI_CODE_BASE_URL"))) {
		for _, name := range []string{"KIMI_API_KEY", "KIMI_CODE_API_KEY"} {
			if value := strings.TrimSpace(os.Getenv(name)); value != "" {
				return kimiHostedCredential{token: value, authMode: "api_key"}, nil
			}
		}
	}
	return kimiHostedCredential{}, ports.ErrQuotaRefreshUnsupported
}

func hostedCredentialFromConfig(path string) (kimiHostedCredential, bool, error) {
	data, err := os.ReadFile(path) //nolint:gosec // Kimi user/AO config selected by the same adapter lookup as auth detection.
	if os.IsNotExist(err) {
		return kimiHostedCredential{}, false, nil
	}
	if err != nil {
		return kimiHostedCredential{}, false, fmt.Errorf("read Kimi configuration: %w", err)
	}
	var config kimiAuthConfig
	if strings.EqualFold(filepath.Ext(path), ".json") {
		err = json.Unmarshal(data, &config)
	} else {
		err = toml.Unmarshal(data, &config)
	}
	if err != nil {
		return kimiHostedCredential{}, false, fmt.Errorf("decode Kimi configuration: %w", err)
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
		return kimiHostedCredential{}, false, ports.ErrQuotaRefreshUnsupported
	}
	if providerID != "managed:kimi-code" {
		return kimiHostedCredential{}, false, ports.ErrQuotaRefreshUnsupported
	}
	provider := config.Providers[providerID]
	if providerType := strings.TrimSpace(provider.Type); providerType != "" && providerType != "kimi" {
		return kimiHostedCredential{}, false, ports.ErrQuotaRefreshUnsupported
	}
	if baseURL := strings.TrimSpace(provider.BaseURL); baseURL != "" && !isHostedKimiBaseURL(baseURL) {
		return kimiHostedCredential{}, false, ports.ErrQuotaRefreshUnsupported
	}
	if token := strings.TrimSpace(provider.APIKey); token != "" {
		return kimiHostedCredential{token: token, authMode: "api_key"}, true, nil
	}
	if token := strings.TrimSpace(provider.Env["KIMI_API_KEY"]); token != "" {
		return kimiHostedCredential{token: token, authMode: "api_key"}, true, nil
	}
	if provider.OAuth == nil || strings.TrimSpace(provider.OAuth.Key) == "" {
		return kimiHostedCredential{}, false, ports.ErrQuotaRefreshUnsupported
	}
	credentialPath := kimiOAuthCredentialPath(filepath.Dir(path), provider.OAuth.Key)
	data, err = os.ReadFile(credentialPath) //nolint:gosec // referenced by the selected managed Kimi config.
	if os.IsNotExist(err) {
		return kimiHostedCredential{}, false, ports.ErrQuotaRefreshUnsupported
	}
	if err != nil {
		return kimiHostedCredential{}, false, fmt.Errorf("read Kimi credential: %w", err)
	}
	var credential struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(data, &credential); err != nil {
		return kimiHostedCredential{}, false, fmt.Errorf("decode Kimi credential: %w", err)
	}
	if token := strings.TrimSpace(credential.AccessToken); token != "" {
		return kimiHostedCredential{token: token, authMode: "oauth"}, true, nil
	}
	return kimiHostedCredential{}, false, ports.ErrQuotaRefreshUnsupported
}

func isHostedKimiBaseURL(value string) bool {
	return strings.EqualFold(strings.TrimRight(strings.TrimSpace(value), "/"), "https://api.kimi.com/coding/v1")
}

type kimiUsagePayload struct {
	Usage  *kimiUsageDetail `json:"usage"`
	Limits []kimiUsageLimit `json:"limits"`
	User   struct {
		Membership struct {
			Level string `json:"level"`
		} `json:"membership"`
	} `json:"user"`
}

type kimiUsageLimit struct {
	Name   string          `json:"name"`
	Title  string          `json:"title"`
	Scope  string          `json:"scope"`
	Detail kimiUsageDetail `json:"detail"`
	Window kimiUsageWindow `json:"window"`
}

type kimiUsageWindow struct {
	Duration *kimiNumber `json:"duration"`
	TimeUnit string      `json:"timeUnit"`
}

type kimiUsageDetail struct {
	Name      string      `json:"name"`
	Title     string      `json:"title"`
	Used      *kimiNumber `json:"used"`
	Remaining *kimiNumber `json:"remaining"`
	Limit     *kimiNumber `json:"limit"`
	ResetTime string      `json:"resetTime"`
	ResetAt   string      `json:"resetAt"`
	ResetAtV1 string      `json:"reset_at"`
	ResetIn   *kimiNumber `json:"resetIn"`
	ResetInV1 *kimiNumber `json:"reset_in"`
	TTL       *kimiNumber `json:"ttl"`
}

type kimiNumber float64

func (n *kimiNumber) UnmarshalJSON(data []byte) error {
	text := strings.TrimSpace(string(data))
	if len(text) >= 2 && text[0] == '"' && text[len(text)-1] == '"' {
		var value string
		if err := json.Unmarshal(data, &value); err != nil {
			return err
		}
		text = strings.TrimSpace(value)
	}
	value, err := strconv.ParseFloat(text, 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return errors.New("Kimi usage value must be a finite number")
	}
	*n = kimiNumber(math.Trunc(value))
	return nil
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
		PlanType:     strings.TrimSpace(payload.User.Membership.Level),
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
	used := kimiFloat(raw.Used)
	remaining := kimiFloat(raw.Remaining)
	total := kimiFloat(raw.Limit)
	if remaining != nil && total != nil && *remaining > *total {
		return domain.QuotaLimit{}, false
	}
	if used == nil && remaining != nil && total != nil {
		value := *total - *remaining
		used = &value
	}
	if remaining == nil && used != nil && total != nil {
		value := max(0, *total-*used)
		remaining = &value
	}
	var usedPercent *float64
	if used != nil && total != nil && *total > 0 {
		value := *used / *total * 100
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
		TotalValue:     total,
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
	if value := firstNonBlank(raw.ResetTime, raw.ResetAt, raw.ResetAtV1); value != "" {
		if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
			parsed = parsed.UTC()
			return &parsed
		}
	}
	for _, seconds := range []*kimiNumber{raw.ResetIn, raw.ResetInV1, raw.TTL} {
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
	case "MINUTE", "MINUTES", "TIME_UNIT_MINUTE":
		multiplier = time.Minute
	case "HOUR", "HOURS", "TIME_UNIT_HOUR":
		multiplier = time.Hour
	case "DAY", "DAYS", "TIME_UNIT_DAY":
		multiplier = 24 * time.Hour
	case "WEEK", "WEEKS", "TIME_UNIT_WEEK":
		multiplier = 7 * 24 * time.Hour
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

func negative(value *kimiNumber) bool { return value != nil && *value < 0 }

func kimiFloat(value *kimiNumber) *float64 {
	if value == nil {
		return nil
	}
	result := float64(*value)
	return &result
}
