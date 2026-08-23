package runtime_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/runtime"
)

func env(overrides map[string]string) func(string) string {
	base := map[string]string{
		"AO_CLOUD_COMPUTE_ENABLED":      "true",
		"AO_CLOUD_DEPLOYMENT":           "staging",
		"AO_CLOUD_PUBLIC_URL":           "https://cloud.example",
		"AO_CLOUD_DAYTONA_API_KEY":      "dtn_secret",
		"AO_CLOUD_COORDINATOR_SNAPSHOT": "ao-coordinator",
		"AO_CLOUD_WORKER_SNAPSHOT":      "ao-worker",
	}
	for name, value := range overrides {
		if value == "" {
			delete(base, name)
			continue
		}
		base[name] = value
	}
	return func(name string) string { return base[name] }
}

func TestLoadConfigAppliesDefaults(t *testing.T) {
	cfg, err := runtime.LoadConfig(env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.Enabled || cfg.Deployment != "staging" {
		t.Fatalf("cfg = %#v", cfg)
	}
	if cfg.Quotas != runtime.DefaultQuotas() {
		t.Fatalf("quotas = %#v", cfg.Quotas)
	}
	if cfg.Reaper.IdleTimeout != runtime.DefaultReaperPolicy().IdleTimeout {
		t.Fatalf("reaper = %#v", cfg.Reaper)
	}
	if cfg.Resources.CPU == 0 || cfg.Resources.MemoryGB == 0 || cfg.Resources.DiskGB == 0 {
		t.Fatalf("resources = %#v", cfg.Resources)
	}
	snapshots := cfg.Snapshots()
	if snapshots[runtime.RoleWorker] != "ao-worker" || snapshots[runtime.RoleCoordinator] != "ao-coordinator" {
		t.Fatalf("snapshots = %#v", snapshots)
	}
}

func TestLoadConfigIsInertWhenComputeIsDisabled(t *testing.T) {
	// A control plane that runs no compute must not be forced to hold a
	// provider credential.
	cfg, err := runtime.LoadConfig(func(name string) string {
		if name == "AO_CLOUD_COMPUTE_ENABLED" {
			return "false"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Enabled {
		t.Fatal("compute enabled without being asked for")
	}
}

func TestLoadConfigOverridesQuotasAndReaperTimings(t *testing.T) {
	cfg, err := runtime.LoadConfig(env(map[string]string{
		"AO_CLOUD_MAX_SANDBOXES_PER_ORG":     "50",
		"AO_CLOUD_MAX_WORKERS_PER_WORKSPACE": "0",
		"AO_CLOUD_SANDBOX_IDLE_TIMEOUT":      "10m",
		"AO_CLOUD_SANDBOX_ABANDONED_TIMEOUT": "2h",
		"AO_CLOUD_REAPER_INTERVAL":           "45s",
		"AO_CLOUD_REAP_UNLABELED_SANDBOXES":  "true",
		"AO_CLOUD_SANDBOX_AUTO_STOP":         "20m",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Quotas.MaxSandboxesPerOrg != 50 {
		t.Fatalf("org quota = %d", cfg.Quotas.MaxSandboxesPerOrg)
	}
	// Zero is the explicit "unbounded" opt-out, not a missing value.
	if cfg.Quotas.MaxWorkersPerWorkspace != 0 {
		t.Fatalf("workspace quota = %d", cfg.Quotas.MaxWorkersPerWorkspace)
	}
	if cfg.Reaper.IdleTimeout != 10*time.Minute || cfg.Reaper.AbandonedTimeout != 2*time.Hour {
		t.Fatalf("reaper = %#v", cfg.Reaper)
	}
	if !cfg.Reaper.ReapUnlabeled || cfg.ReaperInterval != 45*time.Second || cfg.AutoStopInterval != 20*time.Minute {
		t.Fatalf("cfg = %#v", cfg)
	}
}

func TestLoadConfigRejectsUnsafeSettings(t *testing.T) {
	for name, overrides := range map[string]map[string]string{
		"no deployment":       {"AO_CLOUD_DEPLOYMENT": ""},
		"no provider key":     {"AO_CLOUD_DAYTONA_API_KEY": ""},
		"no worker snapshot":  {"AO_CLOUD_WORKER_SNAPSHOT": ""},
		"plaintext callback":  {"AO_CLOUD_PUBLIC_URL": "http://cloud.example"},
		"negative quota":      {"AO_CLOUD_MAX_SANDBOXES_PER_ORG": "-1"},
		"bad duration":        {"AO_CLOUD_SANDBOX_IDLE_TIMEOUT": "soon"},
		"zero reaper":         {"AO_CLOUD_REAPER_INTERVAL": "0s"},
		"delete before stop":  {"AO_CLOUD_SANDBOX_ABANDONED_TIMEOUT": "1m"},
		"unlabelled no grace": {"AO_CLOUD_REAP_UNLABELED_SANDBOXES": "true", "AO_CLOUD_SANDBOX_UNLABELED_GRACE": "0s"},
	} {
		if _, err := runtime.LoadConfig(env(overrides)); err == nil {
			t.Fatalf("%s: accepted", name)
		}
	}
	// Loopback stays plain HTTP so local development works.
	if _, err := runtime.LoadConfig(env(map[string]string{"AO_CLOUD_PUBLIC_URL": "http://127.0.0.1:8080"})); err != nil {
		t.Fatalf("loopback callback rejected: %v", err)
	}
}

func TestProviderKeyMayComeFromAnOwnerOnlyFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "daytona.key")
	if err := os.WriteFile(path, []byte("dtn_from_file\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := runtime.LoadConfig(env(map[string]string{
		"AO_CLOUD_DAYTONA_API_KEY":      "",
		"AO_CLOUD_DAYTONA_API_KEY_FILE": path,
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Daytona.APIKey != "dtn_from_file" {
		t.Fatalf("api key = %q", cfg.Daytona.APIKey)
	}

	// A credential any co-tenant process can read is not a secret; failing at
	// startup is the only moment an operator will notice.
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	_, err = runtime.LoadConfig(env(map[string]string{
		"AO_CLOUD_DAYTONA_API_KEY":      "",
		"AO_CLOUD_DAYTONA_API_KEY_FILE": path,
	}))
	if err == nil || !strings.Contains(err.Error(), "readable beyond its owner") {
		t.Fatalf("err = %v, want a permission complaint", err)
	}

	missing, err := runtime.LoadConfig(env(map[string]string{
		"AO_CLOUD_DAYTONA_API_KEY":      "",
		"AO_CLOUD_DAYTONA_API_KEY_FILE": filepath.Join(dir, "absent.key"),
	}))
	if err == nil {
		t.Fatalf("missing key file accepted: %#v", missing)
	}
}

func TestProviderIdleGuardsAreMandatoryAndNonZero(t *testing.T) {
	// These are the only guards that survive this control plane being down. A
	// deployment must not be able to switch them off, so "0s" is an error
	// rather than the usual "unbounded" opt-out that quotas use.
	cfg, err := runtime.LoadConfig(env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AutoStopInterval <= 0 || cfg.AutoDeleteInterval <= 0 {
		t.Fatalf("defaults = stop %s delete %s, want both non-zero", cfg.AutoStopInterval, cfg.AutoDeleteInterval)
	}
	if cfg.AutoDeleteInterval <= cfg.AutoStopInterval {
		t.Fatalf("delete %s must exceed stop %s", cfg.AutoDeleteInterval, cfg.AutoStopInterval)
	}

	for name, overrides := range map[string]map[string]string{
		"auto stop disabled":   {"AO_CLOUD_SANDBOX_AUTO_STOP": "0s"},
		"auto delete disabled": {"AO_CLOUD_SANDBOX_AUTO_DELETE": "0s"},
		"delete before stop": {
			"AO_CLOUD_SANDBOX_AUTO_STOP":   "2h",
			"AO_CLOUD_SANDBOX_AUTO_DELETE": "1h",
		},
	} {
		if _, err := runtime.LoadConfig(env(overrides)); err == nil {
			t.Fatalf("%s: accepted", name)
		}
	}
}

func TestConfiguredIdleGuardsReachTheProvider(t *testing.T) {
	// A guard that is configured but never sent to the provider protects
	// nothing, so assert it travels all the way into the create request.
	cfg, err := runtime.LoadConfig(env(map[string]string{
		"AO_CLOUD_SANDBOX_AUTO_STOP":   "15m",
		"AO_CLOUD_SANDBOX_AUTO_DELETE": "48h",
	}))
	if err != nil {
		t.Fatal(err)
	}
	h := newHarness(t, func(options *runtime.Options) {
		options.AutoStopInterval = cfg.AutoStopInterval
		options.AutoDeleteInterval = cfg.AutoDeleteInterval
	})
	if _, err := h.manager.Ensure(context.Background(), workerRef()); err != nil {
		t.Fatal(err)
	}
	if h.provider.LastCreate.AutoStopInterval != 15*time.Minute {
		t.Fatalf("auto stop reached the provider as %s", h.provider.LastCreate.AutoStopInterval)
	}
	if h.provider.LastCreate.AutoDeleteInterval != 48*time.Hour {
		t.Fatalf("auto delete reached the provider as %s", h.provider.LastCreate.AutoDeleteInterval)
	}
}
