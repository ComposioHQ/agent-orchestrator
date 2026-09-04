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
	"strconv"
	"strings"
	"time"

	"github.com/pelletier/go-toml/v2"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	kimiUsageEndpoint = "https://api.kimi.com/coding/v1/usages"
	kimiUsageTimeout  = 10 * time.Second
	maxUsageBody      = 1 << 20
)

type subscriptionPlugin interface {
	ResolveBinary(context.Context) (string, error)
}

// SubscriptionReader performs a provider-authoritative read for the active
// hosted Kimi Code account. Custom/BYOK configurations are rejected before a
// credential can be sent to the hosted endpoint.
type SubscriptionReader struct {
	plugin   subscriptionPlugin
	dataDir  string
	client   *http.Client
	endpoint string
	now      func() time.Time
	timeout  time.Duration
}

// NewSubscriptionReader returns a reader for the active hosted Kimi account.
func NewSubscriptionReader(plugin subscriptionPlugin, dataDir string) *SubscriptionReader {
	return &SubscriptionReader{
		plugin: plugin, dataDir: dataDir, client: &http.Client{}, endpoint: kimiUsageEndpoint,
		now: func() time.Time { return time.Now().UTC() }, timeout: kimiUsageTimeout,
	}
}

// ReadKimiSubscription fetches and normalizes the active hosted account usage.
func (r *SubscriptionReader) ReadKimiSubscription(ctx context.Context) (ports.KimiSubscriptionObservation, error) {
	if r == nil || r.plugin == nil {
		return ports.KimiSubscriptionObservation{}, ports.ErrKimiSubscriptionUnsupported
	}
	if _, err := r.plugin.ResolveBinary(ctx); err != nil {
		return ports.KimiSubscriptionObservation{}, fmt.Errorf("resolve Kimi: %w", err)
	}
	credential, err := resolveHostedKimiCredential(r.dataDir)
	if err != nil {
		return ports.KimiSubscriptionObservation{}, err
	}
	readCtx, cancel := context.WithTimeout(ctx, r.timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(readCtx, http.MethodGet, r.endpoint, http.NoBody)
	if err != nil {
		return ports.KimiSubscriptionObservation{}, fmt.Errorf("create Kimi usage request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+credential.token)
	req.Header.Set("Accept", "application/json")
	resp, err := r.client.Do(req)
	if err != nil {
		if errors.Is(readCtx.Err(), context.DeadlineExceeded) {
			return ports.KimiSubscriptionObservation{}, fmt.Errorf("kimi usage read timed out: %w", readCtx.Err())
		}
		if readCtx.Err() != nil {
			return ports.KimiSubscriptionObservation{}, fmt.Errorf("read Kimi usage: %w", readCtx.Err())
		}
		return ports.KimiSubscriptionObservation{}, fmt.Errorf("read Kimi usage: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		switch resp.StatusCode {
		case http.StatusUnauthorized:
			return ports.KimiSubscriptionObservation{}, fmt.Errorf("kimi authentication failed; sign in again (HTTP %d)", resp.StatusCode)
		case http.StatusNotFound:
			return ports.KimiSubscriptionObservation{}, fmt.Errorf("kimi subscription usage is unavailable (HTTP %d)", resp.StatusCode)
		case http.StatusTooManyRequests:
			return ports.KimiSubscriptionObservation{}, fmt.Errorf("kimi usage request was rate limited (HTTP %d)", resp.StatusCode)
		default:
			if resp.StatusCode >= http.StatusInternalServerError {
				return ports.KimiSubscriptionObservation{}, fmt.Errorf("kimi usage service failed (HTTP %d)", resp.StatusCode)
			}
			return ports.KimiSubscriptionObservation{}, fmt.Errorf("kimi usage request failed with HTTP %d", resp.StatusCode)
		}
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxUsageBody+1))
	if err != nil {
		return ports.KimiSubscriptionObservation{}, fmt.Errorf("read Kimi usage response: %w", err)
	}
	if len(body) > maxUsageBody {
		return ports.KimiSubscriptionObservation{}, errors.New("kimi usage response exceeded size limit")
	}
	var payload kimiUsagePayload
	if err := json.Unmarshal(body, &payload); err != nil {
		return ports.KimiSubscriptionObservation{}, fmt.Errorf("decode Kimi usage response: %w", err)
	}
	observation, err := normalizeUsagePayload(payload, r.now())
	if err != nil {
		return ports.KimiSubscriptionObservation{}, err
	}
	observation.AuthMethod = credential.authMethod
	return observation, nil
}

type kimiHostedCredential struct {
	token      string
	authMethod string
}

func resolveHostedKimiCredential(dataDir string) (kimiHostedCredential, error) {
	if baseURL := strings.TrimSpace(os.Getenv("KIMI_CODE_BASE_URL")); baseURL != "" && !isHostedKimiBaseURL(baseURL) {
		return kimiHostedCredential{}, ports.ErrKimiSubscriptionUnsupported
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
	// Environment-only credentials are safe only when the hosted endpoint was
	// selected explicitly. Otherwise the token may belong to a custom provider.
	if isHostedKimiBaseURL(strings.TrimSpace(os.Getenv("KIMI_CODE_BASE_URL"))) {
		for _, name := range []string{"KIMI_API_KEY", "KIMI_CODE_API_KEY"} {
			if value := strings.TrimSpace(os.Getenv(name)); value != "" {
				return kimiHostedCredential{token: value, authMethod: "api_key"}, nil
			}
		}
	}
	return kimiHostedCredential{}, ports.ErrKimiSubscriptionUnsupported
}

func hostedCredentialFromConfig(path string) (kimiHostedCredential, bool, error) {
	data, err := os.ReadFile(path) //nolint:gosec // Selected Kimi config path from the adapter's bounded home lookup.
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
	if providerID != "managed:kimi-code" {
		return kimiHostedCredential{}, false, ports.ErrKimiSubscriptionUnsupported
	}
	provider := config.Providers[providerID]
	if providerType := strings.TrimSpace(provider.Type); providerType != "" && providerType != "kimi" {
		return kimiHostedCredential{}, false, ports.ErrKimiSubscriptionUnsupported
	}
	effectiveBaseURL := firstNonBlank(provider.BaseURL, provider.Env["KIMI_BASE_URL"])
	if effectiveBaseURL != "" && !isHostedKimiBaseURL(effectiveBaseURL) {
		return kimiHostedCredential{}, false, ports.ErrKimiSubscriptionUnsupported
	}
	if token := strings.TrimSpace(provider.APIKey); token != "" {
		return kimiHostedCredential{token: token, authMethod: "api_key"}, true, nil
	}
	if token := strings.TrimSpace(provider.Env["KIMI_API_KEY"]); token != "" {
		return kimiHostedCredential{token: token, authMethod: "api_key"}, true, nil
	}
	if provider.OAuth == nil || strings.TrimSpace(provider.OAuth.Key) == "" {
		return kimiHostedCredential{}, false, ports.ErrKimiSubscriptionUnsupported
	}
	credentialPath := kimiOAuthCredentialPath(filepath.Dir(path), provider.OAuth.Key)
	data, err = os.ReadFile(credentialPath) //nolint:gosec // Referenced by the selected managed Kimi config.
	if os.IsNotExist(err) {
		return kimiHostedCredential{}, false, ports.ErrKimiSubscriptionUnsupported
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
		return kimiHostedCredential{token: token, authMethod: "oauth"}, true, nil
	}
	return kimiHostedCredential{}, false, ports.ErrKimiSubscriptionUnsupported
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
		return errors.New("kimi usage value must be a finite number")
	}
	*n = kimiNumber(math.Trunc(value))
	return nil
}

func normalizeUsagePayload(payload kimiUsagePayload, observedAt time.Time) (ports.KimiSubscriptionObservation, error) {
	limits := make([]domain.KimiSubscriptionLimit, 0, len(payload.Limits)+1)
	if payload.Usage != nil {
		weeklyMinutes := int64(7 * 24 * 60)
		if limit, ok := normalizeKimiLimit(*payload.Usage, "Weekly limit", &weeklyMinutes, observedAt); ok {
			limits = append(limits, limit)
		}
	}
	for i, raw := range payload.Limits {
		label := firstNonBlank(raw.Name, raw.Title, raw.Scope, windowLabel(raw.Window), fmt.Sprintf("Limit #%d", i+1))
		var minutes *int64
		if duration, ok := windowDuration(raw.Window); ok {
			value := int64(duration / time.Minute)
			minutes = &value
		}
		if limit, ok := normalizeKimiLimit(raw.Detail, label, minutes, observedAt); ok {
			limits = append(limits, limit)
		}
	}
	if len(limits) == 0 {
		return ports.KimiSubscriptionObservation{}, errors.New("kimi usage response contained no valid limits")
	}
	var plan *string
	if value := strings.TrimSpace(payload.User.Membership.Level); value != "" {
		plan = &value
	}
	return ports.KimiSubscriptionObservation{Plan: plan, AuthMethod: "unknown", Limits: limits, ObservedAt: observedAt.UTC()}, nil
}

func normalizeKimiLimit(raw kimiUsageDetail, fallbackLabel string, minutes *int64, observedAt time.Time) (domain.KimiSubscriptionLimit, bool) {
	if raw.Used == nil && raw.Remaining == nil && raw.Limit == nil {
		return domain.KimiSubscriptionLimit{}, false
	}
	if negative(raw.Used) || negative(raw.Remaining) || negative(raw.Limit) {
		return domain.KimiSubscriptionLimit{}, false
	}
	used, remaining, total := kimiFloat(raw.Used), kimiFloat(raw.Remaining), kimiFloat(raw.Limit)
	if total == nil || *total <= 0 || remaining != nil && *remaining > *total {
		return domain.KimiSubscriptionLimit{}, false
	}
	if used == nil && remaining != nil {
		value := *total - *remaining
		used = &value
	}
	if used == nil {
		return domain.KimiSubscriptionLimit{}, false
	}
	if remaining == nil {
		value := math.Max(0, *total-*used)
		remaining = &value
	}
	usedPercent := math.Max(0, math.Min(100, *used / *total * 100))
	remainingPercent := math.Max(0, math.Min(100, *remaining / *total * 100))
	return domain.KimiSubscriptionLimit{
		Name: firstNonBlank(raw.Name, raw.Title, fallbackLabel), UsedPercent: usedPercent,
		RemainingPercent: remainingPercent, WindowDurationMinutes: minutes,
		ResetsAt: kimiResetAt(raw, observedAt),
	}, true
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
			reset := observedAt.Add(time.Duration(*seconds) * time.Second).UTC()
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
