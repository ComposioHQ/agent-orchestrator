// Package createos implements AO's provider-neutral sandbox lifecycle against
// the NodeOps CreateOS Sandbox API — Firecracker micro-VMs created from a
// shape and a rootfs. No CreateOS type escapes this package.
package createos

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
	"github.com/Untrivial-ai/ao-cloud/internal/sandbox"
)

const (
	// defaultTimeout bounds a single control-plane call. Creation waits are
	// handled by the reconciler's retry loop, not by a long HTTP request.
	defaultTimeout = 2 * time.Minute
	// maxResponseBody bounds decoding so a hostile or broken response cannot
	// exhaust control-plane memory.
	maxResponseBody = 1 << 20
	// maxErrorBody bounds the error text retained on a failed call.
	maxErrorBody = 64 << 10
	// listPageLimit is the page size requested when scanning sandboxes.
	listPageLimit = 100
	// maxListPages bounds pagination so a broken cursor cannot loop forever.
	maxListPages = 50
	// deletePollInterval paces the wait for an accepted delete to finish.
	deletePollInterval = 2 * time.Second
	// deletePollTimeout bounds that wait. Giving up is not fatal on its own:
	// the reconciler retries the whole recreate on a later tick.
	deletePollTimeout = 2 * time.Minute
)

// HTTPError is a non-2xx response from the CreateOS API. The body is truncated
// and never contains the API key, which is only ever sent as a header.
type HTTPError struct {
	StatusCode int
	Body       string
}

func (e *HTTPError) Error() string {
	if e.Body == "" {
		return fmt.Sprintf("createos api returned %d", e.StatusCode)
	}
	return fmt.Sprintf("createos api returned %d: %s", e.StatusCode, e.Body)
}

// Client talks to one CreateOS control plane with one API key.
type Client struct {
	baseURL      string
	apiKey       string
	defaultShape string
	defaultRoot  string
	region       string
	sshPubKeys   []string
	http         *http.Client
	// deletePoll is how long Recreate waits between checks that a deleted
	// sandbox has actually gone away. A field rather than a constant so tests
	// can drive the poll loop without sleeping.
	deletePoll time.Duration
}

var (
	_ sandbox.Provider     = (*Client)(nil)
	_ sandbox.Recreator    = (*Client)(nil)
	_ sandbox.Bootstrapper = (*Client)(nil)
)

// Config configures a CreateOS client.
type Config struct {
	BaseURL      string
	APIKey       string
	DefaultShape string
	DefaultRoot  string
	Region       string
	SSHPubKeys   []string
	HTTPClient   *http.Client
}

// New creates a CreateOS sandbox provider.
func New(config Config) *Client {
	httpClient := config.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: defaultTimeout}
	}
	return &Client{
		baseURL:      strings.TrimRight(strings.TrimSpace(config.BaseURL), "/"),
		apiKey:       strings.TrimSpace(config.APIKey),
		defaultShape: strings.TrimSpace(config.DefaultShape),
		defaultRoot:  strings.TrimSpace(config.DefaultRoot),
		region:       strings.TrimSpace(config.Region),
		sshPubKeys:   append([]string(nil), config.SSHPubKeys...),
		http:         httpClient,
		deletePoll:   deletePollInterval,
	}
}

// sandboxView is the CreateOS projection of one sandbox.
type sandboxView struct {
	ID             string `json:"id"`
	Status         string `json:"status"`
	Name           string `json:"name"`
	Shape          string `json:"shape"`
	RootFS         string `json:"rootfs"`
	Region         string `json:"region"`
	VCPU           int    `json:"vcpu"`
	MemMiB         int    `json:"mem_mib"`
	DiskMiB        int    `json:"disk_mib"`
	IngressEnabled bool   `json:"ingress_enabled"`
}

