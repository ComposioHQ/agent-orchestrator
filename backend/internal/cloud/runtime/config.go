package runtime

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is the compute plane's deployment configuration. It lives in this
// package, not in the shared control-plane config, so the compute settings
// stay next to the rules that consume them and a deployment that does not run
// compute never has to supply them.
type Config struct {
	// Enabled gates the whole compute plane. A deployment with it off runs no
	// provider client, no reaper, and no sandbox listener.
	Enabled bool
	// Deployment names this control plane in every sandbox label.
	Deployment string
	// PublicURL is the base URL sandboxes call back on.
	PublicURL string
	// Daytona holds the provider credentials and placement settings.
	Daytona DaytonaConfig
	// CoordinatorSnapshot and WorkerSnapshot are the prebuilt images.
	CoordinatorSnapshot string
	WorkerSnapshot      string
	Resources           Resources
	// AutoStopInterval and AutoDeleteInterval are the provider-side idle
	// guards. They exist so an outage of THIS control plane cannot leave a
	// fleet of sandboxes running indefinitely.
	AutoStopInterval   time.Duration
	AutoDeleteInterval time.Duration
	CapabilityTTL      time.Duration
	Quotas             Quotas
	Reaper             ReaperPolicy
	// ReaperInterval is how often a reconciliation pass runs.
	ReaperInterval time.Duration
}

// DaytonaConfig is the provider half of the compute configuration.
type DaytonaConfig struct {
	BaseURL        string
	APIKey         string
	OrganizationID string
	Target         string
}

const (
	defaultReaperInterval = 2 * time.Minute
	defaultSnapshotCPU    = 2
	defaultSnapshotMemory = 4
	defaultSnapshotDisk   = 20
)

// LoadConfig reads the compute plane's configuration from the process
// environment. Pass os.Getenv in production; tests pass a map lookup.
//
// Nothing is read from a command line. The Daytona API key comes from an
// environment variable or, preferably, a file whose permissions are checked:
// a credential passed as an argument is visible in every process listing on
// the host and in most process-supervision logs.
func LoadConfig(getenv func(string) string) (Config, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	cfg := Config{
		Enabled:             boolValue(getenv("AO_CLOUD_COMPUTE_ENABLED")),
		Deployment:          strings.TrimSpace(getenv("AO_CLOUD_DEPLOYMENT")),
		PublicURL:           strings.TrimSpace(getenv("AO_CLOUD_PUBLIC_URL")),
		CoordinatorSnapshot: strings.TrimSpace(getenv("AO_CLOUD_COORDINATOR_SNAPSHOT")),
		WorkerSnapshot:      strings.TrimSpace(getenv("AO_CLOUD_WORKER_SNAPSHOT")),
		Daytona: DaytonaConfig{
			BaseURL:        strings.TrimSpace(getenv("AO_CLOUD_DAYTONA_API_URL")),
			OrganizationID: strings.TrimSpace(getenv("AO_CLOUD_DAYTONA_ORGANIZATION_ID")),
			Target:         strings.TrimSpace(getenv("AO_CLOUD_DAYTONA_TARGET")),
		},
		Quotas:         DefaultQuotas(),
		Reaper:         DefaultReaperPolicy(),
		ReaperInterval: defaultReaperInterval,
	}
	if !cfg.Enabled {
		return cfg, nil
	}

	apiKey, err := secretValue(getenv, "AO_CLOUD_DAYTONA_API_KEY")
	if err != nil {
		return Config{}, err
	}
	cfg.Daytona.APIKey = apiKey

	durations := map[string]*time.Duration{
		"AO_CLOUD_SANDBOX_AUTO_STOP":            &cfg.AutoStopInterval,
		"AO_CLOUD_SANDBOX_AUTO_DELETE":          &cfg.AutoDeleteInterval,
		"AO_CLOUD_CAPABILITY_TTL":               &cfg.CapabilityTTL,
		"AO_CLOUD_REAPER_INTERVAL":              &cfg.ReaperInterval,
		"AO_CLOUD_SANDBOX_IDLE_TIMEOUT":         &cfg.Reaper.IdleTimeout,
		"AO_CLOUD_SANDBOX_ABANDONED_TIMEOUT":    &cfg.Reaper.AbandonedTimeout,
		"AO_CLOUD_SANDBOX_PROVISIONING_TIMEOUT": &cfg.Reaper.ProvisioningTimeout,
		"AO_CLOUD_SANDBOX_ORPHAN_GRACE":         &cfg.Reaper.OrphanGrace,
		"AO_CLOUD_SANDBOX_UNLABELED_GRACE":      &cfg.Reaper.UnlabeledGrace,
		"AO_CLOUD_CAPABILITY_RETENTION":         &cfg.Reaper.CapabilityRetention,
	}
	for name, target := range durations {
		value, err := durationValue(getenv(name), *target)
		if err != nil {
			return Config{}, fmt.Errorf("%s: %w", name, err)
		}
		*target = value
	}

	cfg.Resources = Resources{CPU: defaultSnapshotCPU, MemoryGB: defaultSnapshotMemory, DiskGB: defaultSnapshotDisk}
	integers := map[string]*int{
		"AO_CLOUD_SANDBOX_CPU":                    &cfg.Resources.CPU,
		"AO_CLOUD_SANDBOX_MEMORY_GB":              &cfg.Resources.MemoryGB,
		"AO_CLOUD_SANDBOX_DISK_GB":                &cfg.Resources.DiskGB,
		"AO_CLOUD_MAX_SANDBOXES_PER_ORG":          &cfg.Quotas.MaxSandboxesPerOrg,
		"AO_CLOUD_MAX_SANDBOXES_PER_USER":         &cfg.Quotas.MaxSandboxesPerUser,
		"AO_CLOUD_MAX_WORKERS_PER_WORKSPACE":      &cfg.Quotas.MaxWorkersPerWorkspace,
		"AO_CLOUD_MAX_COORDINATORS_PER_WORKSPACE": &cfg.Quotas.MaxCoordinatorsPerWorkspace,
	}
	for name, target := range integers {
		value, err := intValue(getenv(name), *target)
		if err != nil {
			return Config{}, fmt.Errorf("%s: %w", name, err)
		}
		*target = value
	}
	cfg.Reaper.ReapUnlabeled = boolValue(getenv("AO_CLOUD_REAP_UNLABELED_SANDBOXES"))

	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// Validate rejects a compute configuration that could not run safely.
func (c Config) Validate() error {
	if !c.Enabled {
		return nil
	}
	for name, value := range map[string]string{
		"AO_CLOUD_DEPLOYMENT":           c.Deployment,
		"AO_CLOUD_PUBLIC_URL":           c.PublicURL,
		"AO_CLOUD_DAYTONA_API_KEY":      c.Daytona.APIKey,
		"AO_CLOUD_COORDINATOR_SNAPSHOT": c.CoordinatorSnapshot,
		"AO_CLOUD_WORKER_SNAPSHOT":      c.WorkerSnapshot,
	} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("%s is required when the compute plane is enabled", name)
		}
	}
	// A sandbox reaches the control plane across the public internet; plain
	// HTTP would put its capability on the wire in clear text.
	if !strings.HasPrefix(c.PublicURL, "https://") && !strings.HasPrefix(c.PublicURL, "http://127.0.0.1") {
		return errors.New("AO_CLOUD_PUBLIC_URL must be https (only a loopback URL may be plain HTTP, for local development)")
	}
	if c.ReaperInterval <= 0 {
		return errors.New("AO_CLOUD_REAPER_INTERVAL must be positive")
	}
	if err := c.Quotas.Validate(); err != nil {
		return err
	}
	return c.Reaper.Validate()
}

