// Package daytona adapts Daytona's sandbox API to AO's provider-neutral
// compute port. Vendor states, routes, and payloads do not escape this package.
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

const (
	// DefaultBaseURL is Daytona's hosted API root.
	DefaultBaseURL         = "https://app.daytona.io/api"
	defaultTimeout         = 60 * time.Second
	bootstrapSessionPrefix = "ao-runtime-"
)

// Options configures the Daytona adapter.
type Options struct {
	BaseURL        string
	APIKey         string
	OrganizationID string
	Target         string
	HTTPClient     *http.Client
	Timeout        time.Duration
	Logger         *slog.Logger
}

// Provider is a Daytona-backed compute provider.
type Provider struct {
	baseURL string
	apiKey  string
	orgID   string
	target  string
	client  *http.Client
	logger  *slog.Logger
}

var _ runtime.Provider = (*Provider)(nil)

// New validates configuration and constructs a provider. Credentials are
// accepted only as data; callers load them from a protected file or secret
// manager, never from process arguments.
func New(options Options) (*Provider, error) {
	apiKey := strings.TrimSpace(options.APIKey)
	if apiKey == "" {
		return nil, errors.New("daytona API key is required")
	}
	baseURL := strings.TrimRight(strings.TrimSpace(options.BaseURL), "/")
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, fmt.Errorf("daytona base URL is invalid")
	}
	loopback := isLoopback(parsed.Hostname())
	if parsed.Scheme != "https" && !loopback {
		return nil, errors.New("daytona base URL must use https except for a loopback test server")
	}
	client := options.HTTPClient
	if client == nil {
		timeout := options.Timeout
		if timeout <= 0 {
			timeout = defaultTimeout
		}
		client = &http.Client{Timeout: timeout}
	}
	if transport, ok := client.Transport.(*http.Transport); ok && transport.TLSClientConfig != nil && transport.TLSClientConfig.InsecureSkipVerify {
		return nil, errors.New("daytona HTTP client must verify TLS certificates")
	}
	if client.Transport != nil {
		if _, ok := client.Transport.(*http.Transport); !ok && !loopback {
			return nil, errors.New("daytona remote client requires the standard verified HTTP transport")
		}
	}
	clientCopy := *client
	clientCopy.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	client = &clientCopy
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

func isLoopback(host string) bool {
	return host == "127.0.0.1" || host == "::1" || strings.EqualFold(host, "localhost")
}

