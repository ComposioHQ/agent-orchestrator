// Package daytona adapts Daytona's sandbox API to the compute plane's
// Provider port.
//
// Everything vendor-specific stops here: Daytona's state vocabulary is
// normalized to runtime.ProviderState, its 404s become
// runtime.ErrSandboxNotFound, and its label map is the only place AO's
// attribution scheme is written to the wire. The lifecycle and the reconciler
// never see a Daytona type.
package daytona

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"mime/multipart"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/runtime"
)

// DefaultBaseURL is Daytona's hosted API root.
const DefaultBaseURL = "https://app.daytona.io/api"

// secretFileMode is the permission every delivered secret file is set to:
// owner read/write only. The agent process inside the sandbox runs as that
// owner; nothing else in the sandbox should be able to read a credential.
const secretFileMode = "0600"

// Options configures the adapter.
type Options struct {
	// BaseURL defaults to DefaultBaseURL. It is configurable so a deployment
	// can point at a self-hosted Daytona or a test double.
	BaseURL string
	// APIKey authenticates every call. It must be supplied from the process
	// environment or a mounted secret, never a command line.
	APIKey string
	// OrganizationID selects the Daytona organization sandboxes are created
	// in. This is Daytona's own tenancy, not an AO organization.
	OrganizationID string
	// Target is the Daytona region.
	Target string
	// HTTPClient defaults to a client with Timeout applied.
	HTTPClient *http.Client
	// Timeout bounds each API call.
	Timeout time.Duration
	Logger  *slog.Logger
}

// Provider is the Daytona-backed runtime.Provider.
type Provider struct {
	baseURL string
	apiKey  string
	orgID   string
	target  string
	client  *http.Client
	logger  *slog.Logger
}

var _ runtime.Provider = (*Provider)(nil)

const defaultTimeout = 60 * time.Second

// New validates the adapter configuration and builds a provider.
func New(options Options) (*Provider, error) {
	apiKey := strings.TrimSpace(options.APIKey)
	if apiKey == "" {
		return nil, errors.New("daytona API key is required")
	}
	baseURL := strings.TrimRight(strings.TrimSpace(options.BaseURL), "/")
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	if _, err := url.Parse(baseURL); err != nil {
		return nil, fmt.Errorf("daytona base URL: %w", err)
	}
	client := options.HTTPClient
	if client == nil {
		timeout := options.Timeout
		if timeout <= 0 {
			timeout = defaultTimeout
		}
		client = &http.Client{Timeout: timeout}
	}
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &Provider{
		baseURL: baseURL,
		apiKey:  apiKey,
		orgID:   strings.TrimSpace(options.OrganizationID),
		target:  strings.TrimSpace(options.Target),
		client:  client,
		logger:  logger,
	}, nil
}

// sandboxPayload is Daytona's sandbox representation, reduced to the fields
// the compute plane needs.
type sandboxPayload struct {
	ID          string            `json:"id"`
	State       string            `json:"state"`
	Labels      map[string]string `json:"labels"`
	CreatedAt   string            `json:"createdAt"`
	UpdatedAt   string            `json:"updatedAt"`
	ErrorReason string            `json:"errorReason"`
}

type createPayload struct {
	Snapshot           string            `json:"snapshot,omitempty"`
	Target             string            `json:"target,omitempty"`
	Labels             map[string]string `json:"labels,omitempty"`
	EnvVars            map[string]string `json:"envVars,omitempty"`
	CPU                int               `json:"cpu,omitempty"`
	Memory             int               `json:"memory,omitempty"`
	Disk               int               `json:"disk,omitempty"`
	AutoStopInterval   *int              `json:"autoStopInterval,omitempty"`
	AutoDeleteInterval *int              `json:"autoDeleteInterval,omitempty"`
}

