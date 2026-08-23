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

const (
	// EnvGitHubSecret is the optional JSON secret-document environment key.
	EnvGitHubSecret         = "AO_CLOUD_SCM_GITHUB_SECRET" //nolint:gosec // environment key name
	envAppID                = "AO_CLOUD_GITHUB_APP_ID"
	envAppSlug              = "AO_CLOUD_GITHUB_APP_SLUG"
	envPrivateKey           = "AO_CLOUD_GITHUB_APP_PRIVATE_KEY_BASE64" //nolint:gosec // environment key name
	envWebhookSecret        = "AO_CLOUD_GITHUB_APP_WEBHOOK_SECRET"     //nolint:gosec // environment key name
	envOAuthClientID        = "AO_CLOUD_GITHUB_APP_CLIENT_ID"
	envOAuthClientSecret    = "AO_CLOUD_GITHUB_APP_CLIENT_SECRET" //nolint:gosec // environment key name
	envInstallCompletionURL = "AO_CLOUD_GITHUB_APP_INSTALL_COMPLETION_URL"
	envGitHubAPIBase        = "AO_CLOUD_GITHUB_API_BASE"
	envGitHubWebBase        = "AO_CLOUD_GITHUB_WEB_BASE"
)

type githubSecretDocument struct {
	AppID             json.Number `json:"githubAppId"`
	AppSlug           string      `json:"githubAppSlug"`
	PrivateKeyBase64  string      `json:"githubAppPrivateKeyBase64"`
	WebhookSecret     string      `json:"githubWebhookSecret"`
	OAuthClientID     string      `json:"githubOAuthClientId"`
	OAuthClientSecret string      `json:"githubOAuthClientSecret"`
}

// Config is the validated, all-or-nothing GitHub App configuration.
type Config struct {
	AppID                int64
	AppSlug              string
	PrivateKeyPEM        []byte
	WebhookSecret        []byte
	OAuthClientID        string
	OAuthClientSecret    string
	APIBase              string
	WebBase              string
	InstallCompletionURL string
}

// LoadConfig reads GitHub App configuration from the process environment.
func LoadConfig() (Config, error) { return loadConfig(os.Getenv) }

func loadConfig(getenv func(string) string) (Config, error) {
	document, err := decodeGitHubSecretDocument(getenv(EnvGitHubSecret))
	if err != nil {
		return Config{}, err
	}
	appID, err := parseOptionalPositiveInt(firstNonEmpty(document.AppID.String(), getenv(envAppID)))
	if err != nil {
		return Config{}, fmt.Errorf("%s: %w", envAppID, err)
	}
	privateKey, err := decodeSecretBase64(firstNonEmpty(document.PrivateKeyBase64, getenv(envPrivateKey)))
	if err != nil {
		return Config{}, fmt.Errorf("%s: %w", envPrivateKey, err)
	}
	config := Config{
		AppID:                appID,
		AppSlug:              firstNonEmpty(document.AppSlug, getenv(envAppSlug)),
		PrivateKeyPEM:        privateKey,
		WebhookSecret:        []byte(firstNonEmpty(document.WebhookSecret, getenv(envWebhookSecret))),
		OAuthClientID:        firstNonEmpty(document.OAuthClientID, getenv(envOAuthClientID)),
		OAuthClientSecret:    firstNonEmpty(document.OAuthClientSecret, getenv(envOAuthClientSecret)),
		APIBase:              strings.TrimSpace(getenv(envGitHubAPIBase)),
		WebBase:              strings.TrimSpace(getenv(envGitHubWebBase)),
		InstallCompletionURL: strings.TrimSpace(getenv(envInstallCompletionURL)),
	}
	if err := config.Validate(); err != nil {
		zeroBytes(config.PrivateKeyPEM)
		zeroBytes(config.WebhookSecret)
		return Config{}, err
	}
	return config, nil
}

// Enabled reports whether the complete production GitHub App boundary is configured.
func (c Config) Enabled() bool {
	return c.AppID > 0 && strings.TrimSpace(c.AppSlug) != "" && len(c.PrivateKeyPEM) > 0 &&
		len(c.WebhookSecret) > 0 && strings.TrimSpace(c.OAuthClientID) != "" &&
		strings.TrimSpace(c.OAuthClientSecret) != ""
}

// Validate rejects partial SCM configuration and permits a completely disabled slice.
func (c Config) Validate() error {
	present := c.AppID > 0 || strings.TrimSpace(c.AppSlug) != "" || len(c.PrivateKeyPEM) > 0 ||
		len(c.WebhookSecret) > 0 || strings.TrimSpace(c.OAuthClientID) != "" ||
		strings.TrimSpace(c.OAuthClientSecret) != ""
	if present && !c.Enabled() {
		return errors.New("cloud scm: GitHub App id, slug, private key, webhook secret, and OAuth client credentials must be configured together")
	}
	return nil
}

func decodeGitHubSecretDocument(raw string) (githubSecretDocument, error) {
	if strings.TrimSpace(raw) == "" {
		return githubSecretDocument{}, nil
	}
	var document githubSecretDocument
	if err := json.Unmarshal([]byte(raw), &document); err != nil {
		return githubSecretDocument{}, errors.New("cloud scm: GitHub secret document is invalid")
	}
	return document, nil
}

func parseOptionalPositiveInt(raw string) (int64, error) {
	if strings.TrimSpace(raw) == "" {
		return 0, nil
	}
	value, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || value <= 0 {
		return 0, errors.New("must be a positive integer")
	}
	return value, nil
}

func decodeSecretBase64(raw string) ([]byte, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(raw))
	if err != nil {
		return nil, errors.New("value is not valid base64")
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