type sandboxPayload struct {
	ID             string            `json:"id"`
	State          string            `json:"state"`
	Labels         map[string]string `json:"labels"`
	CreatedAt      string            `json:"createdAt"`
	UpdatedAt      string            `json:"updatedAt"`
	LastActivityAt string            `json:"lastActivityAt"`
	ErrorReason    string            `json:"errorReason"`
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

// Create provisions, delivers transient files, and starts the semantic
// command. Daytona snapshot creation does not accept a per-sandbox entrypoint,
// so the adapter starts one stable asynchronous process session after the
// sandbox is ready. Once Daytona returns an id, a later bootstrap failure
// returns that sandbox alongside the error so the manager can persist its
// handle and reconcile or delete it durably.
func (p *Provider) Create(ctx context.Context, request runtime.CreateRequest) (sandbox runtime.Sandbox, err error) {
	defer func() { runtime.PurgeFileSecrets(request.SecretFiles) }()
	defer func() { runtime.PurgeFileSecrets([]runtime.FileSecret{request.Capability}) }()
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
	sandbox = toSandbox(payload)
	if strings.TrimSpace(sandbox.ID) == "" {
		return runtime.Sandbox{}, errors.New("daytona create returned an empty sandbox id")
	}
	files := append(append([]runtime.FileSecret(nil), request.SecretFiles...), request.Capability)
	if err := p.deliverSecretFiles(ctx, sandbox.ID, files); err != nil {
		return sandbox, err
	}
	runtimeID := request.Labels[runtime.LabelRuntimeID]
	launched, err := p.bootstrap(ctx, sandbox.ID, runtimeID, request.Ref, request.ControlPlaneURL, request.Command, request.Args, runtimeID)
	if err != nil {
		return sandbox, err
	}
	if !launched {
		p.logger.Debug("cloud sandbox bootstrap session already exists", "provider_sandbox", sandbox.ID)
	}
	return sandbox, nil
}

// Get returns one provider sandbox or runtime.ErrSandboxNotFound.
func (p *Provider) Get(ctx context.Context, id string) (runtime.Sandbox, error) {
	var payload sandboxPayload
	if err := p.call(ctx, http.MethodGet, "/sandbox/"+url.PathEscape(id), nil, nil, nil, &payload); err != nil {
		return runtime.Sandbox{}, err
	}
	if isDestroyed(payload.State) {
		return runtime.Sandbox{}, runtime.ErrSandboxNotFound
	}
	return toSandbox(payload), nil
}

// Start boots a sandbox and launches ao-sandbox with a fresh capability file.
func (p *Provider) Start(ctx context.Context, id string, request runtime.StartRequest) (sandbox runtime.Sandbox, err error) {
	defer func() { runtime.PurgeFileSecrets(request.SecretFiles) }()
	defer func() { runtime.PurgeFileSecrets([]runtime.FileSecret{request.Capability}) }()
	if err := request.Validate(); err != nil {
		return runtime.Sandbox{}, err
	}
	sandbox, err = p.transition(ctx, id, "start")
	if err != nil {
		return runtime.Sandbox{}, err
	}
	files := append(append([]runtime.FileSecret(nil), request.SecretFiles...), request.Capability)
	if err := p.deliverSecretFiles(ctx, id, files); err != nil {
		return sandbox, err
	}
	if err := p.cleanupBootstrapSessions(ctx, id, bootstrapSessionPrefix+request.BootstrapKey); err != nil {
		return sandbox, err
	}
	if _, err := p.bootstrap(ctx, id, request.RuntimeID, request.Ref, request.ControlPlaneURL, request.Command, request.Args, request.BootstrapKey); err != nil {
		return sandbox, err
	}
	return sandbox, nil
}

// Stop terminates AO bootstrap sessions before suspending the sandbox.
func (p *Provider) Stop(ctx context.Context, id string) (runtime.Sandbox, error) {
	current, err := p.Get(ctx, id)
	if err != nil {
		return runtime.Sandbox{}, err
	}
	if current.State == runtime.ProviderStopped {
		return current, nil
	}
	if err := p.cleanupBootstrapSessions(ctx, id, ""); err != nil {
		return runtime.Sandbox{}, fmt.Errorf("stop sandbox runtime: %w", err)
	}
	return p.transition(ctx, id, "stop")
}

func (p *Provider) transition(ctx context.Context, id, action string) (runtime.Sandbox, error) {
	current, err := p.Get(ctx, id)
	if err != nil {
		return runtime.Sandbox{}, err
	}
	if (action == "start" && (current.State == runtime.ProviderRunning || current.State == runtime.ProviderStarting)) ||
		(action == "stop" && current.State == runtime.ProviderStopped) {
		return current, nil
	}
	path := "/sandbox/" + url.PathEscape(id) + "/" + action
	status, err := p.callStatus(ctx, http.MethodPost, path, nil, nil, nil, nil)
	if err != nil && status != http.StatusConflict {
		return runtime.Sandbox{}, err
	}
	return p.Get(ctx, id)
}

// Delete destroys a sandbox and succeeds when it is already absent.
func (p *Provider) Delete(ctx context.Context, id string) error {
	err := p.call(ctx, http.MethodDelete, "/sandbox/"+url.PathEscape(id), url.Values{"force": {"true"}}, nil, nil, nil)
	if errors.Is(err, runtime.ErrSandboxNotFound) {
		return nil
	}
	return err
}

// List returns live sandboxes matching stable AO labels.
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
	result := make([]runtime.Sandbox, 0, len(payloads))
	for _, payload := range payloads {
		if !isDestroyed(payload.State) {
			result = append(result, toSandbox(payload))
		}
	}
	return result, nil
}

// bootstrap starts request.Command and Args exactly once for an idempotency
// key. Daytona's process endpoint accepts a shell command string, so every
// semantic argv element is POSIX-quoted and prefixed with exec.
func (p *Provider) bootstrap(ctx context.Context, providerID, runtimeID string, ref runtime.Ref, controlPlaneURL, command string, args []string, bootstrapKey string) (bool, error) {
	sessionID := bootstrapSessionPrefix + strings.TrimSpace(bootstrapKey)
	created, err := p.createProcessSession(ctx, providerID, sessionID)
	if err != nil || !created {
		return created, err
	}
	runtimeArgv := make([]string, 0, 15+len(args))
	runtimeArgv = append(runtimeArgv,
		runtime.SandboxRuntimeCommand,
		"--listen", "0.0.0.0:8080",
		"--control-plane-url", controlPlaneURL,
		"--sandbox-id", runtimeID,
		"--workspace-id", ref.WorkspaceID,
		"--session-id", ref.SessionID,
		"--workspace", runtime.SandboxWorkspacePath,
		"--ready-file", runtime.SandboxReadyFilePath,
		"--secret-dir", runtime.SandboxSecretDir,
		"--route-prefix", runtime.SandboxRoutePrefix,
		"--", command,
	)
	runtimeArgv = append(runtimeArgv, args...)
	command = "exec " + shellJoin(runtimeArgv)
	body := struct {
		Command  string `json:"command"`
		RunAsync bool   `json:"runAsync"`
	}{Command: command, RunAsync: true}
	path := "/toolbox/" + url.PathEscape(providerID) + "/toolbox/process/session/" + url.PathEscape(sessionID) + "/exec"
	if err := p.call(ctx, http.MethodPost, path, nil, nil, body, nil); err != nil {
		return false, fmt.Errorf("start sandbox command: %w", err)
	}
	return true, nil
}

