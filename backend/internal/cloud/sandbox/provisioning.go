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

	DefaultProvider       = ProviderDocker
	DefaultWorkerTokenTTL = 15 * time.Minute
)

type NodeOpsConfig struct {
	BaseURL          string
	APIKey           string
	DefaultShape     string
	DefaultRootFS    string
	Ingress          string
	SSHKeyPath       string
	WorkerTokenTTL   time.Duration
	AutoPauseSeconds int
}

type DockerConfig struct {
	Host           string
	WorkerImage    string
	Network        string
	Namespace      string
	WorkerTokenTTL time.Duration
}

type DaytonaConfig struct {
	APIURL          string
	APIKey          string
	Target          string
	Snapshot        string
	User            string
	DomainAllowList string
	WorkerTokenTTL  time.Duration
}

func (c DaytonaConfig) Validate() error {
	apiURL, err := url.Parse(strings.TrimSpace(c.APIURL))
	if err != nil || apiURL.Scheme != "https" || apiURL.Host == "" || apiURL.User != nil {
		return errors.New("AO_CLOUD_DAYTONA_API_URL must be an absolute HTTPS URL")
	}
	if strings.TrimSpace(c.APIKey) == "" {
		return errors.New("AO_CLOUD_DAYTONA_API_KEY is required")
	}
	if strings.TrimSpace(c.Snapshot) == "" {
		return errors.New("AO_CLOUD_DAYTONA_SNAPSHOT is required")
	}
	if strings.TrimSpace(c.User) == "" {
		return errors.New("AO_CLOUD_DAYTONA_USER is required")
	}
	if strings.TrimSpace(c.DomainAllowList) == "" {
		return errors.New("AO_CLOUD_DAYTONA_DOMAIN_ALLOW_LIST is required")
	}
	if c.WorkerTokenTTL <= 0 {
		return errors.New("AO_CLOUD_DAYTONA_WORKER_TOKEN_TTL must be positive")
	}
	return nil
}

func (c DockerConfig) Validate() error {
	if !strings.HasPrefix(strings.TrimSpace(c.Host), "unix:///") {
		return errors.New("AO_CLOUD_DOCKER_HOST must be an absolute unix:// path")
	}
	if strings.TrimSpace(c.WorkerImage) == "" {
		return errors.New("AO_CLOUD_DOCKER_WORKER_IMAGE is required")
	}
	if strings.TrimSpace(c.Namespace) == "" {
		return errors.New("AO_CLOUD_DOCKER_NAMESPACE is required")
	}
	if c.WorkerTokenTTL <= 0 {
		return errors.New("AO_CLOUD_DOCKER_WORKER_TOKEN_TTL must be positive")
	}
	return nil
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
	if c.WorkerTokenTTL <= 0 {
		return errors.New("AO_CLOUD_NODEOPS_WORKER_TOKEN_TTL must be positive")
	}
	if c.AutoPauseSeconds < 0 {
		return errors.New("AO_CLOUD_NODEOPS_AUTO_PAUSE_SECONDS must not be negative")
	}
	return nil
}

type ProvisioningDefaults struct {
	Provider string
	Release  string
	NodeOps  NodeOpsConfig
	Daytona  DaytonaConfig
	Docker   DockerConfig
}

type Plan struct {
	Provider         string
	ResourceProfile  json.RawMessage
	BootstrapContext json.RawMessage
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
	resourceProfile := map[string]any{
		"provider": provider,
		"release":  release,
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
			"workerTokenTtlSeconds": int64(d.NodeOps.WorkerTokenTTL / time.Second),
			"autoPauseSeconds":      d.NodeOps.AutoPauseSeconds,
		}
		bootstrapContext["nodeOps"] = map[string]any{
			"baseUrl":               strings.TrimSpace(d.NodeOps.BaseURL),
			"defaultShape":          strings.TrimSpace(d.NodeOps.DefaultShape),
			"defaultRootFs":         strings.TrimSpace(d.NodeOps.DefaultRootFS),
			"ingress":               strings.TrimSpace(d.NodeOps.Ingress),
			"sshKeyPath":            strings.TrimSpace(d.NodeOps.SSHKeyPath),
			"workerTokenTtlSeconds": int64(d.NodeOps.WorkerTokenTTL / time.Second),
			"autoPauseSeconds":      d.NodeOps.AutoPauseSeconds,
		}
	} else if provider == ProviderDaytona {
		if err := d.Daytona.Validate(); err != nil {
			return Plan{}, err
		}
		resourceProfile["daytona"] = map[string]any{
			"target":                strings.TrimSpace(d.Daytona.Target),
			"snapshot":              strings.TrimSpace(d.Daytona.Snapshot),
			"user":                  strings.TrimSpace(d.Daytona.User),
			"domainAllowList":       strings.TrimSpace(d.Daytona.DomainAllowList),
			"workerTokenTtlSeconds": int64(d.Daytona.WorkerTokenTTL / time.Second),
		}
		bootstrapContext["daytona"] = map[string]any{
			"target":   strings.TrimSpace(d.Daytona.Target),
			"snapshot": strings.TrimSpace(d.Daytona.Snapshot),
			"user":     strings.TrimSpace(d.Daytona.User),
		}
	} else if provider == ProviderDocker {
		if err := d.Docker.Validate(); err != nil {
			return Plan{}, err
		}
		resourceProfile["docker"] = map[string]any{
			"workerImage":           strings.TrimSpace(d.Docker.WorkerImage),
			"network":               strings.TrimSpace(d.Docker.Network),
			"namespace":             strings.TrimSpace(d.Docker.Namespace),
			"workerTokenTtlSeconds": int64(d.Docker.WorkerTokenTTL / time.Second),
		}
		bootstrapContext["docker"] = map[string]any{
			"workerImage": strings.TrimSpace(d.Docker.WorkerImage),
			"network":     strings.TrimSpace(d.Docker.Network),
			"namespace":   strings.TrimSpace(d.Docker.Namespace),
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
	}, nil
}

func normalizeProvider(provider string) string {
	return strings.ToLower(strings.TrimSpace(provider))
}
