package sandbox

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
)

const (
	ProviderDocker  = "docker"
	ProviderDaytona = "daytona"
	ProviderECS     = "ecs"
	ProviderNodeOps = "nodeops"

	DefaultProvider         = ProviderDocker
	DefaultAutoPauseMinutes = 30
	DefaultWorkerTokenTTL   = 15 * time.Minute
	minAutoPauseMinutes     = 1
)

type NodeOpsConfig struct {
	BaseURL          string
	APIKey           string
	DefaultShape     string
	DefaultRootFS    string
	Ingress          string
	SSHKeyPath       string
	AutoPauseMinutes int
	WorkerTokenTTL   time.Duration
}

func (c NodeOpsConfig) Validate() error {
	if strings.TrimSpace(c.BaseURL) == "" {
		return errors.New("AO_CLOUD_NODEOPS_BASE_URL is required")
	}
	if _, err := url.ParseRequestURI(c.BaseURL); err != nil {
		return fmt.Errorf("AO_CLOUD_NODEOPS_BASE_URL must be a valid URL: %w", err)
	}
	if strings.TrimSpace(c.APIKey) == "" {
		return errors.New("AO_CLOUD_NODEOPS_API_KEY is required")
	}
	if strings.TrimSpace(c.DefaultShape) == "" {
		return errors.New("AO_CLOUD_NODEOPS_DEFAULT_SHAPE is required")
	}
	if strings.TrimSpace(c.DefaultRootFS) == "" {
		return errors.New("AO_CLOUD_NODEOPS_DEFAULT_ROOTFS is required")
	}
	if c.AutoPauseMinutes < minAutoPauseMinutes {
		return fmt.Errorf("AO_CLOUD_NODEOPS_AUTO_PAUSE_MINUTES must be at least %d", minAutoPauseMinutes)
	}
	if c.WorkerTokenTTL <= 0 {
		return errors.New("AO_CLOUD_NODEOPS_WORKER_TOKEN_TTL must be positive")
	}
	return nil
}

type ProvisioningDefaults struct {
	Provider string
	Release  string
	NodeOps  NodeOpsConfig
}

type Plan struct {
	Provider         string
	ResourceProfile  json.RawMessage
	BootstrapContext json.RawMessage
	AutoStopMinutes  int
}

func (d ProvisioningDefaults) SessionPlan() (Plan, error) {
	provider := normalizeProvider(d.Provider)
	if provider == "" {
		provider = DefaultProvider
	}
	release := strings.TrimSpace(d.Release)
	if release == "" {
		release = "dev"
	}
	autoPauseMinutes := d.NodeOps.AutoPauseMinutes
	if autoPauseMinutes < minAutoPauseMinutes {
		autoPauseMinutes = DefaultAutoPauseMinutes
	}
	resourceProfile := map[string]any{
		"provider":        provider,
		"release":         release,
		"autoStopMinutes": autoPauseMinutes,
	}
	bootstrapContext := map[string]any{
		"provider": provider,
		"release":  release,
	}
	if provider == ProviderNodeOps {
		if err := d.NodeOps.Validate(); err != nil {
			return Plan{}, err
		}
		resourceProfile["nodeOps"] = map[string]any{
			"baseUrl":               strings.TrimSpace(d.NodeOps.BaseURL),
			"defaultShape":          strings.TrimSpace(d.NodeOps.DefaultShape),
			"defaultRootFs":         strings.TrimSpace(d.NodeOps.DefaultRootFS),
			"ingress":               strings.TrimSpace(d.NodeOps.Ingress),
			"sshKeyPath":            strings.TrimSpace(d.NodeOps.SSHKeyPath),
			"autoPauseMinutes":      autoPauseMinutes,
			"workerTokenTtlSeconds": int64(d.NodeOps.WorkerTokenTTL / time.Second),
		}
		bootstrapContext["nodeOps"] = map[string]any{
			"baseUrl":               strings.TrimSpace(d.NodeOps.BaseURL),
			"defaultShape":          strings.TrimSpace(d.NodeOps.DefaultShape),
			"defaultRootFs":         strings.TrimSpace(d.NodeOps.DefaultRootFS),
			"ingress":               strings.TrimSpace(d.NodeOps.Ingress),
			"sshKeyPath":            strings.TrimSpace(d.NodeOps.SSHKeyPath),
			"autoPauseMinutes":      autoPauseMinutes,
			"workerTokenTtlSeconds": int64(d.NodeOps.WorkerTokenTTL / time.Second),
		}
	}
	resourceJSON, err := json.Marshal(resourceProfile)
	if err != nil {
		return Plan{}, err
	}
	bootstrapJSON, err := json.Marshal(bootstrapContext)
	if err != nil {
		return Plan{}, err
	}
	return Plan{
		Provider:         provider,
		ResourceProfile:  resourceJSON,
		BootstrapContext: bootstrapJSON,
		AutoStopMinutes:  autoPauseMinutes,
	}, nil
}

func normalizeProvider(provider string) string {
	return strings.ToLower(strings.TrimSpace(provider))
}
