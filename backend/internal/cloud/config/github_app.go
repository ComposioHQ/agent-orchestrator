package config

import (
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// GitHubAppConfig is the SCM credential boundary's configuration. Every field
// is optional as a group: a deployment without a GitHub App simply has no
// cloud SCM, and every SCM route reports that instead of failing open.
//
// The private key and webhook secret arrive through the environment, which is
// how Secrets Manager injects them into the task definition. Neither is ever
// read from a file path or written back out.
type GitHubAppConfig struct {
	AppID             int64
	AppSlug           string
	PrivateKeyPEM     []byte
	WebhookSecret     []byte
	OAuthClientID     string
	OAuthClientSecret string
	// APIBase and WebBase override GitHub's endpoints for tests and for
	// GitHub Enterprise deployments.
	APIBase string
	WebBase string
	// InstallCompletionURL is where the browser is sent after the install
	// callback finishes. Empty means answer the callback with JSON.
	InstallCompletionURL string
}

// Configured reports whether enough is present to mint installation tokens.
func (c GitHubAppConfig) Configured() bool {
	return c.AppID > 0 && strings.TrimSpace(c.AppSlug) != "" && len(c.PrivateKeyPEM) > 0
}

// WebhooksConfigured reports whether the webhook endpoint can verify
// signatures. Without a secret the endpoint stays disabled rather than
// accepting unverified deliveries.
func (c GitHubAppConfig) WebhooksConfigured() bool {
	return c.Configured() && len(c.WebhookSecret) > 0
}

func loadGitHubApp(getenv func(string) string) (GitHubAppConfig, error) {
	appID, err := optionalInt64(getenv("AO_CLOUD_GITHUB_APP_ID"))
	if err != nil {
		return GitHubAppConfig{}, fmt.Errorf("AO_CLOUD_GITHUB_APP_ID: %w", err)
	}
	privateKey, err := pemValue(
		getenv("AO_CLOUD_GITHUB_APP_PRIVATE_KEY"),
		getenv("AO_CLOUD_GITHUB_APP_PRIVATE_KEY_BASE64"),
	)
	if err != nil {
		return GitHubAppConfig{}, fmt.Errorf("AO_CLOUD_GITHUB_APP_PRIVATE_KEY: %w", err)
	}
	cfg := GitHubAppConfig{
		AppID:                appID,
		AppSlug:              strings.TrimSpace(getenv("AO_CLOUD_GITHUB_APP_SLUG")),
		PrivateKeyPEM:        privateKey,
		WebhookSecret:        []byte(strings.TrimSpace(getenv("AO_CLOUD_GITHUB_APP_WEBHOOK_SECRET"))),
		OAuthClientID:        strings.TrimSpace(getenv("AO_CLOUD_GITHUB_APP_CLIENT_ID")),
		OAuthClientSecret:    strings.TrimSpace(getenv("AO_CLOUD_GITHUB_APP_CLIENT_SECRET")),
		APIBase:              strings.TrimSpace(getenv("AO_CLOUD_GITHUB_API_BASE")),
		WebBase:              strings.TrimSpace(getenv("AO_CLOUD_GITHUB_WEB_BASE")),
		InstallCompletionURL: strings.TrimSpace(getenv("AO_CLOUD_GITHUB_APP_INSTALL_COMPLETION_URL")),
	}
	// Partial configuration is a deployment mistake worth failing on: it would
	// otherwise present a working install flow that cannot mint credentials.
	present := cfg.AppID > 0 || cfg.AppSlug != "" || len(cfg.PrivateKeyPEM) > 0
	if present && !cfg.Configured() {
		return GitHubAppConfig{}, errors.New(
			"AO_CLOUD_GITHUB_APP_ID, AO_CLOUD_GITHUB_APP_SLUG, and AO_CLOUD_GITHUB_APP_PRIVATE_KEY must be set together",
		)
	}
	if (cfg.OAuthClientID == "") != (cfg.OAuthClientSecret == "") {
		return GitHubAppConfig{}, errors.New(
			"AO_CLOUD_GITHUB_APP_CLIENT_ID and AO_CLOUD_GITHUB_APP_CLIENT_SECRET must be set together",
		)
	}
	return cfg, nil
}

func optionalInt64(raw string) (int64, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, nil
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value <= 0 {
		return 0, errors.New("must be a positive integer")
	}
	return value, nil
}

// pemValue accepts the key either literally or base64-encoded. Task-definition
// environments frequently mangle real newlines, so an escaped "\n" is restored
// rather than rejected.
func pemValue(literal, encoded string) ([]byte, error) {
	if trimmed := strings.TrimSpace(encoded); trimmed != "" {
		decoded, err := base64.StdEncoding.DecodeString(trimmed)
		if err != nil {
			return nil, errors.New("base64 value could not be decoded")
		}
		return decoded, nil
	}
	trimmed := strings.TrimSpace(literal)
	if trimmed == "" {
		return nil, nil
	}
	return []byte(strings.ReplaceAll(trimmed, `\n`, "\n")), nil
}