type createSandboxRequest struct {
	Shape          string            `json:"shape"`
	RootFS         string            `json:"rootfs,omitempty"`
	Name           string            `json:"name,omitempty"`
	Envs           map[string]string `json:"envs,omitempty"`
	SSHPubKeys     []string          `json:"ssh_pubkeys,omitempty"`
	Region         string            `json:"region,omitempty"`
	IngressEnabled bool              `json:"ingress_enabled,omitempty"`
}

// Create provisions one sandbox for a session.
func (c *Client) Create(ctx context.Context, spec sandbox.Spec) (sandbox.Environment, error) {
	shape := firstNonEmpty(spec.Shape, c.defaultShape)
	if shape == "" {
		return sandbox.Environment{}, errors.New("createos: no shape configured for this sandbox")
	}
	body := createSandboxRequest{
		Shape:          shape,
		RootFS:         firstNonEmpty(spec.RootFS, c.defaultRoot),
		Name:           spec.Name,
		Envs:           spec.Environment,
		SSHPubKeys:     c.sshPubKeys,
		Region:         c.region,
		IngressEnabled: strings.EqualFold(strings.TrimSpace(spec.Ingress), "enabled"),
	}
	var view sandboxView
	if err := c.do(ctx, http.MethodPost, "/v1/sandboxes", body, &view); err != nil {
		return sandbox.Environment{}, err
	}
	return toEnvironment(view), nil
}

// Get returns the current provider view of one sandbox.
func (c *Client) Get(ctx context.Context, id sandbox.ID) (sandbox.Environment, error) {
	var view sandboxView
	if err := c.do(ctx, http.MethodGet, "/v1/sandboxes/"+url.PathEscape(string(id)), nil, &view); err != nil {
		return sandbox.Environment{}, err
	}
	return toEnvironment(view), nil
}

// FindBySession looks up the sandbox belonging to a session. CreateOS sandboxes
// carry no user metadata, so the correlation key is the name AO assigns at
// create time, which the API keeps unique per account.
func (c *Client) FindBySession(ctx context.Context, sessionID string) (sandbox.Environment, bool, error) {
	wanted := SandboxName(sessionID)
	offset := 0
	for page := 0; page < maxListPages; page++ {
		path := "/v1/sandboxes?limit=" + strconv.Itoa(listPageLimit) +
			"&offset=" + strconv.Itoa(offset)
		var response listResponse
		if err := c.do(ctx, http.MethodGet, path, nil, &response); err != nil {
			return sandbox.Environment{}, false, err
		}
		items := response.items()
		for _, view := range items {
			if view.Name != wanted {
				continue
			}
			// A destroyed row is history, not a live environment to adopt.
			if normalizeState(view.Status) == sandbox.StateDeleted {
				continue
			}
			return toEnvironment(view), true, nil
		}
		if len(items) == 0 || response.exhausted(offset, len(items)) {
			break
		}
		offset += len(items)
	}
	return sandbox.Environment{}, false, nil
}

// Start resumes a paused sandbox. CreateOS has no separate stopped state.
func (c *Client) Start(ctx context.Context, id sandbox.ID) error {
	return c.Resume(ctx, id)
}

// Stop pauses a sandbox, which stops compute billing.
func (c *Client) Stop(ctx context.Context, id sandbox.ID) error {
	return c.Pause(ctx, id)
}

// Pause snapshots memory and disk, then suspends the VM.
func (c *Client) Pause(ctx context.Context, id sandbox.ID) error {
	return c.do(ctx, http.MethodPost, "/v1/sandboxes/"+url.PathEscape(string(id))+"/pause", nil, nil)
}

// Resume restores a paused sandbox in place — same id, same filesystem, same
// memory — so a worker suspended by idle auto-pause picks up where it left off.
func (c *Client) Resume(ctx context.Context, id sandbox.ID) error {
	return c.do(ctx, http.MethodPost, "/v1/sandboxes/"+url.PathEscape(string(id))+"/resume", nil, nil)
}

