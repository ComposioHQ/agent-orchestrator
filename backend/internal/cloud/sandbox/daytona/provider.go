package daytona

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/sandbox"
)

var (
	ErrNotFound = errors.New("Daytona sandbox not found")
	safePath    = regexp.MustCompile(`^/[A-Za-z0-9._/-]+$`)
	safeUser    = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)
)

const labelSessionID = "ao.session_id"

type Config struct {
	APIURL          string
	APIKey          string
	Target          string
	Snapshot        string
	User            string
	DomainAllowList string
	WorkerTokenTTL  time.Duration
	Client          Client
}

func (c Config) Validate() error {
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
	if !safeUser.MatchString(strings.TrimSpace(c.User)) {
		return errors.New("AO_CLOUD_DAYTONA_USER must be a valid Linux user")
	}
	if strings.TrimSpace(c.DomainAllowList) == "" {
		return errors.New("AO_CLOUD_DAYTONA_DOMAIN_ALLOW_LIST is required")
	}
	if c.WorkerTokenTTL <= 0 {
		return errors.New("AO_CLOUD_DAYTONA_WORKER_TOKEN_TTL must be positive")
	}
	return nil
}

type Provider struct {
	client Client
	config Config
}

func New(config Config) (*Provider, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	client := config.Client
	if client == nil {
		var err error
		client, err = NewSDKClient(config)
		if err != nil {
			return nil, err
		}
	}
	return &Provider{client: client, config: config}, nil
}

func (p *Provider) Create(ctx context.Context, spec sandbox.Spec) (sandbox.Environment, error) {
	if strings.TrimSpace(spec.SessionID) == "" || strings.TrimSpace(spec.OrgID) == "" {
		return sandbox.Environment{}, errors.New("daytona sandbox requires AO session and organization labels")
	}
	labels := make(map[string]string, len(spec.Labels)+2)
	for key, value := range spec.Labels {
		labels[key] = value
	}
	labels[labelSessionID] = spec.SessionID
	labels["ao.org_id"] = spec.OrgID
	labels["ao.managed"] = "true"
	remote, err := p.client.Create(ctx, CreateRequest{
		Name:     spec.Name,
		Snapshot: firstNonEmpty(spec.RootFS, p.config.Snapshot),
		User:     firstNonEmpty(spec.User, p.config.User),
		Target:   firstNonEmpty(spec.Target, p.config.Target),
		// Worker credentials are injected only into the one bootstrap command.
		// Daytona sandbox environment variables are durable provider metadata,
		// so persisting the single-use ticket there would violate AO custody.
		Environment:     map[string]string{},
		Labels:          labels,
		DomainAllowList: firstNonEmpty(spec.DomainAllowList, p.config.DomainAllowList),
		CPU:             spec.ResourceProfile.CPU,
		Memory:          spec.ResourceProfile.Memory,
		Disk:            spec.ResourceProfile.Disk,
	})
	if err != nil {
		return sandbox.Environment{}, normalizeProviderError(err)
	}
	return environment(remote), nil
}

func (p *Provider) Get(ctx context.Context, id sandbox.ID) (sandbox.Environment, error) {
	remote, err := p.client.Get(ctx, string(id))
	if err != nil {
		return sandbox.Environment{}, normalizeProviderError(err)
	}
	return environment(remote), nil
}

func (p *Provider) FindBySession(
	ctx context.Context,
	sessionID string,
) (sandbox.Environment, bool, error) {
	values, err := p.client.List(ctx, map[string]string{
		labelSessionID: sessionID,
		"ao.managed":   "true",
	})
	if err != nil {
		return sandbox.Environment{}, false, normalizeProviderError(err)
	}
	for _, value := range values {
		if value.Labels[labelSessionID] == sessionID && value.Labels["ao.managed"] == "true" &&
			normalizeState(value.State) != sandbox.StateDeleted {
			return environment(value), true, nil
		}
	}
	return sandbox.Environment{}, false, nil
}

func (p *Provider) Start(ctx context.Context, id sandbox.ID) error {
	return normalizeProviderError(p.client.Start(ctx, string(id)))
}

