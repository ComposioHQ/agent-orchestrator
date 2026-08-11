package config

import (
	"errors"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var releasePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$`)

type Config struct {
	Environment          string
	HTTPAddress          string
	DatabaseURL          string
	MigrationDatabaseURL string
	MigrateOnStartup     bool
	WorkOSIssuer         string
	WorkOSClientID       string
	WorkOSAPIKey         string
	WorkOSJWKSURL        string
	LocalAuthEnabled     bool
	LocalSessionTTL      time.Duration
	SandboxProvider      string
	Release              string
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
		WorkOSIssuer:         strings.TrimSpace(os.Getenv("AO_CLOUD_WORKOS_ISSUER")),
		WorkOSClientID:       strings.TrimSpace(os.Getenv("AO_CLOUD_WORKOS_CLIENT_ID")),
		WorkOSAPIKey:         strings.TrimSpace(os.Getenv("AO_CLOUD_WORKOS_API_KEY")),
		WorkOSJWKSURL:        strings.TrimSpace(os.Getenv("AO_CLOUD_WORKOS_JWKS_URL")),
		LocalAuthEnabled:     boolEnv("AO_CLOUD_LOCAL_AUTH", false),
		LocalSessionTTL:      durationEnv("AO_CLOUD_LOCAL_SESSION_TTL", 24*time.Hour),
		SandboxProvider:      strings.ToLower(envOrDefault("AO_CLOUD_SANDBOX_PROVIDER", "ecs")),
		Release:              strings.TrimSpace(os.Getenv("AO_CLOUD_RELEASE")),
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
	if cfg.WorkOSIssuer != "" && cfg.WorkOSJWKSURL == "" {
		if strings.TrimRight(cfg.WorkOSIssuer, "/") == "https://api.workos.com" {
			cfg.WorkOSJWKSURL = "https://api.workos.com/sso/jwks/" + cfg.WorkOSClientID
		} else {
			cfg.WorkOSJWKSURL = strings.TrimRight(cfg.WorkOSIssuer, "/") + "/oauth2/jwks"
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

func (c Config) String() string {
	authMode := "workos"
	if c.LocalAuthEnabled {
		authMode = "local"
	}
	return fmt.Sprintf("environment=%s address=%s auth=%s release=%s", c.Environment, c.HTTPAddress, authMode, c.Release)
}