// Delete reclaims a sandbox.
func (c *Client) Delete(ctx context.Context, id sandbox.ID) error {
	err := c.do(ctx, http.MethodDelete, "/v1/sandboxes/"+url.PathEscape(string(id)), nil, nil)
	if errors.Is(err, sandbox.ErrNotFound) {
		return nil
	}
	return err
}

// Recreate replaces a sandbox with fresh compute. CreateOS names are unique per
// account, so the old sandbox must be gone before the replacement can take its
// name. No disk is attached in this configuration, so the replacement starts
// from a clean workspace and uncommitted work is lost.
func (c *Client) Recreate(
	ctx context.Context,
	id sandbox.ID,
	spec sandbox.Spec,
) (sandbox.Environment, error) {
	if err := c.Delete(ctx, id); err != nil {
		return sandbox.Environment{}, err
	}
	if err := c.awaitDeleted(ctx, id); err != nil {
		return sandbox.Environment{}, err
	}
	return c.Create(ctx, spec)
}

// awaitDeleted blocks until a deleted sandbox is really gone. CreateOS accepts
// a DELETE and returns immediately, leaving the VM in destroying until it
// reaches destroyed; creating the replacement before then collides with a name
// the API still considers taken, which fails the recreate and leaves the next
// tick to repeat the same collision.
func (c *Client) awaitDeleted(ctx context.Context, id sandbox.ID) error {
	deadline := time.Now().Add(deletePollTimeout)
	for {
		environment, err := c.Get(ctx, id)
		switch {
		case errors.Is(err, sandbox.ErrNotFound):
			return nil
		case err != nil:
			return err
		case environment.State == sandbox.StateDeleted:
			return nil
		}
		if !time.Now().Before(deadline) {
			return fmt.Errorf(
				"createos: sandbox %s was still %s %s after its delete was accepted",
				id,
				environment.State,
				deletePollTimeout,
			)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(c.deletePoll):
		}
	}
}

type execRequest struct {
	Cmd  string   `json:"cmd"`
	Args []string `json:"args,omitempty"`
}

type execResponse struct {
	Result struct {
		Stdout   string `json:"stdout"`
		Stderr   string `json:"stderr"`
		ExitCode int    `json:"exit_code"`
		Error    string `json:"error"`
	} `json:"result"`
}

