package config

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var releasePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$`)
var githubSlugPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{0,99}$`)

const workOSAPIBaseURL = "https://api.workos.com"

type Config struct {
	Environment          string
	HTTPAddress          string
	DatabaseURL          string
	MigrationDatabaseURL string
	MigrateOnStartup     bool
	MigrationTimeout     time.Duration
	WorkOSIssuer         string
	WorkOSClientID       string
	WorkOSAPIKey         string
	WorkOSJWKSURL        string
	LocalAuthEnabled     bool
	LocalSessionTTL      time.Duration
	SandboxProvider      string
	Release              string
	GitHub               GitHubConfig
}

type GitHubConfig struct {
	AppID          int64
	AppSlug        string
	ClientID       string
	ClientSecret   string
	PrivateKeyPEM  string
	WebhookSecret  string
	StateKey       []byte
	PublicURL      string
	InstallTTL     time.Duration
	WebhookMaxBody int64
}

func (c GitHubConfig) Enabled() bool {
	return c.AppID != 0
}

func Load() (Config, error) {
	environment := strings.ToLower(strings.TrimSpace(os.Getenv("AO_CLOUD_ENV")))
	hosted := environment == "staging" || environment == "production"
	defaultHTTPAddress := ":8080"
	if environment == "development" || environment == "test" {
		defaultHTTPAddress = "127.0.0.1:8080"
	}
	cfg := Config{
		Environment:          environment,
		HTTPAddress:          envOrDefault("AO_CLOUD_HTTP_ADDRESS", defaultHTTPAddress),
		DatabaseURL:          strings.TrimSpace(os.Getenv("AO_CLOUD_DATABASE_URL")),
		MigrationDatabaseURL: strings.TrimSpace(os.Getenv("AO_CLOUD_MIGRATION_DATABASE_URL")),
		MigrateOnStartup:     boolEnv("AO_CLOUD_MIGRATE_ON_STARTUP", !hosted),
		MigrationTimeout:     durationEnv("AO_CLOUD_MIGRATION_TIMEOUT", 15*time.Minute),
		WorkOSIssuer:         strings.TrimSpace(os.Getenv("AO_CLOUD_WORKOS_ISSUER")),
		WorkOSClientID:       strings.TrimSpace(os.Getenv("AO_CLOUD_WORKOS_CLIENT_ID")),
		WorkOSAPIKey:         strings.TrimSpace(os.Getenv("AO_CLOUD_WORKOS_API_KEY")),
		WorkOSJWKSURL:        strings.TrimSpace(os.Getenv("AO_CLOUD_WORKOS_JWKS_URL")),
		LocalAuthEnabled:     boolEnv("AO_CLOUD_LOCAL_AUTH", false),
		LocalSessionTTL:      durationEnv("AO_CLOUD_LOCAL_SESSION_TTL", 24*time.Hour),
		SandboxProvider:      strings.ToLower(envOrDefault("AO_CLOUD_SANDBOX_PROVIDER", "ecs")),
		Release:              strings.TrimSpace(os.Getenv("AO_CLOUD_RELEASE")),
		GitHub: GitHubConfig{
			AppID:          int64Env("AO_CLOUD_GITHUB_APP_ID"),
			AppSlug:        strings.TrimSpace(os.Getenv("AO_CLOUD_GITHUB_APP_SLUG")),
			ClientID:       strings.TrimSpace(os.Getenv("AO_CLOUD_GITHUB_CLIENT_ID")),
			ClientSecret:   strings.TrimSpace(os.Getenv("AO_CLOUD_GITHUB_CLIENT_SECRET")),
			PrivateKeyPEM:  strings.TrimSpace(os.Getenv("AO_CLOUD_GITHUB_PRIVATE_KEY")),
			WebhookSecret:  strings.TrimSpace(os.Getenv("AO_CLOUD_GITHUB_WEBHOOK_SECRET")),
			PublicURL:      strings.TrimRight(strings.TrimSpace(os.Getenv("AO_CLOUD_PUBLIC_URL")), "/"),
			InstallTTL:     durationEnv("AO_CLOUD_GITHUB_INSTALL_TTL", 10*time.Minute),
			WebhookMaxBody: int64EnvOrDefault("AO_CLOUD_GITHUB_WEBHOOK_MAX_BYTES", 2<<20),
		},
	}
	stateKey := strings.TrimSpace(os.Getenv("AO_CLOUD_GITHUB_STATE_KEY"))
	if stateKey != "" {
		decoded, err := base64.StdEncoding.DecodeString(stateKey)
		if err != nil || len(decoded) != 32 {
			return Config{}, errors.New("AO_CLOUD_GITHUB_STATE_KEY must be base64-encoded 32 bytes")
		}
		cfg.GitHub.StateKey = decoded
	}
	if value := strings.TrimSpace(os.Getenv("AO_CLOUD_MIGRATION_TIMEOUT")); value != "" {
		timeout, err := time.ParseDuration(value)
		if err != nil || timeout <= 0 {
			return Config{}, errors.New("AO_CLOUD_MIGRATION_TIMEOUT must be a positive duration")
		}
		cfg.MigrationTimeout = timeout
	}
	if cfg.DatabaseURL == "" {
		return Config{}, errors.New("AO_CLOUD_DATABASE_URL is required")
	}
	if cfg.MigrationDatabaseURL == "" {
		cfg.MigrationDatabaseURL = cfg.DatabaseURL
	}
	switch cfg.Environment {
	case "development", "test", "staging", "production":
	default:
		return Config{}, errors.New("AO_CLOUD_ENV must be development, test, staging, or production")
	}
	workosValues := []string{cfg.WorkOSIssuer, cfg.WorkOSClientID, cfg.WorkOSAPIKey}
	configuredWorkOSValues := 0
	for _, value := range workosValues {
		if value != "" {
			configuredWorkOSValues++
		}
	}
	if configuredWorkOSValues != 0 && configuredWorkOSValues != len(workosValues) {
		return Config{}, errors.New("AO_CLOUD_WORKOS_ISSUER, AO_CLOUD_WORKOS_CLIENT_ID, and AO_CLOUD_WORKOS_API_KEY must be set together")
	}
	if strings.TrimRight(cfg.WorkOSIssuer, "/") == workOSAPIBaseURL {
		cfg.WorkOSIssuer = workOSAPIBaseURL + "/user_management/" + cfg.WorkOSClientID
	}
	if cfg.WorkOSIssuer != "" {
		workOSIssuer := workOSAPIBaseURL + "/user_management/" + cfg.WorkOSClientID
		if strings.HasPrefix(cfg.WorkOSIssuer, workOSAPIBaseURL+"/user_management/") &&
			cfg.WorkOSIssuer != workOSIssuer {
			return Config{}, errors.New("AO_CLOUD_WORKOS_ISSUER must match AO_CLOUD_WORKOS_CLIENT_ID")
		}
		if cfg.WorkOSJWKSURL == "" {
			if cfg.WorkOSIssuer == workOSIssuer {
				cfg.WorkOSJWKSURL = workOSAPIBaseURL + "/sso/jwks/" + cfg.WorkOSClientID
			} else {
				cfg.WorkOSJWKSURL = strings.TrimRight(cfg.WorkOSIssuer, "/") + "/oauth2/jwks"
			}
		}
	}
	if cfg.WorkOSIssuer == "" && !cfg.LocalAuthEnabled {
		return Config{}, errors.New("configure WorkOS or enable AO_CLOUD_LOCAL_AUTH")
	}
	if cfg.LocalAuthEnabled && cfg.Hosted() {
		return Config{}, errors.New("AO_CLOUD_LOCAL_AUTH cannot be enabled in staging or production")
	}
	if cfg.LocalAuthEnabled && cfg.WorkOSIssuer != "" {
		return Config{}, errors.New("AO_CLOUD_LOCAL_AUTH cannot be combined with WorkOS")
	}
	if cfg.LocalSessionTTL <= 0 {
		return Config{}, errors.New("AO_CLOUD_LOCAL_SESSION_TTL must be positive")
	}
	switch cfg.SandboxProvider {
	case "ecs", "daytona", "docker":
	default:
		return Config{}, errors.New("AO_CLOUD_SANDBOX_PROVIDER must be ecs, daytona, or docker")
	}
	if cfg.Release == "" {
		if cfg.Hosted() {
			return Config{}, errors.New("AO_CLOUD_RELEASE is required in staging and production")
		}
		cfg.Release = "dev"
	}
	if !releasePattern.MatchString(cfg.Release) {
		return Config{}, errors.New("AO_CLOUD_RELEASE must be a release tag or Git SHA")
	}
	githubValues := []bool{
		cfg.GitHub.AppID > 0,
		cfg.GitHub.AppSlug != "",
		cfg.GitHub.ClientID != "",
		cfg.GitHub.ClientSecret != "",
		cfg.GitHub.PrivateKeyPEM != "",
		cfg.GitHub.WebhookSecret != "",
		len(cfg.GitHub.StateKey) != 0,
		cfg.GitHub.PublicURL != "",
	}
	configuredGitHubValues := 0
	for _, configured := range githubValues {
		if configured {
			configuredGitHubValues++
		}
	}
	if configuredGitHubValues != 0 && configuredGitHubValues != len(githubValues) {
		return Config{}, errors.New("all AO_CLOUD_GITHUB_* credentials and AO_CLOUD_PUBLIC_URL must be set together")
	}
	if cfg.GitHub.Enabled() {
		publicURL, err := url.Parse(cfg.GitHub.PublicURL)
		if err != nil || publicURL.Host == "" || publicURL.User != nil ||
			(publicURL.Path != "" && publicURL.Path != "/") ||
			publicURL.RawQuery != "" || publicURL.Fragment != "" ||
			(publicURL.Scheme != "http" && publicURL.Scheme != "https") {
			return Config{}, errors.New("AO_CLOUD_PUBLIC_URL must be an absolute origin without credentials, path, query, or fragment")
		}
		if cfg.Hosted() && publicURL.Scheme != "https" {
			return Config{}, errors.New("AO_CLOUD_PUBLIC_URL must use HTTPS in hosted environments")
		}
		if !githubSlugPattern.MatchString(cfg.GitHub.AppSlug) {
			return Config{}, errors.New("AO_CLOUD_GITHUB_APP_SLUG is invalid")
		}
		if cfg.GitHub.InstallTTL <= 0 || cfg.GitHub.InstallTTL > 30*time.Minute {
			return Config{}, errors.New("AO_CLOUD_GITHUB_INSTALL_TTL must be positive and no more than 30 minutes")
		}
		if cfg.GitHub.WebhookMaxBody < 1024 || cfg.GitHub.WebhookMaxBody > 10<<20 {
			return Config{}, errors.New("AO_CLOUD_GITHUB_WEBHOOK_MAX_BYTES must be between 1024 and 10485760")
		}
	}
	return cfg, nil
}

func (c Config) Hosted() bool {
	return c.Environment == "staging" || c.Environment == "production"
}

func envOrDefault(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func boolEnv(key string, fallback bool) bool {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func durationEnv(key string, fallback time.Duration) time.Duration {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func int64Env(key string) int64 {
	value, _ := strconv.ParseInt(strings.TrimSpace(os.Getenv(key)), 10, 64)
	return value
}

func int64EnvOrDefault(key string, fallback int64) int64 {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0
	}
	return parsed
}

func (c Config) String() string {
	authMode := "workos"
	if c.LocalAuthEnabled {
		authMode = "local"
	}
	return fmt.Sprintf("environment=%s address=%s auth=%s release=%s", c.Environment, c.HTTPAddress, authMode, c.Release)
}