// Create provisions a sandbox with its AO labels applied atomically at
// creation. Labels are never added afterwards: a create-then-label sequence
// leaves a window in which the sandbox cannot be attributed, and a crash
// inside that window produces exactly the unattributable leak the label scheme
// exists to prevent.
func (p *Provider) Create(ctx context.Context, request runtime.CreateRequest) (runtime.Sandbox, error) {
	if err := request.Validate(); err != nil {
		return runtime.Sandbox{}, err
	}
	body := createPayload{
		Snapshot:           request.Snapshot,
		Target:             p.target,
		Labels:             request.Labels,
		EnvVars:            request.Env,
		CPU:                request.Resources.CPU,
		Memory:             request.Resources.MemoryGB,
		Disk:               request.Resources.DiskGB,
		AutoStopInterval:   minutes(request.AutoStopInterval),
		AutoDeleteInterval: minutes(request.AutoDeleteInterval),
	}
	header := http.Header{}
	if key := strings.TrimSpace(request.IdempotencyKey); key != "" {
		header.Set("Idempotency-Key", key)
	}
	var payload sandboxPayload
	if err := p.call(ctx, http.MethodPost, "/sandbox", nil, header, body, &payload); err != nil {
		return runtime.Sandbox{}, err
	}
	sandbox := toSandbox(payload)

	// Secret files are delivered after creation because the create API carries
	// only environment variables. A delivery failure destroys the sandbox
	// rather than returning it: a half-provisioned sandbox missing its
	// credentials is useless, and leaving it behind would be a leak the caller
	// has no id for (the create error path never records a provider id).
	if len(request.SecretFiles) > 0 {
		if err := p.deliverSecretFiles(ctx, sandbox.ID, request.SecretFiles); err != nil {
			if deleteErr := p.Delete(ctx, sandbox.ID); deleteErr != nil && !errors.Is(deleteErr, runtime.ErrSandboxNotFound) {
				p.logger.Error("could not remove a sandbox whose secret delivery failed; it will be reaped as an orphan",
					"provider_sandbox", sandbox.ID, "error", deleteErr)
			}
			return runtime.Sandbox{}, err
		}
	}
	return sandbox, nil
}

// Get returns one sandbox.
func (p *Provider) Get(ctx context.Context, id string) (runtime.Sandbox, error) {
	var payload sandboxPayload
	if err := p.call(ctx, http.MethodGet, "/sandbox/"+url.PathEscape(id), nil, nil, nil, &payload); err != nil {
		return runtime.Sandbox{}, err
	}
	sandbox := toSandbox(payload)
	// A destroyed sandbox is gone as far as the control plane is concerned.
	// Reporting it as an error state instead would make the reconciler keep a
	// row pointing at compute that can never come back.
	if isDestroyed(payload.State) {
		return runtime.Sandbox{}, runtime.ErrSandboxNotFound
	}
	return sandbox, nil
}

// Start boots a stopped sandbox.
func (p *Provider) Start(ctx context.Context, id string) (runtime.Sandbox, error) {
	return p.transition(ctx, id, "start")
}

// Stop suspends a running sandbox.
func (p *Provider) Stop(ctx context.Context, id string) (runtime.Sandbox, error) {
	return p.transition(ctx, id, "stop")
}

func (p *Provider) transition(ctx context.Context, id, action string) (runtime.Sandbox, error) {
	path := "/sandbox/" + url.PathEscape(id) + "/" + action
	if err := p.call(ctx, http.MethodPost, path, nil, nil, nil, nil); err != nil {
		return runtime.Sandbox{}, err
	}
	return p.Get(ctx, id)
}

// Delete destroys a sandbox. A sandbox that is already gone is success, which
// is what makes the delete cascade and the reaper safe to retry.
func (p *Provider) Delete(ctx context.Context, id string) error {
	query := url.Values{"force": []string{"true"}}
	err := p.call(ctx, http.MethodDelete, "/sandbox/"+url.PathEscape(id), query, nil, nil, nil)
	if errors.Is(err, runtime.ErrSandboxNotFound) {
		return nil
	}
	return err
}

// List enumerates sandboxes. An empty selector lists everything in the
// Daytona organization, which is what unattributable-leak discovery needs:
// a leaked sandbox has no labels to filter on.
func (p *Provider) List(ctx context.Context, selector runtime.Selector) ([]runtime.Sandbox, error) {
	query := url.Values{}
	if len(selector.Labels) > 0 {
		encoded, err := json.Marshal(selector.Labels)
		if err != nil {
			return nil, err
		}
		query.Set("labels", string(encoded))
	}
	var payloads []sandboxPayload
	if err := p.call(ctx, http.MethodGet, "/sandbox", query, nil, nil, &payloads); err != nil {
		return nil, err
	}
	sandboxes := make([]runtime.Sandbox, 0, len(payloads))
	for _, payload := range payloads {
		if isDestroyed(payload.State) {
			continue
		}
		sandboxes = append(sandboxes, toSandbox(payload))
	}
	return sandboxes, nil
}

// deliverSecretFiles uploads each secret into the sandbox and then tightens
// its permissions to owner-only.
func (p *Provider) deliverSecretFiles(ctx context.Context, id string, files map[string]string) error {
	for path, content := range files {
		if strings.TrimSpace(path) == "" {
			return fmt.Errorf("%w: secret file path is empty", runtime.ErrInvalid)
		}
		if err := p.uploadFile(ctx, id, path, content); err != nil {
			return fmt.Errorf("deliver secret file %s: %w", path, err)
		}
		permissions := url.Values{"path": []string{path}, "mode": []string{secretFileMode}}
		toolbox := "/toolbox/" + url.PathEscape(id) + "/toolbox/files/permissions"
		if err := p.call(ctx, http.MethodPost, toolbox, permissions, nil, nil, nil); err != nil {
			return fmt.Errorf("restrict secret file %s: %w", path, err)
		}
	}
	return nil
}

