package runtime

import (
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is the deployment configuration for the optional compute plane.
type Config struct {
	Enabled             bool
	Deployment          string
	PublicURL           string
	Daytona             DaytonaConfig
	CoordinatorSnapshot string
	WorkerSnapshot      string
	Resources           Resources
	AutoStopInterval    time.Duration
	AutoDeleteInterval  time.Duration
	Quotas              Quotas
	Reaper              ReaperPolicy
	ReaperInterval      time.Duration
}

// DaytonaConfig contains provider connection and placement settings.
type DaytonaConfig struct {
	BaseURL        string
	APIKey         string
	OrganizationID string
	Target         string
}

const (
	defaultAutoStopInterval   = 30 * time.Minute
	defaultAutoDeleteInterval = 72 * time.Hour
	defaultReaperInterval     = 2 * time.Minute
	defaultSnapshotCPU        = 2
	defaultSnapshotMemory     = 4
	defaultSnapshotDisk       = 20
)

// LoadConfig reads compute configuration through getenv. Secrets may be read
// from an owner-only NAME_FILE and are never accepted through CLI arguments.
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
		Resources:          Resources{CPU: defaultSnapshotCPU, MemoryGB: defaultSnapshotMemory, DiskGB: defaultSnapshotDisk},
		AutoStopInterval:   defaultAutoStopInterval,
		AutoDeleteInterval: defaultAutoDeleteInterval,
		Quotas:             DefaultQuotas(),
		Reaper:             DefaultReaperPolicy(),
		ReaperInterval:     defaultReaperInterval,
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
		"AO_CLOUD_REAPER_INTERVAL":              &cfg.ReaperInterval,
		"AO_CLOUD_SANDBOX_IDLE_TIMEOUT":         &cfg.Reaper.IdleTimeout,
		"AO_CLOUD_SANDBOX_ABANDONED_TIMEOUT":    &cfg.Reaper.AbandonedTimeout,
		"AO_CLOUD_SANDBOX_PROVISIONING_TIMEOUT": &cfg.Reaper.ProvisioningTimeout,
		"AO_CLOUD_SANDBOX_ORPHAN_GRACE":         &cfg.Reaper.OrphanGrace,
		"AO_CLOUD_SANDBOX_UNLABELED_GRACE":      &cfg.Reaper.UnlabeledGrace,
		"AO_CLOUD_CAPABILITY_RETENTION":         &cfg.Reaper.CapabilityRetention,
	}
	for name, target := range durations {
		parsed, err := durationValue(getenv(name), *target)
		if err != nil {
			return Config{}, fmt.Errorf("%s: %w", name, err)
		}
		*target = parsed
	}
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
		parsed, err := intValue(getenv(name), *target)
		if err != nil {
			return Config{}, fmt.Errorf("%s: %w", name, err)
		}
		*target = parsed
	}
	cfg.Reaper.ReapUnlabeled = boolValue(getenv("AO_CLOUD_REAP_UNLABELED_SANDBOXES"))
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// Validate rejects a deployment configuration that could leak credentials or compute.
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
			return fmt.Errorf("%s is required when compute is enabled", name)
		}
	}
	callback, err := url.Parse(c.PublicURL)
	if err != nil || callback.Host == "" {
		return errors.New("AO_CLOUD_PUBLIC_URL must be an absolute URL")
	}
	if callback.Scheme != "https" {
		return errors.New("AO_CLOUD_PUBLIC_URL must use https")
	}
	if c.ReaperInterval <= 0 {
		return errors.New("AO_CLOUD_REAPER_INTERVAL must be positive")
	}
	if c.AutoStopInterval <= 0 || c.AutoDeleteInterval <= 0 {
		return errors.New("provider auto-stop and auto-delete intervals must be positive")
	}
	if c.AutoDeleteInterval <= c.AutoStopInterval {
		return errors.New("provider auto-delete interval must exceed auto-stop")
	}
	if err := c.Quotas.Validate(); err != nil {
		return err
	}
	return c.Reaper.Validate()
}

// Snapshots returns the provider image name for each isolated role.
func (c Config) Snapshots() map[Role]string {
	return map[Role]string{RoleCoordinator: c.CoordinatorSnapshot, RoleWorker: c.WorkerSnapshot}
}

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
		defer clear(content)
		value := strings.TrimSpace(string(content))
		if value == "" {
			return "", fmt.Errorf("%s_FILE is empty", name)
		}
		return value, nil
	}
	value := strings.TrimSpace(getenv(name))
	if value == "" {
		return "", fmt.Errorf("%s is required", name)
	}
	return value, nil
}

func boolValue(value string) bool {
	parsed, err := strconv.ParseBool(strings.TrimSpace(value))
	return err == nil && parsed
}

func durationValue(value string, fallback time.Duration) (time.Duration, error) {
	if strings.TrimSpace(value) == "" {
		return fallback, nil
	}
	parsed, err := time.ParseDuration(strings.TrimSpace(value))
	if err != nil {
		return 0, err
	}
	if parsed < 0 {
		return 0, errors.New("must not be negative")
	}
	return parsed, nil
}

func intValue(value string, fallback int) (int, error) {
	if strings.TrimSpace(value) == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil {
		return 0, err
	}
	if parsed < 0 {
		return 0, errors.New("must not be negative")
	}
	return parsed, nil
}
