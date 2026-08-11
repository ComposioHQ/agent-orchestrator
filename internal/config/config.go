package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	HTTPAddress      string
	DatabaseURL      string
	WorkOSIssuer     string
	WorkOSClientID   string
	WorkOSAPIKey     string
	WorkOSJWKSURL    string
	LocalAuthEnabled bool
	LocalSessionTTL  time.Duration
}

func Load() (Config, error) {
	cfg := Config{
		HTTPAddress:      envOrDefault("AO_CLOUD_HTTP_ADDRESS", ":8080"),
		DatabaseURL:      strings.TrimSpace(os.Getenv("AO_CLOUD_DATABASE_URL")),
		WorkOSIssuer:     strings.TrimSpace(os.Getenv("AO_CLOUD_WORKOS_ISSUER")),
		WorkOSClientID:   strings.TrimSpace(os.Getenv("AO_CLOUD_WORKOS_CLIENT_ID")),
		WorkOSAPIKey:     strings.TrimSpace(os.Getenv("AO_CLOUD_WORKOS_API_KEY")),
		WorkOSJWKSURL:    strings.TrimSpace(os.Getenv("AO_CLOUD_WORKOS_JWKS_URL")),
		LocalAuthEnabled: boolEnv("AO_CLOUD_LOCAL_AUTH", false),
		LocalSessionTTL:  durationEnv("AO_CLOUD_LOCAL_SESSION_TTL", 24*time.Hour),
	}
	if cfg.DatabaseURL == "" {
		return Config{}, errors.New("AO_CLOUD_DATABASE_URL is required")
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
	if cfg.LocalSessionTTL <= 0 {
		return Config{}, errors.New("AO_CLOUD_LOCAL_SESSION_TTL must be positive")
	}
	return cfg, nil
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
		authMode += "+local"
	}
	return fmt.Sprintf("address=%s auth=%s", c.HTTPAddress, authMode)
}
