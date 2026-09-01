package sandbox

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path"
	"strings"
	"time"
)

const (
	ProviderDocker  = "docker"
	ProviderDaytona = "daytona"
	ProviderECS     = "ecs"
	ProviderNodeOps = "nodeops"
	ProviderCoder   = "coder"

	DefaultProvider       = ProviderDocker
	DefaultWorkerTokenTTL = 15 * time.Minute
)

type NodeOpsConfig struct {
	BaseURL       string
	APIKey        string
	DefaultShape  string
	DefaultRootFS string
	// RootFSByHarness maps a coding-agent harness (e.g. "claude-code") to a
	// slimmer template that bakes only that agent. A session whose harness has
	// a mapping provisions from it; anything unmapped falls back to
	// DefaultRootFS. Smaller templates shrink the provider's cold-host image
	// pull, which dominates worst-case sandbox creation time.
	RootFSByHarness  map[string]string
	Ingress          string
	SSHKeyPath       string
	WorkerTokenTTL   time.Duration
	AutoPauseSeconds int
}

// rootFSForHarness resolves the template one session provisions from.
func (c NodeOpsConfig) rootFSForHarness(harness string) string {
	if rootFS := strings.TrimSpace(c.RootFSByHarness[strings.TrimSpace(harness)]); rootFS != "" {
		return rootFS
	}
	return strings.TrimSpace(c.DefaultRootFS)
}

type DockerConfig struct {
	Host           string
	WorkerImage    string
	Network        string
	Namespace      string
	WorkerTokenTTL time.Duration
}

type CoderConfig struct {
	BaseURL        string
	Owner          string
	TemplateID     string
	AgentName      string
	Parameters     map[string]string
	DurableRoot    string
	WorkerTokenTTL time.Duration
}

// CoderWorkspaceLayout is the provider-specific filesystem contract between AO
// and a Coder template. DurableRoot must be the template's persistent volume
// mount point; every path AO must retain across stop/start is derived beneath it.
type CoderWorkspaceLayout struct {
	DurableRoot     string
	Repository      string
	WorkerData      string
	Home            string
	ClaudeConfig    string
	CodexHome       string
	DurableIdentity string
}

// NewCoderWorkspaceLayout validates and expands the configured Coder volume
// mount. Bootstrap separately verifies that DurableRoot is an actual mount point
// inside the workspace before AO writes anything beneath it.
func NewCoderWorkspaceLayout(durableRoot string) (CoderWorkspaceLayout, error) {
	durableRoot = strings.TrimSpace(durableRoot)
	if durableRoot == "" {
		return CoderWorkspaceLayout{}, errors.New("AO_CLOUD_CODER_DURABLE_ROOT is required")
	}
	if len(durableRoot) > 1024 || !strings.HasPrefix(durableRoot, "/") ||
		path.Clean(durableRoot) != durableRoot || durableRoot == "/" ||
		strings.IndexFunc(durableRoot, func(character rune) bool {
			return character < ' ' || character == 0x7f
		}) >= 0 {
		return CoderWorkspaceLayout{}, errors.New(
			"AO_CLOUD_CODER_DURABLE_ROOT must be a safe absolute non-root path",
		)
	}
	aoRoot := path.Join(durableRoot, ".ao")
	home := path.Join(aoRoot, "home")
	return CoderWorkspaceLayout{
		DurableRoot:     durableRoot,
		Repository:      path.Join(durableRoot, "repository"),
		WorkerData:      path.Join(aoRoot, "worker"),
		Home:            home,
		ClaudeConfig:    path.Join(home, ".claude"),
		CodexHome:       path.Join(home, ".codex"),
		DurableIdentity: path.Join(aoRoot, "durable-session-id"),
	}, nil
}