// BootstrapWorker uploads the AO worker into a live sandbox and launches it.
// Using exec instead of a baked-in entrypoint keeps the rootfs generic and lets
// the reconciler repair a sandbox without replacing its compute.
func (c *Client) BootstrapWorker(
	ctx context.Context,
	id sandbox.ID,
	bootstrap sandbox.WorkerBootstrap,
) error {
	destination := strings.TrimSpace(bootstrap.Destination)
	if destination == "" || !strings.HasPrefix(destination, "/") {
		return fmt.Errorf("createos: worker destination %q must be an absolute path", bootstrap.Destination)
	}
	if len(bootstrap.Binary) == 0 {
		return errors.New("createos: worker binary is empty")
	}

	// Guest paths must be absolute and their parents must already exist.
	if _, slash := path(destination); slash != "" {
		if err := c.exec(ctx, id, "mkdir", []string{"-p", slash}); err != nil {
			return err
		}
	}

	// On the repair path the previous worker is usually still running — a
	// partitioned worker only exits after its heartbeats fail — and Linux
	// refuses to write a running executable with ETXTBSY. Staging the upload
	// beside the destination and renaming over it swaps the directory entry
	// instead, which the kernel allows while the old inode is still mapped.
	staging := destination + ".new"
	if err := c.uploadFile(ctx, id, staging, bootstrap.Binary); err != nil {
		return err
	}
	if err := c.exec(ctx, id, "chmod", []string{"0755", staging}); err != nil {
		return err
	}
	// Stop the old worker before the swap so a repaired sandbox does not end up
	// with two processes heartbeating under the same identity. pkill exits 1
	// when nothing matches, which is the normal first-bootstrap case.
	stop := "pkill -f " + shellQuote(destination) + " || true"
	if err := c.exec(ctx, id, "bash", []string{"-c", stop}); err != nil {
		return err
	}
	if err := c.exec(ctx, id, "mv", []string{"-f", staging, destination}); err != nil {
		return err
	}

	// Repair issues a new one-time bootstrap ticket. Pass the complete fresh
	// environment to this process instead of relying on the environment stored
	// at sandbox creation, which contains a consumed ticket.
	keys := make([]string, 0, len(bootstrap.Environment))
	for key := range bootstrap.Environment {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	assignments := make([]string, 0, len(keys))
	for _, key := range keys {
		assignments = append(assignments, shellQuote(key+"="+bootstrap.Environment[key]))
	}
	launch := "nohup env"
	if len(assignments) > 0 {
		launch += " " + strings.Join(assignments, " ")
	}
	launch += " " + shellQuote(destination) + " >> /var/log/ao-worker.log 2>&1 &"
	return c.exec(ctx, id, "bash", []string{"-c", launch})
}

func (c *Client) exec(ctx context.Context, id sandbox.ID, cmd string, args []string) error {
	var response execResponse
	if err := c.do(
		ctx,
		http.MethodPost,
		"/v1/sandboxes/"+url.PathEscape(string(id))+"/exec",
		execRequest{Cmd: cmd, Args: args},
		&response,
	); err != nil {
		return err
	}
	if response.Result.Error != "" {
		return fmt.Errorf("createos: %s could not start: %s", cmd, response.Result.Error)
	}
	if response.Result.ExitCode != 0 {
		return fmt.Errorf(
			"createos: %s exited %d: %s",
			cmd,
			response.Result.ExitCode,
			truncate(strings.TrimSpace(response.Result.Stderr), 512),
		)
	}
	return nil
}

func (c *Client) uploadFile(ctx context.Context, id sandbox.ID, guestPath string, data []byte) error {
	target := c.baseURL + "/v1/sandboxes/" + url.PathEscape(string(id)) +
		"/files?path=" + url.QueryEscape(guestPath)
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, target, bytes.NewReader(data))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/octet-stream")
	request.Header.Set("X-Api-Key", c.apiKey)
	response, err := c.http.Do(request)
	if err != nil {
		return fmt.Errorf("createos: upload %s: %w", guestPath, err)
	}
	defer response.Body.Close()
	if err := statusError(response); err != nil {
		return err
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxResponseBody))
	return nil
}

func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("createos: encode %s request: %w", path, err)
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return err
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("X-Api-Key", c.apiKey)

	response, err := c.http.Do(request)
	if err != nil {
		return fmt.Errorf("createos: %s %s: %w", method, path, err)
	}
	defer response.Body.Close()

	if err := statusError(response); err != nil {
		return err
	}
	if out == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxResponseBody))
		return nil
	}
	// CreateOS wraps every payload in a JSend envelope, so the fields callers
	// want sit one level down under "data". Decoding the body straight into the
	// caller's struct would silently yield a zero value: a sandbox with no id,
	// or an exec result reporting exit code 0 for a command that never ran.
	var wrapped envelope
	if err := json.NewDecoder(io.LimitReader(response.Body, maxResponseBody)).Decode(&wrapped); err != nil {
		return fmt.Errorf("createos: decode %s response: %w", path, err)
	}
	if len(wrapped.Data) == 0 {
		return fmt.Errorf("createos: %s response carried no data", path)
	}
	if err := json.Unmarshal(wrapped.Data, out); err != nil {
		return fmt.Errorf("createos: decode %s response: %w", path, err)
	}
	return nil
}

// envelope is the JSend wrapper CreateOS puts around every response:
// {"status":"success","data":{...}}. A non-2xx status is already rejected by
// statusError, so only the success shape needs unwrapping here.
type envelope struct {
	Status  string          `json:"status"`
	Data    json.RawMessage `json:"data"`
	Message string          `json:"message"`
}

