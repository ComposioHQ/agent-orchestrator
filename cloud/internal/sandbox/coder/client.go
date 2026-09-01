// Package coder implements AO's provider-neutral sandbox lifecycle against a
// customer-operated Coder deployment. It uses only Coder's authenticated HTTP
// and workspace-agent PTY APIs; AO never needs the customer's cloud account.
package coder

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/cloud/internal/domain"
	"github.com/aoagents/agent-orchestrator/cloud/internal/sandbox"
	"github.com/coder/websocket"
	"github.com/google/uuid"
)

const (
	defaultTimeout      = 2 * time.Minute
	maxResponseBody     = 4 << 20
	maxErrorBody        = 64 << 10
	maxPTYOutput        = 1 << 20
	workspaceNamePrefix = "ao-"
	bootstrapOK         = "__AO_BOOTSTRAP_OK__"
	bootstrapFailed     = "__AO_BOOTSTRAP_FAILED__"
	bootstrapUploadACK  = "__AO_UPLOAD_ACK__"
	bootstrapUploadDone = "__AO_UPLOAD_DONE__"
)

var userPattern = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)

// Config describes one Coder deployment and the template AO is allowed to use.
type Config struct {
	BaseURL    string
	Token      string
	Owner      string
	TemplateID string
	AgentName  string
	Parameters map[string]string
	HTTPClient *http.Client
}

// Client manages AO-owned workspaces through one dedicated Coder user.
type Client struct {
	baseURL    string
	token      string
	owner      string
	templateID string
	agentName  string
	parameters map[string]string
	http       *http.Client
}

var (
	_ sandbox.Provider         = (*Client)(nil)
	_ sandbox.Bootstrapper     = (*Client)(nil)
	_ sandbox.DeadlineExtender = (*Client)(nil)
)

// New creates a fail-closed Coder provider client.
func New(config Config) (*Client, error) {
	endpoint, err := url.Parse(strings.TrimSpace(config.BaseURL))
	if err != nil || endpoint.Host == "" || endpoint.User != nil ||
		(endpoint.Scheme != "http" && endpoint.Scheme != "https") ||
		(endpoint.Path != "" && endpoint.Path != "/") || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return nil, errors.New("coder: base URL must be an absolute http or https origin")
	}
	if strings.TrimSpace(config.Token) == "" {
		return nil, errors.New("coder: API token is required")
	}
	if strings.TrimSpace(config.Owner) == "" {
		return nil, errors.New("coder: workspace owner is required")
	}
	if _, err := uuid.Parse(strings.TrimSpace(config.TemplateID)); err != nil {
		return nil, errors.New("coder: template ID must be a UUID")
	}
	httpClient := config.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: defaultTimeout}
	}
	parameters := make(map[string]string, len(config.Parameters))
	for name, value := range config.Parameters {
		name = strings.TrimSpace(name)
		if name == "" {
			return nil, errors.New("coder: template parameter name must not be empty")
		}
		parameters[name] = value
	}
	return &Client{
		baseURL:    strings.TrimRight(endpoint.String(), "/"),
		token:      strings.TrimSpace(config.Token),
		owner:      strings.TrimSpace(config.Owner),
		templateID: strings.TrimSpace(config.TemplateID),
		agentName:  strings.TrimSpace(config.AgentName),
		parameters: parameters,
		http:       httpClient,
	}, nil
}

type workspace struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	OwnerName   string          `json:"owner_name"`
	TemplateID  string          `json:"template_id"`
	LatestBuild workspaceBuild  `json:"latest_build"`
	Health      workspaceHealth `json:"health"`
}

type workspaceHealth struct {
	Healthy bool `json:"healthy"`
}

type workspaceBuild struct {
	Status    string              `json:"status"`
	Reason    string              `json:"reason"`
	Deadline  *time.Time          `json:"deadline"`
	Resources []workspaceResource `json:"resources"`
}

type workspaceResource struct {
	Agents []workspaceAgent `json:"agents"`
}

type workspaceAgent struct {
	ID             string          `json:"id"`
	Name           string          `json:"name"`
	Status         string          `json:"status"`
	LifecycleState string          `json:"lifecycle_state"`
	Health         workspaceHealth `json:"health"`
}

