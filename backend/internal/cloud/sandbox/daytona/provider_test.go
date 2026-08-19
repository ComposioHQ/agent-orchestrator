package daytona

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/sandbox"
)

type fakeClient struct {
	createRequest CreateRequest
	created       RemoteSandbox
	listed        []RemoteSandbox
	get           RemoteSandbox
	uploads       map[string][]byte
	command       string
	environment   map[string]string
	actions       []string
	err           error
}

func (c *fakeClient) Create(_ context.Context, request CreateRequest) (RemoteSandbox, error) {
	c.createRequest = request
	return c.created, c.err
}
func (c *fakeClient) Get(context.Context, string) (RemoteSandbox, error) { return c.get, c.err }
func (c *fakeClient) List(context.Context, map[string]string) ([]RemoteSandbox, error) {
	return c.listed, c.err
}
func (c *fakeClient) Start(context.Context, string) error {
	c.actions = append(c.actions, "start")
	return c.err
}
func (c *fakeClient) Stop(context.Context, string) error {
	c.actions = append(c.actions, "stop")
	return c.err
}
func (c *fakeClient) Pause(context.Context, string) error {
	c.actions = append(c.actions, "pause")
	return c.err
}
func (c *fakeClient) Delete(context.Context, string) error {
	c.actions = append(c.actions, "delete")
	return c.err
}
func (c *fakeClient) Upload(_ context.Context, _ string, path string, data []byte) error {
	if c.uploads == nil {
		c.uploads = make(map[string][]byte)
	}
	c.uploads[path] = append([]byte(nil), data...)
	return c.err
}
func (c *fakeClient) Execute(
	_ context.Context,
	_ string,
	command string,
	environment map[string]string,
) (ExecResult, error) {
	c.command = command
	c.environment = environment
	return ExecResult{}, c.err
}

func testConfig(client Client) Config {
	return Config{
		APIURL:          "https://app.daytona.io/api",
		APIKey:          "daytona-secret",
		Target:          "us",
		Snapshot:        "ao-worker-v1",
		User:            "root",
		DomainAllowList: "staging-api.aoagents.dev,api.anthropic.com,github.com,api.github.com",
		WorkerTokenTTL:  15 * time.Minute,
		Client:          client,
	}
}

func TestCreateAppliesOwnershipAndFailClosedNetworkPolicy(t *testing.T) {
	client := &fakeClient{created: RemoteSandbox{
		ID: "sandbox-1", State: "started", CPU: 4, Memory: 8, Disk: 10,
	}}
	provider, err := New(testConfig(client))
	if err != nil {
		t.Fatal(err)
	}
	environment, err := provider.Create(context.Background(), sandbox.Spec{
		Name: "ao-session", SessionID: "session-1", OrgID: "org-1",
		ResourceProfile: domain.ResourceProfile{CPU: 4, Memory: 8, Disk: 10},
		Environment:     map[string]string{"AO_WORKER_BOOTSTRAP_TOKEN": "one-time-ticket"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if environment.State != sandbox.StateRunning || environment.ID != "sandbox-1" {
		t.Fatalf("environment = %#v", environment)
	}
	request := client.createRequest
	if request.Labels[labelSessionID] != "session-1" || request.Labels["ao.org_id"] != "org-1" ||
		request.Labels["ao.managed"] != "true" {
		t.Fatalf("labels = %#v", request.Labels)
	}
	if request.Snapshot != "ao-worker-v1" || request.DomainAllowList == "" ||
		len(request.Environment) != 0 {
		t.Fatalf("create request = %#v", request)
	}
}

func TestUnknownDaytonaStateNeverReportsRunning(t *testing.T) {
	client := &fakeClient{get: RemoteSandbox{ID: "sandbox-1", State: "future-state"}}
	provider, _ := New(testConfig(client))
	environment, err := provider.Get(context.Background(), "sandbox-1")
	if err != nil {
		t.Fatal(err)
	}
	if environment.State != sandbox.StateProvisioning {
		t.Fatalf("state = %q", environment.State)
	}
}

func TestFindBySessionValidatesReturnedLabels(t *testing.T) {
	client := &fakeClient{listed: []RemoteSandbox{
		{ID: "wrong", State: "started", Labels: map[string]string{labelSessionID: "other", "ao.managed": "true"}},
		{ID: "right", State: "paused", Labels: map[string]string{labelSessionID: "session-1", "ao.managed": "true"}},
	}}
	provider, _ := New(testConfig(client))
	environment, found, err := provider.FindBySession(context.Background(), "session-1")
	if err != nil || !found || environment.ID != "right" || environment.State != sandbox.StatePaused {
		t.Fatalf("environment = %#v, found = %v, error = %v", environment, found, err)
	}
}

func TestBootstrapUploadsBinariesWithoutEmbeddingTicketInCommand(t *testing.T) {
	client := &fakeClient{}
	provider, _ := New(testConfig(client))
	secret := "single-use-bootstrap-secret"
	err := provider.BootstrapWorker(context.Background(), "sandbox-1", sandbox.WorkerBootstrap{
		Binary:            []byte("worker"),
		Destination:       "/usr/local/bin/ao-worker",
		HelperBinary:      []byte("helper"),
		HelperDestination: "/usr/local/bin/ao",
		User:              "ao-worker",
		Environment:       map[string]string{"AO_WORKER_BOOTSTRAP_TOKEN": secret},
	})
	if err != nil {
		t.Fatal(err)
	}
	if string(client.uploads["/usr/local/bin/ao-worker.new"]) != "worker" ||
		string(client.uploads["/usr/local/bin/ao.new"]) != "helper" {
		t.Fatalf("uploads = %#v", client.uploads)
	}
	if strings.Contains(client.command, secret) || client.environment["AO_WORKER_BOOTSTRAP_TOKEN"] != secret {
		t.Fatalf("command leaked secret or environment lost it: command=%q env=%#v", client.command, client.environment)
	}
	if !strings.Contains(client.command, "runuser -u ao-worker --preserve-environment") {
		t.Fatalf("worker command = %q", client.command)
	}
}

func TestNotFoundIsTheOnlyDefinitiveAbsence(t *testing.T) {
	client := &fakeClient{err: ErrNotFound}
	provider, _ := New(testConfig(client))
	if _, err := provider.Get(context.Background(), "missing"); !errors.Is(err, sandbox.ErrNotFound) {
		t.Fatalf("not-found error = %v", err)
	}
	client.err = errors.New("network unavailable")
	if _, err := provider.Get(context.Background(), "unknown"); errors.Is(err, sandbox.ErrNotFound) {
		t.Fatalf("network failure was treated as absence: %v", err)
	}
}