// statusError converts a non-2xx response. A 404 becomes ErrNotFound, which is
// the only error the reconciler treats as proof an environment is gone;
// everything else stays a transport failure that leaves observed state alone.
func statusError(response *http.Response) error {
	if response.StatusCode >= 200 && response.StatusCode <= 299 {
		return nil
	}
	if response.StatusCode == http.StatusNotFound {
		return sandbox.ErrNotFound
	}
	snippet, _ := io.ReadAll(io.LimitReader(response.Body, maxErrorBody))
	return &HTTPError{
		StatusCode: response.StatusCode,
		Body:       truncate(strings.TrimSpace(string(snippet)), maxErrorBody),
	}
}

// listResponse tolerates both a bare array and the common envelope shapes, so a
// change in pagination style does not silently return an empty page.
type listResponse struct {
	bare       []sandboxView
	Sandboxes  []sandboxView `json:"sandboxes"`
	Items      []sandboxView `json:"items"`
	Data       []sandboxView `json:"data"`
	Pagination struct {
		Total  int `json:"total"`
		Limit  int `json:"limit"`
		Offset int `json:"offset"`
		Count  int `json:"count"`
	} `json:"pagination"`
}

func (l *listResponse) UnmarshalJSON(raw []byte) error {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) > 0 && trimmed[0] == '[' {
		return json.Unmarshal(trimmed, &l.bare)
	}
	type alias listResponse
	var decoded alias
	if err := json.Unmarshal(trimmed, &decoded); err != nil {
		return err
	}
	*l = listResponse(decoded)
	return nil
}

func (l *listResponse) items() []sandboxView {
	switch {
	case len(l.bare) > 0:
		return l.bare
	case len(l.Sandboxes) > 0:
		return l.Sandboxes
	case len(l.Items) > 0:
		return l.Items
	default:
		return l.Data
	}
}

// exhausted reports whether the page just read was the last one. CreateOS pages
// by offset and reports the unpaged total, so the caller stops as soon as it has
// walked past that total rather than asking for a page that cannot exist.
func (l *listResponse) exhausted(offset, read int) bool {
	if l.Pagination.Total <= 0 {
		return true
	}
	return offset+read >= l.Pagination.Total
}

// SandboxName is the correlation key between an AO session and its sandbox.
func SandboxName(sessionID string) string {
	return "ao-" + sessionID
}

// normalizeState maps CreateOS lifecycle states onto AO's provider-neutral
// vocabulary. Any state this build does not know becomes provisioning — never
// running — because calling a sandbox ready before its worker has checked in
// suppresses the startup deadline and strands the session in silence.
func normalizeState(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "running":
		return sandbox.StateRunning
	case "paused":
		return sandbox.StatePaused
	case "destroying":
		return sandbox.StateDeleting
	case "destroyed":
		return sandbox.StateDeleted
	case "creating", "pausing", "resuming", "forking":
		return sandbox.StateProvisioning
	case "error", "failed":
		// A failed VM is not gone, so it is not StateDeleted; reporting it as
		// not-yet-ready lets the startup deadline drive the repair.
		return sandbox.StateProvisioning
	default:
		return sandbox.StateProvisioning
	}
}

func toEnvironment(view sandboxView) sandbox.Environment {
	return sandbox.Environment{
		ID:     sandbox.ID(view.ID),
		Name:   view.Name,
		State:  normalizeState(view.Status),
		Target: view.Region,
		Resource: domain.ResourceProfile{
			CPU:    view.VCPU,
			Memory: view.MemMiB / 1024,
			Disk:   view.DiskMiB / 1024,
		},
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// path splits an absolute guest path into its file name and parent directory.
func path(absolute string) (string, string) {
	index := strings.LastIndex(absolute, "/")
	if index <= 0 {
		return absolute, ""
	}
	return absolute[index+1:], absolute[:index]
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit] + "…"
}