type buildParameter struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type createWorkspaceRequest struct {
	TemplateID          string           `json:"template_id"`
	Name                string           `json:"name"`
	RichParameterValues []buildParameter `json:"rich_parameter_values,omitempty"`
	AutomaticUpdates    string           `json:"automatic_updates"`
}

// WorkspaceName is the stable Coder workspace name for one AO session.
func WorkspaceName(sessionID string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(sessionID)))
	return workspaceNamePrefix + hex.EncodeToString(sum[:])[:24]
}

// Create provisions a Coder workspace from the configured template.
func (c *Client) Create(ctx context.Context, spec sandbox.Spec) (sandbox.Environment, error) {
	name := strings.TrimSpace(spec.Name)
	if spec.SessionID != "" {
		name = WorkspaceName(spec.SessionID)
	}
	if name == "" {
		return sandbox.Environment{}, errors.New("coder: workspace name is required")
	}
	parameterNames := make([]string, 0, len(c.parameters))
	for parameterName := range c.parameters {
		parameterNames = append(parameterNames, parameterName)
	}
	sort.Strings(parameterNames)
	parameters := make([]buildParameter, 0, len(parameterNames))
	for _, parameterName := range parameterNames {
		parameters = append(parameters, buildParameter{Name: parameterName, Value: c.parameters[parameterName]})
	}
	body := createWorkspaceRequest{
		TemplateID: c.templateID, Name: name,
		RichParameterValues: parameters, AutomaticUpdates: "never",
	}
	var view workspace
	if err := c.do(ctx, http.MethodPost, "/api/v2/users/"+url.PathEscape(c.owner)+"/workspaces", body, &view); err != nil {
		return sandbox.Environment{}, err
	}
	return c.toEnvironment(view), nil
}

// Get returns the current provider view of one Coder workspace.
func (c *Client) Get(ctx context.Context, id sandbox.ID) (sandbox.Environment, error) {
	var view workspace
	if err := c.do(ctx, http.MethodGet, "/api/v2/workspaces/"+url.PathEscape(string(id)), nil, &view); err != nil {
		return sandbox.Environment{}, err
	}
	return c.toEnvironment(view), nil
}

// FindBySession recovers a workspace after a control-plane crash between
// provider creation and persistence of the returned Coder workspace ID.
func (c *Client) FindBySession(ctx context.Context, sessionID string) (sandbox.Environment, bool, error) {
	var view workspace
	requestPath := "/api/v2/users/" + url.PathEscape(c.owner) + "/workspace/" +
		url.PathEscape(WorkspaceName(sessionID))
	err := c.do(ctx, http.MethodGet, requestPath, nil, &view)
	if errors.Is(err, sandbox.ErrNotFound) {
		return sandbox.Environment{}, false, nil
	}
	if err != nil {
		return sandbox.Environment{}, false, err
	}
	if normalizeState(view.LatestBuild.Status) == sandbox.StateDeleted {
		return sandbox.Environment{}, false, nil
	}
	return c.toEnvironment(view), true, nil
}

func (c *Client) Start(ctx context.Context, id sandbox.ID) error {
	return c.transition(ctx, id, "start")
}

func (c *Client) Stop(ctx context.Context, id sandbox.ID) error {
	return c.transition(ctx, id, "stop")
}

func (c *Client) Pause(ctx context.Context, id sandbox.ID) error {
	return c.Stop(ctx, id)
}

func (c *Client) Resume(ctx context.Context, id sandbox.ID) error {
	return c.Start(ctx, id)
}

// ExtendDeadline keeps a Coder workspace alive while AO has durable active
// work or recent user interaction. Coder applies template maximum-runtime
// policy to this request.
func (c *Client) ExtendDeadline(ctx context.Context, id sandbox.ID, deadline time.Time) error {
	return c.do(ctx, http.MethodPut,
		"/api/v2/workspaces/"+url.PathEscape(string(id))+"/extend",
		struct {
			Deadline time.Time `json:"deadline"`
		}{Deadline: deadline.UTC()}, nil)
}