func (p *Provider) uploadFile(ctx context.Context, id, path, content string) error {
	buffer := &bytes.Buffer{}
	writer := multipart.NewWriter(buffer)
	part, err := writer.CreateFormFile("file", path)
	if err != nil {
		return err
	}
	if _, err := io.WriteString(part, content); err != nil {
		return err
	}
	if err := writer.Close(); err != nil {
		return err
	}
	target := p.baseURL + "/toolbox/" + url.PathEscape(id) + "/toolbox/files/upload?" +
		url.Values{"path": []string{path}}.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target, buffer)
	if err != nil {
		return err
	}
	p.applyHeaders(request)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response, err := p.client.Do(request)
	if err != nil {
		return err
	}
	defer func() { _, _ = io.Copy(io.Discard, response.Body); _ = response.Body.Close() }()
	return statusError(response)
}

// call performs one JSON API request.
func (p *Provider) call(ctx context.Context, method, path string, query url.Values, header http.Header, body, out any) error {
	target := p.baseURL + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return err
	}
	p.applyHeaders(request)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	for name, values := range header {
		for _, value := range values {
			request.Header.Set(name, value)
		}
	}
	response, err := p.client.Do(request)
	if err != nil {
		return fmt.Errorf("daytona %s %s: %w", method, path, err)
	}
	defer func() { _, _ = io.Copy(io.Discard, response.Body); _ = response.Body.Close() }()
	if err := statusError(response); err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	if err := json.NewDecoder(response.Body).Decode(out); err != nil {
		return fmt.Errorf("daytona %s %s: decode response: %w", method, path, err)
	}
	return nil
}

func (p *Provider) applyHeaders(request *http.Request) {
	// The API key travels in a header, never a query parameter: a credential
	// in a URL is copied into every proxy and access log on the path.
	request.Header.Set("Authorization", "Bearer "+p.apiKey)
	request.Header.Set("Accept", "application/json")
	if p.orgID != "" {
		request.Header.Set("X-Daytona-Organization-ID", p.orgID)
	}
}

// statusError converts an HTTP status into the port's error vocabulary. The
// response body is truncated because it is attacker-influenced and ends up in
// logs; the status and a bounded excerpt are enough to diagnose.
func statusError(response *http.Response) error {
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return nil
	}
	if response.StatusCode == http.StatusNotFound || response.StatusCode == http.StatusGone {
		return runtime.ErrSandboxNotFound
	}
	excerpt, _ := io.ReadAll(io.LimitReader(response.Body, 512))
	return fmt.Errorf("daytona responded %d: %s", response.StatusCode, strings.TrimSpace(string(excerpt)))
}

func toSandbox(payload sandboxPayload) runtime.Sandbox {
	return runtime.Sandbox{
		ID:        payload.ID,
		State:     providerState(payload.State),
		Labels:    payload.Labels,
		CreatedAt: parseTime(payload.CreatedAt),
		Error:     payload.ErrorReason,
	}
}

// providerState normalizes Daytona's state vocabulary. Unknown values map to
// ProviderError rather than a guess at "running": treating an unrecognized
// state as healthy would keep the control plane paying for a broken sandbox.
func providerState(state string) runtime.ProviderState {
	switch strings.ToLower(strings.TrimSpace(state)) {
	case "started", "running":
		return runtime.ProviderRunning
	case "creating", "starting", "restoring", "pending", "pending_build", "building", "pulling_snapshot", "unknown":
		return runtime.ProviderStarting
	case "stopped", "stopping", "archived", "archiving", "pending_archive":
		return runtime.ProviderStopped
	default:
		return runtime.ProviderError
	}
}

func isDestroyed(state string) bool {
	switch strings.ToLower(strings.TrimSpace(state)) {
	case "destroyed", "destroying", "pending_destroy":
		return true
	default:
		return false
	}
}

func parseTime(value string) time.Time {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.999Z0700"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed.UTC()
		}
	}
	return time.Time{}
}

// minutes converts a duration to whole minutes for Daytona's interval fields,
// rounding a non-zero sub-minute duration up to one minute so "stop it as soon
// as you can" never becomes "never stop it".
func minutes(duration time.Duration) *int {
	if duration <= 0 {
		return nil
	}
	value := int(math.Ceil(duration.Minutes()))
	if value < 1 {
		value = 1
	}
	return &value
}