func (p *Provider) createProcessSession(ctx context.Context, sandboxID, sessionID string) (bool, error) {
	path := "/toolbox/" + url.PathEscape(sandboxID) + "/toolbox/process/session"
	body := struct {
		SessionID string `json:"sessionId"`
	}{SessionID: sessionID}
	status, err := p.callStatus(ctx, http.MethodPost, path, nil, nil, body, nil)
	if status == http.StatusConflict {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("create sandbox process session: %w", err)
	}
	return true, nil
}

type processSession struct {
	SessionID string `json:"sessionId"`
}

// cleanupBootstrapSessions removes old AO runtime processes. keep is retained
// so a retry of the same fresh launch remains idempotent; earlier capability
// generations are terminated before the new runtime starts.
func (p *Provider) cleanupBootstrapSessions(ctx context.Context, sandboxID, keep string) error {
	base := "/toolbox/" + url.PathEscape(sandboxID) + "/toolbox/process/session"
	var sessions []processSession
	if err := p.call(ctx, http.MethodGet, base, nil, nil, nil, &sessions); err != nil {
		return err
	}
	for _, session := range sessions {
		id := strings.TrimSpace(session.SessionID)
		if !strings.HasPrefix(id, bootstrapSessionPrefix) || id == keep {
			continue
		}
		if err := p.call(ctx, http.MethodDelete, base+"/"+url.PathEscape(id), nil, nil, nil, nil); err != nil && !errors.Is(err, runtime.ErrSandboxNotFound) {
			return err
		}
	}
	return nil
}

func shellJoin(argv []string) string {
	quoted := make([]string, len(argv))
	for i, value := range argv {
		quoted[i] = "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
	}
	return strings.Join(quoted, " ")
}

func (p *Provider) deliverSecretFiles(ctx context.Context, id string, files []runtime.FileSecret) error {
	for _, file := range files {
		if err := p.uploadFile(ctx, id, file.Path, file.Content); err != nil {
			return fmt.Errorf("deliver secret file %s: %w", file.Path, err)
		}
		mode := file.Mode
		if mode == 0 {
			mode = 0o600
		}
		permissions := url.Values{"path": {file.Path}, "mode": {fmt.Sprintf("%04o", mode)}}
		path := "/toolbox/" + url.PathEscape(id) + "/toolbox/files/permissions"
		if err := p.call(ctx, http.MethodPost, path, permissions, nil, nil, nil); err != nil {
			return fmt.Errorf("restrict secret file %s: %w", file.Path, err)
		}
	}
	return nil
}

func (p *Provider) uploadFile(ctx context.Context, id, path string, content []byte) error {
	buffer := &bytes.Buffer{}
	defer func() {
		clear(buffer.Bytes())
		buffer.Reset()
	}()
	writer := multipart.NewWriter(buffer)
	part, err := writer.CreateFormFile("file", path)
	if err != nil {
		return err
	}
	if _, err := part.Write(content); err != nil {
		return err
	}
	if err := writer.Close(); err != nil {
		return err
	}
	target := p.baseURL + "/toolbox/" + url.PathEscape(id) + "/toolbox/files/upload?" + url.Values{"path": {path}}.Encode()
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
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("daytona secret upload responded %d", response.StatusCode)
	}
	return nil
}

func (p *Provider) call(ctx context.Context, method, path string, query url.Values, header http.Header, body, out any) error {
	_, err := p.callStatus(ctx, method, path, query, header, body, out)
	return err
}

func (p *Provider) callStatus(ctx context.Context, method, path string, query url.Values, header http.Header, body, out any) (int, error) {
	target := p.baseURL + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return 0, err
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return 0, err
	}
	p.applyHeaders(request)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	for name, values := range header {
		for _, value := range values {
			request.Header.Add(name, value)
		}
	}
	response, err := p.client.Do(request)
	if err != nil {
		return 0, fmt.Errorf("daytona %s %s: %w", method, path, err)
	}
	defer func() { _, _ = io.Copy(io.Discard, response.Body); _ = response.Body.Close() }()
	status := response.StatusCode
	if err := statusError(response); err != nil {
		return status, err
	}
	if out != nil {
		if err := json.NewDecoder(response.Body).Decode(out); err != nil {
			return status, fmt.Errorf("daytona %s %s: decode response: %w", method, path, err)
		}
	}
	return status, nil
}

func (p *Provider) applyHeaders(request *http.Request) {
	request.Header.Set("Authorization", "Bearer "+p.apiKey)
	request.Header.Set("Accept", "application/json")
	if p.orgID != "" {
		request.Header.Set("X-Daytona-Organization-ID", p.orgID)
	}
}

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
		ID:             payload.ID,
		State:          providerState(payload.State),
		Labels:         payload.Labels,
		CreatedAt:      parseTime(payload.CreatedAt),
		LastActivityAt: parseTime(payload.LastActivityAt),
		Error:          payload.ErrorReason,
	}
}

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
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.999Z0700"} {
		if parsed, err := time.Parse(layout, strings.TrimSpace(value)); err == nil {
			return parsed.UTC()
		}
	}
	return time.Time{}
}

func minutes(duration time.Duration) *int {
	if duration <= 0 {
		return nil
	}
	value := int(math.Ceil(duration.Minutes()))
	return &value
}
