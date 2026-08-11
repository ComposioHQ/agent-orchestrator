package config

import (
	"testing"
	"time"
)

func TestLoadLocalDevelopmentConfiguration(t *testing.T) {
	t.Setenv("AO_CLOUD_DATABASE_URL", "postgres://localhost/ao")
	t.Setenv("AO_CLOUD_LOCAL_AUTH", "true")
	t.Setenv("AO_CLOUD_LOCAL_SESSION_TTL", "2h")
	t.Setenv("AO_CLOUD_WORKOS_ISSUER", "")
	t.Setenv("AO_CLOUD_WORKOS_CLIENT_ID", "")
	t.Setenv("AO_CLOUD_WORKOS_API_KEY", "")
	t.Setenv("AO_CLOUD_WORKOS_JWKS_URL", "")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.LocalAuthEnabled || cfg.LocalSessionTTL != 2*time.Hour {
		t.Fatalf("config = %#v", cfg)
	}
}

func TestLoadRequiresCompleteWorkOSConfiguration(t *testing.T) {
	t.Setenv("AO_CLOUD_DATABASE_URL", "postgres://localhost/ao")
	t.Setenv("AO_CLOUD_WORKOS_ISSUER", "https://example.com")
	t.Setenv("AO_CLOUD_WORKOS_CLIENT_ID", "client_123")
	t.Setenv("AO_CLOUD_WORKOS_API_KEY", "")
	t.Setenv("AO_CLOUD_WORKOS_JWKS_URL", "")
	t.Setenv("AO_CLOUD_LOCAL_AUTH", "false")

	if _, err := Load(); err == nil {
		t.Fatal("Load succeeded without AO_CLOUD_WORKOS_API_KEY")
	}
}

func TestLoadDerivesWorkOSJWKSURL(t *testing.T) {
	t.Setenv("AO_CLOUD_DATABASE_URL", "postgres://localhost/ao")
	t.Setenv("AO_CLOUD_WORKOS_ISSUER", "https://api.workos.com/")
	t.Setenv("AO_CLOUD_WORKOS_CLIENT_ID", "client_123")
	t.Setenv("AO_CLOUD_WORKOS_API_KEY", "secret")
	t.Setenv("AO_CLOUD_WORKOS_JWKS_URL", "")
	t.Setenv("AO_CLOUD_LOCAL_AUTH", "false")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.WorkOSJWKSURL != "https://api.workos.com/sso/jwks/client_123" {
		t.Fatalf("JWKS URL = %q", cfg.WorkOSJWKSURL)
	}
}
