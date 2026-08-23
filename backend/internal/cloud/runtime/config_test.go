package runtime_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/runtime"
)

func computeEnv(overrides map[string]string) func(string) string {
	values := map[string]string{
		"AO_CLOUD_COMPUTE_ENABLED":      "true",
		"AO_CLOUD_DEPLOYMENT":           "staging",
		"AO_CLOUD_PUBLIC_URL":           "https://cloud.example",
		"AO_CLOUD_DAYTONA_API_KEY":      "dtn_test_key",
		"AO_CLOUD_COORDINATOR_SNAPSHOT": "ao-coordinator",
		"AO_CLOUD_WORKER_SNAPSHOT":      "ao-worker",
	}
	for name, value := range overrides {
		if value == "" {
			delete(values, name)
		} else {
			values[name] = value
		}
	}
	return func(name string) string { return values[name] }
}

func TestLoadConfigDefaultsAreSafeAndUsable(t *testing.T) {
	cfg, err := runtime.LoadConfig(computeEnv(nil))
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.Enabled || cfg.AutoStopInterval <= 0 || cfg.AutoDeleteInterval <= cfg.AutoStopInterval {
		t.Fatalf("unsafe defaults: %#v", cfg)
	}
	if cfg.Resources.CPU <= 0 || cfg.Resources.MemoryGB <= 0 || cfg.Resources.DiskGB <= 0 {
		t.Fatalf("resources = %#v", cfg.Resources)
	}
	if cfg.Quotas != runtime.DefaultQuotas() || cfg.Reaper.IdleTimeout != runtime.DefaultReaperPolicy().IdleTimeout {
		t.Fatalf("policy defaults = %#v %#v", cfg.Quotas, cfg.Reaper)
	}
}

func TestLoadConfigAllowsDisabledPlaneWithoutProviderCredential(t *testing.T) {
	cfg, err := runtime.LoadConfig(func(name string) string {
		if name == "AO_CLOUD_COMPUTE_ENABLED" {
			return "false"
		}
		return ""
	})
	if err != nil || cfg.Enabled {
		t.Fatalf("cfg = %#v, err = %v", cfg, err)
	}
}

func TestLoadConfigOverridesQuotaResourcesAndReaper(t *testing.T) {
	cfg, err := runtime.LoadConfig(computeEnv(map[string]string{
		"AO_CLOUD_MAX_SANDBOXES_PER_ORG":     "50",
		"AO_CLOUD_MAX_WORKERS_PER_WORKSPACE": "0",
		"AO_CLOUD_SANDBOX_CPU":               "4",
		"AO_CLOUD_SANDBOX_IDLE_TIMEOUT":      "10m",
		"AO_CLOUD_SANDBOX_ABANDONED_TIMEOUT": "2h",
		"AO_CLOUD_SANDBOX_AUTO_STOP":         "15m",
		"AO_CLOUD_SANDBOX_AUTO_DELETE":       "48h",
		"AO_CLOUD_REAPER_INTERVAL":           "45s",
		"AO_CLOUD_REAP_UNLABELED_SANDBOXES":  "true",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Quotas.MaxSandboxesPerOrg != 50 || cfg.Quotas.MaxWorkersPerWorkspace != 0 || cfg.Resources.CPU != 4 {
		t.Fatalf("cfg = %#v", cfg)
	}
	if cfg.Reaper.IdleTimeout != 10*time.Minute || !cfg.Reaper.ReapUnlabeled || cfg.ReaperInterval != 45*time.Second {
		t.Fatalf("reaper = %#v interval %s", cfg.Reaper, cfg.ReaperInterval)
	}
}

func TestLoadConfigRejectsUnsafeSettings(t *testing.T) {
	for name, overrides := range map[string]map[string]string{
		"missing deployment": {"AO_CLOUD_DEPLOYMENT": ""},
		"missing key":        {"AO_CLOUD_DAYTONA_API_KEY": ""},
		"plaintext callback": {"AO_CLOUD_PUBLIC_URL": "http://cloud.example"},
		"zero auto stop":     {"AO_CLOUD_SANDBOX_AUTO_STOP": "0s"},
		"delete before stop": {"AO_CLOUD_SANDBOX_AUTO_STOP": "2h", "AO_CLOUD_SANDBOX_AUTO_DELETE": "1h"},
		"negative quota":     {"AO_CLOUD_MAX_SANDBOXES_PER_ORG": "-1"},
		"bad duration":       {"AO_CLOUD_SANDBOX_IDLE_TIMEOUT": "soon"},
	} {
		if _, err := runtime.LoadConfig(computeEnv(overrides)); err == nil {
			t.Fatalf("%s accepted", name)
		}
	}
}

func TestProviderKeyFileMustBeOwnerOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "daytona.key")
	if err := os.WriteFile(path, []byte("dtn_file_key\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := runtime.LoadConfig(computeEnv(map[string]string{
		"AO_CLOUD_DAYTONA_API_KEY": "", "AO_CLOUD_DAYTONA_API_KEY_FILE": path,
	}))
	if err != nil || cfg.Daytona.APIKey != "dtn_file_key" {
		t.Fatalf("key = %q err = %v", cfg.Daytona.APIKey, err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	_, err = runtime.LoadConfig(computeEnv(map[string]string{
		"AO_CLOUD_DAYTONA_API_KEY": "", "AO_CLOUD_DAYTONA_API_KEY_FILE": path,
	}))
	if err == nil || !strings.Contains(err.Error(), "readable beyond its owner") {
		t.Fatalf("err = %v", err)
	}
}

func TestNewManagerRequiresProviderIdleGuards(t *testing.T) {
	for name, mutate := range map[string]func(*runtime.Options){
		"missing stop":   func(options *runtime.Options) { options.AutoStopInterval = 0 },
		"missing delete": func(options *runtime.Options) { options.AutoDeleteInterval = 0 },
		"delete first":   func(options *runtime.Options) { options.AutoDeleteInterval = options.AutoStopInterval },
	} {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t)
			_ = h
			// Rebuild from the known-good harness dependencies so the mutation is
			// tested at the constructor boundary.
			options := runtime.Options{
				Store: h.store, Provider: h.provider, Capabilities: h.capabilities,
				Deployment: "staging", PublicURL: "https://cloud.example",
				Snapshots: map[runtime.Role]string{runtime.RoleCoordinator: "coord", runtime.RoleWorker: "worker"},
				Quotas:    runtime.DefaultQuotas(), AutoStopInterval: 30 * time.Minute, AutoDeleteInterval: time.Hour,
			}
			mutate(&options)
			if _, err := runtime.NewManager(options); err == nil {
				t.Fatal("unsafe idle guard accepted")
			}
		})
	}
}
