package config

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

// nodeOpsEnvironment sets every variable a nodeops deployment requires, so a
// test can then remove exactly the one it is asserting on.
func nodeOpsEnvironment(t *testing.T) {
	t.Helper()
	setProviderSecretKey(t)
	t.Setenv("AO_CLOUD_ENV", "staging")
	t.Setenv("AO_CLOUD_DATABASE_URL", "postgres://localhost/ao")
	t.Setenv("AO_CLOUD_WORKOS_ISSUER", "https://api.workos.com/")
	t.Setenv("AO_CLOUD_WORKOS_CLIENT_ID", "client_123")
	t.Setenv("AO_CLOUD_WORKOS_API_KEY", "secret")
	t.Setenv("AO_CLOUD_LOCAL_AUTH", "false")
	t.Setenv("AO_CLOUD_NODEOPS_BASE_URL", "https://api.sb.createos.sh")
	t.Setenv("AO_CLOUD_NODEOPS_API_KEY", "nodeops-secret")
	t.Setenv("AO_CLOUD_NODEOPS_DEFAULT_SHAPE", "s-4vcpu-8gb")
	t.Setenv("AO_CLOUD_NODEOPS_DEFAULT_ROOTFS", "devbox:1")
	t.Setenv("AO_CLOUD_NODEOPS_WORKER_TOKEN_TTL", "15m")
	t.Setenv("AO_CLOUD_PUBLIC_URL", "https://cloud.example.com")
	t.Setenv("AO_CLOUD_WORKER_SIGNING_KEY", strings.Repeat("a", 64))
	t.Setenv("AO_CLOUD_WORKER_BINARY_PATH", "/srv/ao-worker")
	t.Setenv("AO_CLOUD_WORKER_HELPER_BINARY_PATH", "/srv/ao")
	t.Setenv("AO_CLOUD_RELEASE", "sha-123")
	t.Setenv("AO_CLOUD_REPOSITORY_BROKER_URL", "https://api.aoagents.dev")
	t.Setenv("AO_CLOUD_REPOSITORY_BROKER_TOKEN", strings.Repeat("b", 48))
	t.Setenv("AO_CLOUD_ENV_CONTROL_TOKEN", strings.Repeat("c", 48))
}

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
	t.Setenv("AO_CLOUD_NODEOPS_BASE_URL", "")
	t.Setenv("AO_CLOUD_NODEOPS_API_KEY", "")
	t.Setenv("AO_CLOUD_NODEOPS_DEFAULT_SHAPE", "")
	t.Setenv("AO_CLOUD_NODEOPS_DEFAULT_ROOTFS", "")
	t.Setenv("AO_CLOUD_NODEOPS_INGRESS", "")
	t.Setenv("AO_CLOUD_NODEOPS_SSH_KEY_PATH", "")
	t.Setenv("AO_CLOUD_NODEOPS_WORKER_TOKEN_TTL", "")
	t.Setenv("AO_CLOUD_DOCKER_HOST", "unix:///var/run/docker.sock")
	t.Setenv("AO_CLOUD_DOCKER_WORKER_IMAGE", "ao-cloud-worker:test")
	t.Setenv("AO_CLOUD_DOCKER_NETWORK", "ao-cloud-test_default")
	t.Setenv("AO_CLOUD_DOCKER_NAMESPACE", "ao-cloud-test")
	t.Setenv("AO_CLOUD_DOCKER_WORKER_TOKEN_TTL", "10m")
	t.Setenv("AO_CLOUD_PUBLIC_URL", "http://control-plane:8080")
	t.Setenv("AO_CLOUD_WORKER_SIGNING_KEY", strings.Repeat("d", 64))
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
		cfg.SandboxProvider != "docker" ||
		cfg.DockerWorkerImage != "ao-cloud-worker:test" ||
		cfg.WorkerTokenTTL() != 10*time.Minute ||
		cfg.Release != "dev" ||
		cfg.AllowAnonymousCheckout ||
		cfg.MigrationDatabaseURL != cfg.DatabaseURL {
		t.Fatalf("config = %#v", cfg)
	}
}

