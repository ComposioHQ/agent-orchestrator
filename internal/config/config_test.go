package config

import (
	"encoding/base64"
	"testing"
	"time"
)

func TestLoadLocalDevelopmentConfiguration(t *testing.T) {
	t.Setenv("AO_CLOUD_ENV", "development")
	t.Setenv("AO_CLOUD_HTTP_ADDRESS", "")
	t.Setenv("AO_CLOUD_DATABASE_URL", "postgres://localhost/ao")
	t.Setenv("AO_CLOUD_MIGRATION_DATABASE_URL", "")
	t.Setenv("AO_CLOUD_MIGRATION_TIMEOUT", "")
	t.Setenv("AO_CLOUD_LOCAL_AUTH", "true")
	t.Setenv("AO_CLOUD_LOCAL_SESSION_TTL", "2h")
	t.Setenv("AO_CLOUD_WORKOS_ISSUER", "")
	t.Setenv("AO_CLOUD_WORKOS_CLIENT_ID", "")
	t.Setenv("AO_CLOUD_WORKOS_API_KEY", "")
	t.Setenv("AO_CLOUD_WORKOS_JWKS_URL", "")
	t.Setenv("AO_CLOUD_SANDBOX_PROVIDER", "")
	t.Setenv("AO_CLOUD_RELEASE", "")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.LocalAuthEnabled ||
		!cfg.MigrateOnStartup ||
		cfg.LocalSessionTTL != 2*time.Hour ||
		cfg.MigrationTimeout != 15*time.Minute ||
		cfg.HTTPAddress != "127.0.0.1:8080" ||
		cfg.SandboxProvider != "ecs" ||
		cfg.Release != "dev" ||
		cfg.MigrationDatabaseURL != cfg.DatabaseURL {
		t.Fatalf("config = %#v", cfg)
	}
}

func TestLoadRejectsInvalidMigrationTimeout(t *testing.T) {
	t.Setenv("AO_CLOUD_ENV", "development")
	t.Setenv("AO_CLOUD_DATABASE_URL", "postgres://localhost/ao")
	t.Setenv("AO_CLOUD_LOCAL_AUTH", "true")
	t.Setenv("AO_CLOUD_MIGRATION_TIMEOUT", "forever")

	if _, err := Load(); err == nil {
		t.Fatal("Load succeeded with an invalid migration timeout")
	}
}

func TestLoadRejectsUnknownSandboxProvider(t *testing.T) {
	t.Setenv("AO_CLOUD_ENV", "development")
	t.Setenv("AO_CLOUD_DATABASE_URL", "postgres://localhost/ao")
	t.Setenv("AO_CLOUD_LOCAL_AUTH", "false")
	t.Setenv("AO_CLOUD_SANDBOX_PROVIDER", "unknown")

	if _, err := Load(); err == nil {
		t.Fatal("Load succeeded with an unknown sandbox provider")
	}
}

func TestLoadRequiresCompleteWorkOSConfiguration(t *testing.T) {
	t.Setenv("AO_CLOUD_ENV", "production")
	t.Setenv("AO_CLOUD_DATABASE_URL", "postgres://localhost/ao")
	t.Setenv("AO_CLOUD_WORKOS_ISSUER", "https://example.com")
	t.Setenv("AO_CLOUD_WORKOS_CLIENT_ID", "client_123")
	t.Setenv("AO_CLOUD_WORKOS_API_KEY", "")
	t.Setenv("AO_CLOUD_WORKOS_JWKS_URL", "")
	t.Setenv("AO_CLOUD_LOCAL_AUTH", "false")
	t.Setenv("AO_CLOUD_RELEASE", "sha-123")

	if _, err := Load(); err == nil {
		t.Fatal("Load succeeded without AO_CLOUD_WORKOS_API_KEY")
	}
}

func TestLoadStagingConfiguration(t *testing.T) {
	t.Setenv("AO_CLOUD_ENV", "staging")
	t.Setenv("AO_CLOUD_DATABASE_URL", "postgres://localhost/ao")
	t.Setenv("AO_CLOUD_WORKOS_ISSUER", "https://api.workos.com/")
	t.Setenv("AO_CLOUD_WORKOS_CLIENT_ID", "client_123")
	t.Setenv("AO_CLOUD_WORKOS_API_KEY", "secret")
	t.Setenv("AO_CLOUD_LOCAL_AUTH", "false")
	t.Setenv("AO_CLOUD_RELEASE", "sha-staging")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.Hosted() ||
		cfg.MigrateOnStartup ||
		cfg.Release != "sha-staging" ||
		cfg.HTTPAddress != ":8080" {
		t.Fatalf("config = %#v", cfg)
	}
}

func TestLoadRequiresHostedRelease(t *testing.T) {
	t.Setenv("AO_CLOUD_ENV", "staging")
	t.Setenv("AO_CLOUD_DATABASE_URL", "postgres://localhost/ao")
	t.Setenv("AO_CLOUD_WORKOS_ISSUER", "https://api.workos.com/")
	t.Setenv("AO_CLOUD_WORKOS_CLIENT_ID", "client_123")
	t.Setenv("AO_CLOUD_WORKOS_API_KEY", "secret")
	t.Setenv("AO_CLOUD_LOCAL_AUTH", "false")
	t.Setenv("AO_CLOUD_RELEASE", "")

	if _, err := Load(); err == nil {
		t.Fatal("Load succeeded without a hosted release")
	}
}