func (c *Client) Delete(ctx context.Context, id sandbox.ID) error {
	err := c.transition(ctx, id, "delete")
	if errors.Is(err, sandbox.ErrNotFound) {
		return nil
	}
	return err
}

func (c *Client) transition(ctx context.Context, id sandbox.ID, transition string) error {
	return c.do(ctx, http.MethodPost, "/api/v2/workspaces/"+url.PathEscape(string(id))+"/builds",
		map[string]string{"transition": transition}, nil)
}

func (c *Client) toEnvironment(view workspace) sandbox.Environment {
	agent, _ := c.selectAgent(view)
	state := normalizeState(view.LatestBuild.Status)
	if state == sandbox.StateRunning &&
		(agent.ID == "" || agent.Status != "connected" || agent.LifecycleState != "ready" ||
			!agent.Health.Healthy || !view.Health.Healthy) {
		state = sandbox.StateProvisioning
	}
	environment := sandbox.Environment{
		ID: sandbox.ID(view.ID), Name: view.Name, State: state, Target: agent.ID,
		Resource: domain.ResourceProfile{}, Deadline: view.LatestBuild.Deadline,
	}
	if state == sandbox.StateStopped {
		switch strings.ToLower(strings.TrimSpace(view.LatestBuild.Reason)) {
		case "autostop", "dormancy":
			environment.StopCause = sandbox.StopCauseExternalIdle
		}
	}
	return environment
}

func normalizeState(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "running":
		return sandbox.StateRunning
	case "stopped":
		return sandbox.StateStopped
	case "deleting":
		return sandbox.StateDeleting
	case "deleted":
		return sandbox.StateDeleted
	default:
		return sandbox.StateProvisioning
	}
}

func (c *Client) selectAgent(view workspace) (workspaceAgent, bool) {
	for _, resource := range view.LatestBuild.Resources {
		for _, agent := range resource.Agents {
			if c.agentName == "" || agent.Name == c.agentName {
				return agent, true
			}
		}
	}
	return workspaceAgent{}, false
}

// BootstrapWorker installs and starts AO through the Coder agent PTY. The
// bootstrap archive travels as terminal input, so worker credentials never
// appear in the Coder request URL, process arguments, or control-plane logs.
func (c *Client) BootstrapWorker(ctx context.Context, id sandbox.ID, bootstrap sandbox.WorkerBootstrap) error {
	if err := validateBootstrap(bootstrap); err != nil {
		return err
	}
	var view workspace
	if err := c.do(ctx, http.MethodGet, "/api/v2/workspaces/"+url.PathEscape(string(id)), nil, &view); err != nil {
		return err
	}
	agent, ok := c.selectAgent(view)
	if !ok || agent.ID == "" || agent.Status != "connected" || !agent.Health.Healthy {
		return errors.New("coder: workspace agent is not connected and healthy")
	}
	payload, err := bootstrapArchive(bootstrap)
	if err != nil {
		return err
	}
	encoded := base64.StdEncoding.EncodeToString(payload)
	command := bootstrapCommand(bootstrap, len(encoded))
	ptyURL, err := url.Parse(c.baseURL + "/api/v2/workspaceagents/" + url.PathEscape(agent.ID) + "/pty")
	if err != nil {
		return fmt.Errorf("coder: build PTY URL: %w", err)
	}
	query := ptyURL.Query()
	query.Set("width", "120")
	query.Set("height", "40")
	query.Set("command", command)
	// Bootstrap is a short-lived, non-interactive command. The buffered backend
	// lets the command finish after AO disconnects once the upload is accepted.
	query.Set("backend_type", "buffered")
	ptyURL.RawQuery = query.Encode()
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if err := c.bootstrapThroughPTY(ctx, ptyURL, encoded); err == nil {
			return nil
		} else {
			lastErr = err
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
	}
	return fmt.Errorf("coder: bootstrap worker after PTY retries: %w", lastErr)
}