// Snapshots renders the per-role image map the Manager expects.
func (c Config) Snapshots() map[Role]string {
	return map[Role]string{RoleCoordinator: c.CoordinatorSnapshot, RoleWorker: c.WorkerSnapshot}
}

// secretValue reads a credential from NAME or, preferably, from the file named
// by NAME_FILE. The file's permissions are checked: a credential a
// co-tenant process can read is not a secret, and a deployment that mounts one
// world-readable should fail at startup rather than silently.
func secretValue(getenv func(string) string, name string) (string, error) {
	if path := strings.TrimSpace(getenv(name + "_FILE")); path != "" {
		info, err := os.Stat(path)
		if err != nil {
			return "", fmt.Errorf("%s_FILE: %w", name, err)
		}
		if mode := info.Mode().Perm(); mode&fs.FileMode(0o077) != 0 {
			return "", fmt.Errorf("%s_FILE: %s is readable beyond its owner (mode %04o)", name, path, mode)
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return "", fmt.Errorf("%s_FILE: %w", name, err)
		}
		value := strings.TrimSpace(string(content))
		if value == "" {
			return "", fmt.Errorf("%s_FILE: %s is empty", name, path)
		}
		return value, nil
	}
	return strings.TrimSpace(getenv(name)), nil
}

func boolValue(value string) bool {
	parsed, err := strconv.ParseBool(strings.TrimSpace(value))
	return err == nil && parsed
}

func durationValue(value string, fallback time.Duration) (time.Duration, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback, nil
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return 0, err
	}
	if parsed < 0 {
		return 0, errors.New("must not be negative")
	}
	return parsed, nil
}

func intValue(value string, fallback int) (int, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return 0, err
	}
	if parsed < 0 {
		return 0, errors.New("must not be negative")
	}
	return parsed, nil
}