func TestLoadRejectsInvalidRelease(t *testing.T) {
	t.Setenv("AO_CLOUD_ENV", "development")
	t.Setenv("AO_CLOUD_DATABASE_URL", "postgres://localhost/ao")
	t.Setenv("AO_CLOUD_LOCAL_AUTH", "true")
	t.Setenv("AO_CLOUD_RELEASE", "bad release")

	if _, err := Load(); err == nil {
		t.Fatal("Load succeeded with an invalid release")
	}
}

func TestLoadDerivesWorkOSJWKSURL(t *testing.T) {
	t.Setenv("AO_CLOUD_ENV", "production")
	t.Setenv("AO_CLOUD_DATABASE_URL", "postgres://localhost/ao")
	t.Setenv("AO_CLOUD_WORKOS_ISSUER", "https://api.workos.com/")
	t.Setenv("AO_CLOUD_WORKOS_CLIENT_ID", "client_123")
	t.Setenv("AO_CLOUD_WORKOS_API_KEY", "secret")
	t.Setenv("AO_CLOUD_WORKOS_JWKS_URL", "")
	t.Setenv("AO_CLOUD_LOCAL_AUTH", "false")
	t.Setenv("AO_CLOUD_RELEASE", "sha-123")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.WorkOSIssuer != "https://api.workos.com/user_management/client_123" ||
		cfg.WorkOSJWKSURL != "https://api.workos.com/sso/jwks/client_123" {
		t.Fatalf("WorkOS config = issuer %q, JWKS URL %q", cfg.WorkOSIssuer, cfg.WorkOSJWKSURL)
	}
}

func TestLoadRejectsMismatchedWorkOSIssuer(t *testing.T) {
	t.Setenv("AO_CLOUD_ENV", "production")
	t.Setenv("AO_CLOUD_DATABASE_URL", "postgres://localhost/ao")
	t.Setenv(
		"AO_CLOUD_WORKOS_ISSUER",
		"https://api.workos.com/user_management/other_client",
	)
	t.Setenv("AO_CLOUD_WORKOS_CLIENT_ID", "client_123")
	t.Setenv("AO_CLOUD_WORKOS_API_KEY", "secret")
	t.Setenv("AO_CLOUD_RELEASE", "sha-123")

	if _, err := Load(); err == nil {
		t.Fatal("Load succeeded with a mismatched WorkOS issuer")
	}
}

func TestLoadRejectsLocalAuthOutsideDevelopment(t *testing.T) {
	t.Setenv("AO_CLOUD_ENV", "production")
	t.Setenv("AO_CLOUD_DATABASE_URL", "postgres://localhost/ao")
	t.Setenv("AO_CLOUD_LOCAL_AUTH", "true")
	t.Setenv("AO_CLOUD_WORKOS_ISSUER", "")
	t.Setenv("AO_CLOUD_WORKOS_CLIENT_ID", "")
	t.Setenv("AO_CLOUD_WORKOS_API_KEY", "")

	if _, err := Load(); err == nil {
		t.Fatal("Load succeeded with production local auth")
	}
}

func TestLoadRejectsLocalAuthWithWorkOS(t *testing.T) {
	t.Setenv("AO_CLOUD_ENV", "development")
	t.Setenv("AO_CLOUD_DATABASE_URL", "postgres://localhost/ao")
	t.Setenv("AO_CLOUD_LOCAL_AUTH", "true")
	t.Setenv("AO_CLOUD_WORKOS_ISSUER", "https://api.workos.com/")
	t.Setenv("AO_CLOUD_WORKOS_CLIENT_ID", "client_123")
	t.Setenv("AO_CLOUD_WORKOS_API_KEY", "secret")

	if _, err := Load(); err == nil {
		t.Fatal("Load succeeded with local auth and WorkOS")
	}
}

func TestLoadRequiresCompleteGitHubConfiguration(t *testing.T) {
	t.Setenv("AO_CLOUD_ENV", "development")
	t.Setenv("AO_CLOUD_DATABASE_URL", "postgres://localhost/ao")
	t.Setenv("AO_CLOUD_LOCAL_AUTH", "true")
	t.Setenv("AO_CLOUD_GITHUB_APP_ID", "123")

	if _, err := Load(); err == nil {
		t.Fatal("Load succeeded with partial GitHub App configuration")
	}
}

func TestLoadRequiresHTTPSGitHubCallbackInHostedEnvironment(t *testing.T) {
	t.Setenv("AO_CLOUD_ENV", "production")
	t.Setenv("AO_CLOUD_DATABASE_URL", "postgres://localhost/ao")
	t.Setenv("AO_CLOUD_LOCAL_AUTH", "false")
	t.Setenv("AO_CLOUD_RELEASE", "sha-123")
	t.Setenv("AO_CLOUD_GITHUB_APP_ID", "123")
	t.Setenv("AO_CLOUD_GITHUB_APP_SLUG", "ao")
	t.Setenv("AO_CLOUD_GITHUB_CLIENT_ID", "client")
	t.Setenv("AO_CLOUD_GITHUB_CLIENT_SECRET", "secret")
	t.Setenv("AO_CLOUD_GITHUB_PRIVATE_KEY", "private-key")
	t.Setenv("AO_CLOUD_GITHUB_WEBHOOK_SECRET", "webhook-secret")
	t.Setenv(
		"AO_CLOUD_GITHUB_STATE_KEY",
		base64.StdEncoding.EncodeToString(make([]byte, 32)),
	)
	t.Setenv("AO_CLOUD_PUBLIC_URL", "http://api.aoagents.dev")

	if _, err := Load(); err == nil {
		t.Fatal("Load succeeded with a plaintext hosted GitHub callback URL")
	}
}