func (c *Client) bootstrapThroughPTY(ctx context.Context, ptyURL *url.URL, encoded string) error {
	attemptURL := *ptyURL
	query := attemptURL.Query()
	query.Set("reconnect", uuid.NewString())
	attemptURL.RawQuery = query.Encode()

	headers := http.Header{"Coder-Session-Token": []string{c.token}}
	conn, response, err := websocket.Dial(ctx, attemptURL.String(), &websocket.DialOptions{
		HTTPClient: c.http, HTTPHeader: headers,
	})
	if err != nil {
		if response != nil {
			defer response.Body.Close()
			snippet, _ := io.ReadAll(io.LimitReader(response.Body, maxErrorBody))
			return fmt.Errorf("coder: open workspace PTY returned %d: %s", response.StatusCode,
				strings.TrimSpace(string(snippet)))
		}
		return fmt.Errorf("coder: open workspace PTY: %w", err)
	}
	defer conn.CloseNow()
	netConn := websocket.NetConn(context.Background(), conn, websocket.MessageBinary)
	defer netConn.Close()

	encoder := json.NewEncoder(netConn)
	output := streamPTYOutput(netConn)
	// Coder's reconnecting PTY writes each decoded Data field to the OS PTY but
	// does not retry a short write. Frame the archive as canonical terminal lines
	// with sequence and length metadata. The receiver acknowledges only a
	// complete frame for the expected sequence; retrying an unacknowledged frame
	// makes Coder's unreported short writes recoverable without tripling the
	// shell work and exceeding the reconnecting-PTY lifetime.
	const chunkSize = 3_000 // below the canonical terminal's 4 KiB line ceiling
	sequence := 0
	for offset := 0; offset < len(encoded); offset += chunkSize {
		end := min(offset+chunkSize, len(encoded))
		chunk := encoded[offset:end]
		line := fmt.Sprintf("data:%d:%d:%s\n", sequence, len(chunk), chunk)
		wanted := fmt.Sprintf("%s:%d", bootstrapUploadACK, sequence+1)
		if err := sendBootstrapFrame(ctx, encoder, output, line, wanted); err != nil {
			return err
		}
		sequence++
	}
	return sendBootstrapFrame(ctx, encoder, output,
		fmt.Sprintf("done:%d:0:\n", sequence), bootstrapUploadDone)
}

func sendBootstrapFrame(
	ctx context.Context,
	encoder *json.Encoder,
	output <-chan ptyOutput,
	line string,
	wanted string,
) error {
	const (
		maxAttempts = 6
		ackTimeout  = 2 * time.Second
	)
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if err := encoder.Encode(struct {
			Data string `json:"data"`
		}{Data: line}); err != nil {
			return fmt.Errorf("coder: upload worker through PTY: %w", err)
		}
		timer := time.NewTimer(ackTimeout)
		for {
			select {
			case <-ctx.Done():
				timer.Stop()
				return ctx.Err()
			case <-timer.C:
				goto retry
			case response, ok := <-output:
				if !ok {
					timer.Stop()
					return errors.New("coder: workspace PTY closed during worker upload")
				}
				if strings.Contains(response.data, wanted) {
					timer.Stop()
					return nil
				}
				if strings.Contains(response.data, bootstrapFailed) {
					timer.Stop()
					return fmt.Errorf("coder: worker bootstrap failed during upload: %s", sanitizePTYOutput(response.data))
				}
				if response.err != nil {
					timer.Stop()
					return fmt.Errorf("coder: read workspace PTY upload acknowledgement: %w", response.err)
				}
			}
		}
	retry:
	}
	return errors.New("coder: workspace PTY repeatedly dropped an upload frame")
}

