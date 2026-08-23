package scm

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Environment variables the SCM boundary reads. The three credential values
// arrive as one Secrets Manager document under AO_CLOUD_SCM_GITHUB_SECRET, or
// individually when a deployment injects secret keys as separate variables.
const (
	// EnvGitHubSecret is a JSON document with the githubAppId,
	// githubAppPrivateKeyBase64, and githubWebhookSecret fields.
	EnvGitHubSecret = "AO_CLOUD_SCM_GITHUB_SECRET" //nolint:gosec // variable name, not a credential

	envAppID                = "AO_CLOUD_GITHUB_APP_ID"
	envAppPrivateKeyBase64  = "AO_CLOUD_GITHUB_APP_PRIVATE_KEY_BASE64" //nolint:gosec // variable name, not a credential
	envWebhookSecret        = "AO_CLOUD_GITHUB_APP_WEBHOOK_SECRET"     //nolint:gosec // variable name, not a credential
	envAppSlug              = "AO_CLOUD_GITHUB_APP_SLUG"
	envOAuthClientID        = "AO_CLOUD_GITHUB_APP_CLIENT_ID"
	envOAuthClientSecret    = "AO_CLOUD_GITHUB_APP_CLIENT_SECRET" //nolint:gosec // variable name, not a credential
	envInstallCompletionURL = "AO_CLOUD_GITHUB_APP_INSTALL_COMPLETION_URL"
	envAPIBase              = "AO_CLOUD_GITHUB_API_BASE"
	envWebBase              = "AO_CLOUD_GITHUB_WEB_BASE"
)

// githubSecret is the Secrets Manager document. Field names are fixed by the
// deployment contract; do not rename them without changing the secret.
type githubSecret struct {
	GitHubAppID               json.Number `json:"githubAppId"`
	GitHubAppPrivateKeyBase64 string      `json:"githubAppPrivateKeyBase64"`
	GitHubWebhookSecret       string      `json:"githubWebhookSecret"`
}

// Config is the validated SCM credential-boundary configuration.
//
// It lives in this package rather than in the shared cloud config so the SCM
// slice owns its own environment surface. The whole group is optional: a
// deployment with no GitHub App simply has no cloud SCM, and Enabled reports
// that. Partial configuration is an error, because a half-built install flow
// that can never mint a credential is worse than no install flow.
type Config struct {
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
	// callback finishes. Empty answers the callback with JSON.
	InstallCompletionURL string
}

// LoadConfig reads the SCM configuration from the process environment.
func LoadConfig() (Config, error) {
	return loadConfig(os.Getenv)
}

func loadConfig(getenv func(string) string) (Config, error) {
	secret, err := decodeGitHubSecret(getenv(EnvGitHubSecret))
	if err != nil {
		return Config{}, err
	}
	appIDRaw := firstNonEmpty(secret.GitHubAppID.String(), getenv(envAppID))
	appID, err := optionalInt64(appIDRaw)
	if err != nil {
		return Config{}, fmt.Errorf("%s: %w", envAppID, err)
	}
	privateKey, err := decodeBase64(
		firstNonEmpty(secret.GitHubAppPrivateKeyBase64, getenv(envAppPrivateKeyBase64)),
	)
	if err != nil {
		return Config{}, fmt.Errorf("%s: %w", envAppPrivateKeyBase64, err)
	}
	cfg := Config{
		AppID:                appID,
		AppSlug:              strings.TrimSpace(getenv(envAppSlug)),
		PrivateKeyPEM:        privateKey,
		WebhookSecret:        []byte(firstNonEmpty(secret.GitHubWebhookSecret, getenv(envWebhookSecret))),
		OAuthClientID:        strings.TrimSpace(getenv(envOAuthClientID)),
		OAuthClientSecret:    strings.TrimSpace(getenv(envOAuthClientSecret)),
		APIBase:              strings.TrimSpace(getenv(envAPIBase)),
		WebBase:              strings.TrimSpace(getenv(envWebBase)),
		InstallCompletionURL: strings.TrimSpace(getenv(envInstallCompletionURL)),
	}
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// Enabled reports whether enough is configured to mint installation tokens.
func (c Config) Enabled() bool {
	return c.AppID > 0 && strings.TrimSpace(c.AppSlug) != "" && len(c.PrivateKeyPEM) > 0
}

// WebhooksEnabled reports whether the webhook endpoint can verify signatures.
// Without a secret the endpoint stays unmounted rather than accepting
// unverified deliveries.
func (c Config) WebhooksEnabled() bool {
	return c.Enabled() && len(c.WebhookSecret) > 0
}

// Validate rejects a partially configured GitHub App. It is safe to call on a
// fully empty Config, which simply means cloud SCM is off.
func (c Config) Validate() error {
	present := c.AppID > 0 || strings.TrimSpace(c.AppSlug) != "" || len(c.PrivateKeyPEM) > 0
	if present && !c.Enabled() {
		return fmt.Errorf(
			"%s, %s, and %s must be set together",
			envAppID, envAppSlug, envAppPrivateKeyBase64,
		)
	}
	if (c.OAuthClientID == "") != (c.OAuthClientSecret == "") {
		return fmt.Errorf("%s and %s must be set together", envOAuthClientID, envOAuthClientSecret)
	}
	return nil
}

func decodeGitHubSecret(raw string) (githubSecret, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return githubSecret{}, nil
	}
	var secret githubSecret
	if err := json.Unmarshal([]byte(raw), &secret); err != nil {
		// The document is credential material. Report only that it is
		// unreadable, never what it contained.
		return githubSecret{}, errors.New(EnvGitHubSecret + ": value is not a readable JSON secret document")
	}
	return secret, nil
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

func decodeBase64(raw string) ([]byte, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	decoded, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		// Never echo the offered value: it is the app private key.
		return nil, errors.New("value could not be base64-decoded")
	}
	return decoded, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" && trimmed != "0" {
			return trimmed
		}
	}
	return ""
}