func TestLoadEnablesAnonymousCheckout(t *testing.T) {
	t.Setenv("AO_CLOUD_ENV", "development")
	t.Setenv("AO_CLOUD_DATABASE_URL", "postgres://localhost/ao")
	t.Setenv("AO_CLOUD_LOCAL_AUTH", "true")
	t.Setenv("AO_CLOUD_SANDBOX_PROVIDER", "docker")
	t.Setenv("AO_CLOUD_DOCKER_WORKER_IMAGE", "ao-cloud-worker:test")
	t.Setenv("AO_CLOUD_PUBLIC_URL", "http://control-plane:8080")
	t.Setenv("AO_CLOUD_WORKER_SIGNING_KEY", strings.Repeat("d", 64))
	t.Setenv("AO_CLOUD_ALLOW_ANONYMOUS_GITHUB_CHECKOUT", "true")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.AllowAnonymousCheckout {
		t.Fatal("AO_CLOUD_ALLOW_ANONYMOUS_GITHUB_CHECKOUT=true did not enable anonymous checkout")
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

func TestLoadRejectsInvalidProviderSecretKey(t *testing.T) {
	t.Setenv("AO_CLOUD_ENV", "development")
	t.Setenv("AO_CLOUD_DATABASE_URL", "postgres://localhost/ao")
	t.Setenv("AO_CLOUD_LOCAL_AUTH", "true")
	t.Setenv("AO_CLOUD_PROVIDER_SECRET_KEY", "not-base64")

	if _, err := Load(); err == nil {
		t.Fatal("Load succeeded with an invalid provider secret key")
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
	t.Setenv("AO_CLOUD_NODEOPS_BASE_URL", "https://nodeops.example.com")
	t.Setenv("AO_CLOUD_NODEOPS_API_KEY", "nodeops-secret")
	t.Setenv("AO_CLOUD_NODEOPS_DEFAULT_SHAPE", "s-1vcpu-1gb")
	t.Setenv("AO_CLOUD_NODEOPS_DEFAULT_ROOTFS", "devbox:1")
	t.Setenv("AO_CLOUD_NODEOPS_WORKER_TOKEN_TTL", "15m")
	t.Setenv("AO_CLOUD_PUBLIC_URL", "https://cloud.example.com/")
	t.Setenv("AO_CLOUD_WORKER_SIGNING_KEY", strings.Repeat("a", 64))
	t.Setenv("AO_CLOUD_WORKER_BINARY_PATH", "/srv/ao-worker")
	t.Setenv("AO_CLOUD_WORKER_HELPER_BINARY_PATH", "/srv/ao")
	t.Setenv("AO_CLOUD_RELEASE", "sha-staging")
	t.Setenv("AO_CLOUD_REPOSITORY_BROKER_URL", "https://api.aoagents.dev")
	t.Setenv("AO_CLOUD_REPOSITORY_BROKER_TOKEN", strings.Repeat("b", 48))
	t.Setenv("AO_CLOUD_ENV_CONTROL_TOKEN", strings.Repeat("c", 48))
	setProviderSecretKey(t)

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.Hosted() ||
		cfg.MigrateOnStartup ||
		cfg.SandboxProvider != "nodeops" ||
		cfg.Release != "sha-staging" ||
		cfg.HTTPAddress != ":8080" ||
		cfg.NodeOpsBaseURL != "https://nodeops.example.com" {
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
	t.Setenv("AO_CLOUD_NODEOPS_BASE_URL", "https://nodeops.example.com")
	t.Setenv("AO_CLOUD_NODEOPS_API_KEY", "nodeops-secret")
	t.Setenv("AO_CLOUD_NODEOPS_DEFAULT_SHAPE", "s-1vcpu-1gb")
	t.Setenv("AO_CLOUD_NODEOPS_DEFAULT_ROOTFS", "devbox:1")
	t.Setenv("AO_CLOUD_NODEOPS_WORKER_TOKEN_TTL", "15m")
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
	t.Setenv("AO_CLOUD_NODEOPS_BASE_URL", "https://nodeops.example.com")
	t.Setenv("AO_CLOUD_NODEOPS_API_KEY", "nodeops-secret")
	t.Setenv("AO_CLOUD_NODEOPS_DEFAULT_SHAPE", "s-1vcpu-1gb")
	t.Setenv("AO_CLOUD_NODEOPS_DEFAULT_ROOTFS", "devbox:1")
	t.Setenv("AO_CLOUD_NODEOPS_WORKER_TOKEN_TTL", "15m")
	t.Setenv("AO_CLOUD_PUBLIC_URL", "https://cloud.example.com")
	t.Setenv("AO_CLOUD_WORKER_SIGNING_KEY", strings.Repeat("a", 64))
	t.Setenv("AO_CLOUD_WORKER_BINARY_PATH", "/srv/ao-worker")
	t.Setenv("AO_CLOUD_WORKER_HELPER_BINARY_PATH", "/srv/ao")
	t.Setenv("AO_CLOUD_RELEASE", "sha-123")
	setProviderSecretKey(t)

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
	t.Setenv("AO_CLOUD_NODEOPS_BASE_URL", "https://nodeops.example.com")
	t.Setenv("AO_CLOUD_NODEOPS_API_KEY", "nodeops-secret")
	t.Setenv("AO_CLOUD_NODEOPS_DEFAULT_SHAPE", "s-1vcpu-1gb")
	t.Setenv("AO_CLOUD_NODEOPS_DEFAULT_ROOTFS", "devbox:1")
	t.Setenv("AO_CLOUD_NODEOPS_WORKER_TOKEN_TTL", "15m")
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
	t.Setenv("AO_CLOUD_NODEOPS_BASE_URL", "")
	t.Setenv("AO_CLOUD_NODEOPS_API_KEY", "")
	t.Setenv("AO_CLOUD_NODEOPS_DEFAULT_SHAPE", "")
	t.Setenv("AO_CLOUD_NODEOPS_DEFAULT_ROOTFS", "")
	t.Setenv("AO_CLOUD_NODEOPS_WORKER_TOKEN_TTL", "")

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

func TestLoadRejectsGitHubAppCredentialsOutsideProduction(t *testing.T) {
	t.Setenv("AO_CLOUD_ENV", "staging")
	t.Setenv("AO_CLOUD_DATABASE_URL", "postgres://localhost/ao")
	t.Setenv("AO_CLOUD_WORKOS_ISSUER", "https://api.workos.com/")
	t.Setenv("AO_CLOUD_WORKOS_CLIENT_ID", "client_123")
	t.Setenv("AO_CLOUD_WORKOS_API_KEY", "secret")
	t.Setenv("AO_CLOUD_RELEASE", "sha-staging")
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
	t.Setenv("AO_CLOUD_PUBLIC_URL", "https://staging-api.aoagents.dev")
	setProviderSecretKey(t)

	if _, err := Load(); err == nil {
		t.Fatal("Load succeeded with staging GitHub App credentials")
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
	setProviderSecretKey(t)

	if _, err := Load(); err == nil {
		t.Fatal("Load succeeded with a plaintext hosted GitHub callback URL")
	}
}

// The tests below all start from a complete nodeops environment and remove
// exactly the one variable under test, so a failure names the missing guard
// rather than whichever check happened to run first.

func TestLoadAcceptsCompleteNodeOpsConfiguration(t *testing.T) {
	nodeOpsEnvironment(t)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.SandboxProvider != "nodeops" {
		t.Errorf("SandboxProvider = %q, want nodeops", cfg.SandboxProvider)
	}
	if cfg.NodeOpsWorkerTokenTTL != 15*time.Minute {
		t.Errorf("NodeOpsWorkerTokenTTL = %v, want 15m", cfg.NodeOpsWorkerTokenTTL)
	}
	if cfg.MaxSandboxesPerOrg != 10 {
		t.Errorf("MaxSandboxesPerOrg = %d, want the default 10", cfg.MaxSandboxesPerOrg)
	}
	if cfg.ReconcileInterval <= 0 || cfg.SandboxStartupTimeout < 30*time.Second {
		t.Errorf("reconcile defaults = %v/%v, want positive and >= 30s",
			cfg.ReconcileInterval, cfg.SandboxStartupTimeout)
	}
}

func TestLoadDefaultsPreferControlPlaneIdlePauseOverProviderAutoPause(t *testing.T) {
	nodeOpsEnvironment(t)
	t.Setenv("AO_CLOUD_NODEOPS_AUTO_PAUSE_SECONDS", "")
	t.Setenv("AO_CLOUD_IDLE_PAUSE_THRESHOLD", "")
	t.Setenv("AO_CLOUD_IDLE_PAUSE_INTERVAL", "")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	// CreateOS's own idle timer only resets on an `exec` call, and the worker
	// only ever sends one at boot, so it cannot tell a working agent from an
	// abandoned one. It must default off; the control plane's own idle-pause
	// scanner is what actually decides.
	if cfg.NodeOpsAutoPauseSeconds != 0 {
		t.Errorf("NodeOpsAutoPauseSeconds = %d, want 0 (disabled by default)", cfg.NodeOpsAutoPauseSeconds)
	}
	if cfg.IdlePauseThreshold != time.Hour {
		t.Errorf("IdlePauseThreshold = %v, want 1h", cfg.IdlePauseThreshold)
	}
	if cfg.IdlePauseInterval != 30*time.Second {
		t.Errorf("IdlePauseInterval = %v, want 30s", cfg.IdlePauseInterval)
	}
}

func TestLoadRejectsIncompleteRepositoryBrokerConfiguration(t *testing.T) {
	nodeOpsEnvironment(t)
	t.Setenv("AO_CLOUD_ENV_CONTROL_TOKEN", "")

	if _, err := Load(); err == nil {
		t.Fatal("Load succeeded without the staging environment control token")
	}
}

func TestLoadRejectsIncompleteNodeOpsConfiguration(t *testing.T) {
	for _, tc := range []struct {
		name  string
		key   string
		value string
	}{
		{name: "missing base url", key: "AO_CLOUD_NODEOPS_BASE_URL"},
		{name: "missing api key", key: "AO_CLOUD_NODEOPS_API_KEY"},
		{name: "missing shape", key: "AO_CLOUD_NODEOPS_DEFAULT_SHAPE"},
		{name: "missing rootfs", key: "AO_CLOUD_NODEOPS_DEFAULT_ROOTFS"},
		{name: "missing public url", key: "AO_CLOUD_PUBLIC_URL"},
		{name: "missing worker binary", key: "AO_CLOUD_WORKER_BINARY_PATH"},
		{name: "missing signing key", key: "AO_CLOUD_WORKER_SIGNING_KEY"},
		{
			name:  "signing key too short to resist forgery",
			key:   "AO_CLOUD_WORKER_SIGNING_KEY",
			value: strings.Repeat("a", minWorkerSigningKeyLength-1),
		},
		{
			name:  "plaintext worker callback origin",
			key:   "AO_CLOUD_PUBLIC_URL",
			value: "http://cloud.example.com",
		},
		{
			name:  "startup budget shorter than a cold boot",
			key:   "AO_CLOUD_SANDBOX_STARTUP_TIMEOUT",
			value: "5s",
		},
		{name: "zero sandbox quota", key: "AO_CLOUD_MAX_ACTIVE_SANDBOXES_PER_ORG", value: "0"},
		{
			name:  "idle pause threshold shorter than a minute",
			key:   "AO_CLOUD_IDLE_PAUSE_THRESHOLD",
			value: "30s",
		},
		{name: "zero idle pause interval", key: "AO_CLOUD_IDLE_PAUSE_INTERVAL", value: "0s"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			nodeOpsEnvironment(t)
			t.Setenv(tc.key, tc.value)

			if _, err := Load(); err == nil {
				t.Fatalf("Load succeeded with %s=%q", tc.key, tc.value)
			}
		})
	}
}

func TestLoadRejectsNonNodeOpsProviderInHostedEnvironments(t *testing.T) {
	nodeOpsEnvironment(t)
	t.Setenv("AO_CLOUD_SANDBOX_PROVIDER", "docker")

	if _, err := Load(); err == nil {
		t.Fatal("Load succeeded with a docker sandbox provider in staging")
	}
}

func setProviderSecretKey(t *testing.T) {
	t.Helper()
	t.Setenv(
		"AO_CLOUD_PROVIDER_SECRET_KEY",
		base64.StdEncoding.EncodeToString(make([]byte, 32)),
	)
}