func (p *Provider) Stop(ctx context.Context, id sandbox.ID) error {
	return normalizeProviderError(p.client.Stop(ctx, string(id)))
}

func (p *Provider) Pause(ctx context.Context, id sandbox.ID) error {
	return normalizeProviderError(p.client.Pause(ctx, string(id)))
}

func (p *Provider) Resume(ctx context.Context, id sandbox.ID) error {
	return p.Start(ctx, id)
}

func (p *Provider) Delete(ctx context.Context, id sandbox.ID) error {
	err := normalizeProviderError(p.client.Delete(ctx, string(id)))
	if errors.Is(err, sandbox.ErrNotFound) {
		return nil
	}
	return err
}

func (p *Provider) BootstrapWorker(
	ctx context.Context,
	id sandbox.ID,
	bootstrap sandbox.WorkerBootstrap,
) error {
	if len(bootstrap.Binary) == 0 || !safePath.MatchString(bootstrap.Destination) {
		return errors.New("daytona worker bootstrap requires a binary and safe absolute destination")
	}
	if !safeUser.MatchString(bootstrap.User) {
		return errors.New("daytona worker bootstrap user is invalid")
	}
	workerStage := bootstrap.Destination + ".new"
	if err := p.client.Upload(ctx, string(id), workerStage, bootstrap.Binary); err != nil {
		return fmt.Errorf("upload Daytona worker: %w", normalizeProviderError(err))
	}
	helperStage := ""
	if len(bootstrap.HelperBinary) > 0 {
		if !safePath.MatchString(bootstrap.HelperDestination) {
			return errors.New("daytona helper destination must be a safe absolute path")
		}
		helperStage = bootstrap.HelperDestination + ".new"
		if err := p.client.Upload(ctx, string(id), helperStage, bootstrap.HelperBinary); err != nil {
			return fmt.Errorf("upload Daytona helper: %w", normalizeProviderError(err))
		}
	}
	command := "set -eu; install -d -m 0700 /workspace/.ao/home; " +
		"install -d -o " + bootstrap.User + " -g " + bootstrap.User + " -m 0700 /dev/shm/ao-worker; " +
		"install -m 0755 " + workerStage + " " + bootstrap.Destination + "; rm -f " + workerStage + "; "
	if helperStage != "" {
		command += "install -m 0755 " + helperStage + " " + bootstrap.HelperDestination + "; rm -f " + helperStage + "; "
	}
	command += "chown -R " + bootstrap.User + ":" + bootstrap.User + " /workspace; " +
		"runuser -u " + bootstrap.User + " --preserve-environment -- sh -c 'nohup " +
		bootstrap.Destination + " >/dev/shm/ao-worker/worker.log 2>&1 </dev/null &'"
	result, err := p.client.Execute(ctx, string(id), command, bootstrap.Environment)
	if err != nil {
		return fmt.Errorf("start Daytona worker: %w", normalizeProviderError(err))
	}
	if result.ExitCode != 0 {
		return fmt.Errorf("start Daytona worker exited %d: %s", result.ExitCode, truncate(result.Output))
	}
	return nil
}

func environment(value RemoteSandbox) sandbox.Environment {
	return sandbox.Environment{
		ID: sandbox.ID(value.ID), Name: value.Name, State: normalizeState(value.State), Target: value.Target,
		Resource: domain.ResourceProfile{CPU: value.CPU, Memory: value.Memory, Disk: value.Disk},
	}
}

func normalizeState(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "started":
		return sandbox.StateRunning
	case "stopped":
		return sandbox.StateStopped
	case "paused":
		return sandbox.StatePaused
	case "destroying", "deleting":
		return sandbox.StateDeleting
	case "destroyed", "deleted":
		return sandbox.StateDeleted
	default:
		return sandbox.StateProvisioning
	}
}

func normalizeProviderError(err error) error {
	if errors.Is(err, ErrNotFound) {
		return fmt.Errorf("%w: %w", sandbox.ErrNotFound, err)
	}
	return err
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

func truncate(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > 512 {
		return value[:512] + "…"
	}
	return value
}