func validateBootstrap(bootstrap sandbox.WorkerBootstrap) error {
	if len(bootstrap.Binary) == 0 {
		return errors.New("coder: worker binary is empty")
	}
	if !safeAbsolutePath(bootstrap.Destination) {
		return fmt.Errorf("coder: worker destination %q must be a safe absolute path", bootstrap.Destination)
	}
	if len(bootstrap.HelperBinary) > 0 && !safeAbsolutePath(bootstrap.HelperDestination) {
		return fmt.Errorf("coder: helper destination %q must be a safe absolute path", bootstrap.HelperDestination)
	}
	if !userPattern.MatchString(strings.TrimSpace(bootstrap.User)) {
		return fmt.Errorf("coder: worker user %q is invalid", bootstrap.User)
	}
	for key := range bootstrap.Environment {
		if !regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`).MatchString(key) {
			return fmt.Errorf("coder: environment key %q is invalid", key)
		}
	}
	return nil
}

func safeAbsolutePath(value string) bool {
	value = strings.TrimSpace(value)
	return strings.HasPrefix(value, "/") && path.Clean(value) == value && !strings.ContainsAny(value, "\x00\r\n")
}

func bootstrapArchive(bootstrap sandbox.WorkerBootstrap) ([]byte, error) {
	var compressed bytes.Buffer
	gzipWriter := gzip.NewWriter(&compressed)
	tarWriter := tar.NewWriter(gzipWriter)
	files := []struct {
		name string
		mode int64
		data []byte
	}{
		{name: "ao-worker", mode: 0o700, data: bootstrap.Binary},
		{name: "worker.env", mode: 0o600, data: []byte(environmentFile(bootstrap.Environment))},
		{name: "launch.sh", mode: 0o700, data: []byte("#!/bin/sh\nset -eu\nset -a\n. \"$1\"\nset +a\nrm -f \"$1\"\nexec \"$2\"\n")},
	}
	if len(bootstrap.HelperBinary) > 0 {
		files = append(files, struct {
			name string
			mode int64
			data []byte
		}{name: "ao", mode: 0o700, data: bootstrap.HelperBinary})
	}
	for _, file := range files {
		if err := tarWriter.WriteHeader(&tar.Header{Name: file.name, Mode: file.mode, Size: int64(len(file.data))}); err != nil {
			return nil, fmt.Errorf("coder: build worker archive: %w", err)
		}
		if _, err := tarWriter.Write(file.data); err != nil {
			return nil, fmt.Errorf("coder: build worker archive: %w", err)
		}
	}
	if err := tarWriter.Close(); err != nil {
		return nil, fmt.Errorf("coder: close worker archive: %w", err)
	}
	if err := gzipWriter.Close(); err != nil {
		return nil, fmt.Errorf("coder: compress worker archive: %w", err)
	}
	return compressed.Bytes(), nil
}

func environmentFile(environment map[string]string) string {
	keys := make([]string, 0, len(environment))
	for key := range environment {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var content strings.Builder
	for _, key := range keys {
		content.WriteString(key)
		content.WriteByte('=')
		content.WriteString(shellQuote(environment[key]))
		content.WriteByte('\n')
	}
	return content.String()
}

func bootstrapCommand(bootstrap sandbox.WorkerBootstrap, encodedLength int) string {
	workerUser := strings.TrimSpace(bootstrap.User)
	workerDestination := strings.TrimSpace(bootstrap.Destination)
	helperInstall := ""
	if len(bootstrap.HelperBinary) > 0 {
		helperInstall = "sudo -n install -m 0755 \"$stage/ao\" " + shellQuote(bootstrap.HelperDestination) + "\n"
	}
	script := "set -eu\n" +
		"stage=$(mktemp -d)\nencoded=\"$stage/payload.b64\"\n" +
		"trap 'code=$?; stty echo icanon 2>/dev/null || true; echo " + bootstrapFailed + ":$code' EXIT\n" +
		"target=" + strconv.Itoa(encodedLength) + "\nexpected=0\nreceived=0\n: >\"$encoded\"\nstty -echo icanon\n" +
		"while IFS=: read -r kind sequence declared chunk; do\n" +
		"  case \"$sequence\" in ''|*[!0-9]*) continue ;; esac\n" +
		"  case \"$declared\" in ''|*[!0-9]*) continue ;; esac\n" +
		"  if [ \"$kind\" = data ] && [ \"$sequence\" -eq \"$expected\" ] && [ \"${#chunk}\" -eq \"$declared\" ] && [ $((received + declared)) -le \"$target\" ]; then\n" +
		"    printf %s \"$chunk\" >>\"$encoded\"\n    received=$((received + declared))\n    expected=$((expected + 1))\n    echo " + bootstrapUploadACK + ":$expected\n" +
		"  elif [ \"$kind\" = done ] && [ \"$received\" -eq \"$target\" ]; then\n    echo " + bootstrapUploadDone + "\n    break\n  fi\ndone\nstty echo icanon\n" +
		"base64 -d \"$encoded\" | gzip -d | tar -xf - -C \"$stage\"\n" +
		"sudo -n id -u " + shellQuote(workerUser) + " >/dev/null 2>&1 || sudo -n useradd -m " + shellQuote(workerUser) + "\n" +
		"sudo -n mkdir -p /workspace/repository /workspace/.ao/worker /workspace/.ao/harness /workspace/.ao/repository-credentials\n" +
		"sudo -n chown -R " + shellQuote(workerUser+":"+workerUser) + " /workspace\n" +
		"sudo -n install -m 0755 \"$stage/ao-worker\" " + shellQuote(workerDestination) + "\n" + helperInstall +
		"sudo -n install -o " + shellQuote(workerUser) + " -g " + shellQuote(workerUser) + " -m 0600 \"$stage/worker.env\" /workspace/.ao/worker/worker.env\n" +
		"sudo -n install -o " + shellQuote(workerUser) + " -g " + shellQuote(workerUser) + " -m 0700 \"$stage/launch.sh\" /workspace/.ao/worker/launch.sh\n" +
		"sudo -n pkill -u " + shellQuote(workerUser) + " -f " + shellQuote(workerDestination) + " 2>/dev/null || true\n" +
		"sudo -n -u " + shellQuote(workerUser) + " sh -c " + shellQuote("nohup /workspace/.ao/worker/launch.sh /workspace/.ao/worker/worker.env "+shellQuote(workerDestination)+" >/workspace/.ao/worker/worker.log 2>&1 </dev/null &") + "\n" +
		"rm -rf \"$stage\"\ntrap - EXIT\necho " + bootstrapOK + "\n"
	return "sh -lc " + shellQuote(script)
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

type ptyOutput struct {
	data string
	err  error
}

func streamPTYOutput(reader io.Reader) <-chan ptyOutput {
	result := make(chan ptyOutput)
	go func() {
		defer close(result)
		buffered := bufio.NewReader(reader)
		total := 0
		for total < maxPTYOutput {
			line, err := buffered.ReadString('\n')
			total += len(line)
			if line != "" || err != nil {
				result <- ptyOutput{data: line, err: err}
			}
			if err != nil {
				return
			}
		}
		result <- ptyOutput{err: errors.New("coder: PTY output exceeded limit")}
	}()
	return result
}

func readBootstrapResult(ctx context.Context, output <-chan ptyOutput) (string, error) {
	var result strings.Builder
	for {
		select {
		case <-ctx.Done():
			return result.String(), ctx.Err()
		case value, ok := <-output:
			if !ok {
				return result.String(), io.EOF
			}
			result.WriteString(value.data)
			text := result.String()
			if strings.Contains(text, bootstrapOK) || strings.Contains(text, bootstrapFailed) {
				return text, nil
			}
			if value.err != nil {
				return text, fmt.Errorf("coder: read workspace PTY: %w", value.err)
			}
		}
	}
}

func sanitizePTYOutput(output string) string {
	output = strings.Map(func(character rune) rune {
		if character == '\n' || character == '\t' || character >= ' ' {
			return character
		}
		return -1
	}, output)
	if len(output) > 1024 {
		output = output[len(output)-1024:]
	}
	return strings.TrimSpace(output)
}

func (c *Client) do(ctx context.Context, method, requestPath string, body, output any) error {
	var requestBody io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("coder: encode request: %w", err)
		}
		requestBody = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+requestPath, requestBody)
	if err != nil {
		return fmt.Errorf("coder: create request: %w", err)
	}
	request.Header.Set("Coder-Session-Token", c.token)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.http.Do(request)
	if err != nil {
		return fmt.Errorf("coder: %s %s: %w", method, requestPath, err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound || response.StatusCode == http.StatusGone {
		return sandbox.ErrNotFound
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		snippet, _ := io.ReadAll(io.LimitReader(response.Body, maxErrorBody))
		return fmt.Errorf("coder: API returned %d: %s", response.StatusCode, strings.TrimSpace(string(snippet)))
	}
	if output == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxResponseBody))
		return nil
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, maxResponseBody)).Decode(output); err != nil {
		return fmt.Errorf("coder: decode API response: %w", err)
	}
	return nil
}