func (c CoderConfig) Validate() error {
	endpoint, err := url.Parse(strings.TrimSpace(c.BaseURL))
	if err != nil || endpoint.Host == "" || endpoint.User != nil ||
		(endpoint.Scheme != "http" && endpoint.Scheme != "https") ||
		(endpoint.Path != "" && endpoint.Path != "/") || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return errors.New("AO_CLOUD_CODER_URL must be an absolute http or https origin")
	}
	if strings.TrimSpace(c.Owner) == "" {
		return errors.New("AO_CLOUD_CODER_OWNER is required")
	}
	if strings.TrimSpace(c.TemplateID) == "" {
		return errors.New("AO_CLOUD_CODER_TEMPLATE_ID is required")
	}
	if _, err := NewCoderWorkspaceLayout(c.DurableRoot); err != nil {
		return err
	}
	if c.WorkerTokenTTL <= 0 {
		return errors.New("AO_CLOUD_CODER_WORKER_TOKEN_TTL must be positive")
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
	Docker   DockerConfig
	Coder    CoderConfig
}

type Plan struct {
	Provider         string
	ResourceProfile  json.RawMessage
	BootstrapContext json.RawMessage
}

// SessionPlan stamps the provisioning plan one session's sandbox runs from.
// The harness selects the rootfs template when a per-harness mapping exists
// (see NodeOpsConfig.RootFSByHarness); the plan is stored on the sandbox row,
// so the choice sticks for the session's whole life, including recreates.
func (d ProvisioningDefaults) SessionPlan(harness string) (Plan, error) {
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
		rootFS := d.NodeOps.rootFSForHarness(harness)
		resourceProfile["nodeOps"] = map[string]any{
			"baseUrl":               strings.TrimSpace(d.NodeOps.BaseURL),
			"defaultShape":          strings.TrimSpace(d.NodeOps.DefaultShape),
			"defaultRootFs":         rootFS,
			"ingress":               strings.TrimSpace(d.NodeOps.Ingress),
			"sshKeyPath":            strings.TrimSpace(d.NodeOps.SSHKeyPath),
			"workerTokenTtlSeconds": int64(d.NodeOps.WorkerTokenTTL / time.Second),
			"autoPauseSeconds":      d.NodeOps.AutoPauseSeconds,
		}
		bootstrapContext["nodeOps"] = map[string]any{
			"baseUrl":               strings.TrimSpace(d.NodeOps.BaseURL),
			"defaultShape":          strings.TrimSpace(d.NodeOps.DefaultShape),
			"defaultRootFs":         rootFS,
			"ingress":               strings.TrimSpace(d.NodeOps.Ingress),
			"sshKeyPath":            strings.TrimSpace(d.NodeOps.SSHKeyPath),
			"workerTokenTtlSeconds": int64(d.NodeOps.WorkerTokenTTL / time.Second),
			"autoPauseSeconds":      d.NodeOps.AutoPauseSeconds,
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
	} else if provider == ProviderCoder {
		if err := d.Coder.Validate(); err != nil {
			return Plan{}, err
		}
		resourceProfile["coder"] = map[string]any{
			"baseUrl":               strings.TrimRight(strings.TrimSpace(d.Coder.BaseURL), "/"),
			"owner":                 strings.TrimSpace(d.Coder.Owner),
			"templateId":            strings.TrimSpace(d.Coder.TemplateID),
			"agentName":             strings.TrimSpace(d.Coder.AgentName),
			"parameters":            d.Coder.Parameters,
			"durableRoot":           strings.TrimSpace(d.Coder.DurableRoot),
			"workerTokenTtlSeconds": int64(d.Coder.WorkerTokenTTL / time.Second),
		}
		bootstrapContext["coder"] = map[string]any{
			"owner":       strings.TrimSpace(d.Coder.Owner),
			"templateId":  strings.TrimSpace(d.Coder.TemplateID),
			"agentName":   strings.TrimSpace(d.Coder.AgentName),
			"durableRoot": strings.TrimSpace(d.Coder.DurableRoot),
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
