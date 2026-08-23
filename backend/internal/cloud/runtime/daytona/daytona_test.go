package daytona

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/runtime"
)

type recordedRequest struct {
	Method string
	Path   string
	Query  string
	Header http.Header
	Body   string
}

// apiStub is a Daytona API double. Handlers are keyed by "METHOD /path".
type apiStub struct {
	t        *testing.T
	server   *httptest.Server
	requests []recordedRequest
	handlers map[string]func(http.ResponseWriter, *http.Request)
}

func newAPIStub(t *testing.T) *apiStub {
	t.Helper()
	stub := &apiStub{t: t, handlers: make(map[string]func(http.ResponseWriter, *http.Request))}
	stub.server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		stub.requests = append(stub.requests, recordedRequest{
			Method: request.Method,
			Path:   request.URL.Path,
			Query:  request.URL.RawQuery,
			Header: request.Header.Clone(),
			Body:   string(body),
		})
		handler, ok := stub.handlers[request.Method+" "+request.URL.Path]
		if !ok {
			writer.WriteHeader(http.StatusNotFound)
			return
		}
		handler(writer, request)
	}))
	t.Cleanup(stub.server.Close)
	return stub
}

func (s *apiStub) on(key string, handler func(http.ResponseWriter, *http.Request)) {
	s.handlers[key] = handler
}

func (s *apiStub) json(key string, status int, body any) {
	s.on(key, func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(status)
		if body != nil {
			_ = json.NewEncoder(writer).Encode(body)
		}
	})
}

func (s *apiStub) provider(t *testing.T) *Provider {
	t.Helper()
	provider, err := New(Options{
		BaseURL:        s.server.URL,
		APIKey:         "dtn_secret",
		OrganizationID: "daytona-org",
		Target:         "eu",
		HTTPClient:     s.server.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	return provider
}

func sampleRef() runtime.Ref {
	return runtime.Ref{OrgID: "org-1", WorkspaceID: "ws-1", SessionID: "sess-1", UserID: "user-1", Role: runtime.RoleWorker}
}

func sampleRequest() runtime.CreateRequest {
	ref := sampleRef()
	return runtime.CreateRequest{
		Ref:                ref,
		Labels:             runtime.Labels("staging", ref, "rt-1"),
		Snapshot:           "ao-worker",
		Env:                map[string]string{"AO_CLOUD_CAPABILITY": "aocap_v1.abcdefgh.ijklmnop"},
		Resources:          runtime.Resources{CPU: 2, MemoryGB: 4, DiskGB: 10},
		AutoStopInterval:   90 * time.Second,
		AutoDeleteInterval: 24 * time.Hour,
		IdempotencyKey:     "rt-1",
	}
}

func TestCreateSendsLabelsEnvironmentAndCredentialsInHeaders(t *testing.T) {
	stub := newAPIStub(t)
	stub.json("POST /sandbox", http.StatusOK, map[string]any{
		"id":        "sbx-1",
		"state":     "started",
		"labels":    runtime.Labels("staging", sampleRef(), "rt-1"),
		"createdAt": "2026-08-22T09:00:00Z",
	})

	sandbox, err := stub.provider(t).Create(context.Background(), sampleRequest())
	if err != nil {
		t.Fatal(err)
	}
	if sandbox.ID != "sbx-1" || sandbox.State != runtime.ProviderRunning {
		t.Fatalf("sandbox = %#v", sandbox)
	}
	if !sandbox.CreatedAt.Equal(time.Date(2026, 8, 22, 9, 0, 0, 0, time.UTC)) {
		t.Fatalf("created at = %s", sandbox.CreatedAt)
	}
	if _, ok := sandbox.Attribution(); !ok {
		t.Fatal("created sandbox is not attributable")
	}

	request := stub.requests[0]
	if request.Header.Get("Authorization") != "Bearer dtn_secret" {
		t.Fatalf("authorization = %q", request.Header.Get("Authorization"))
	}
	if request.Header.Get("X-Daytona-Organization-ID") != "daytona-org" {
		t.Fatalf("organization header = %q", request.Header.Get("X-Daytona-Organization-ID"))
	}
	if request.Header.Get("Idempotency-Key") != "rt-1" {
		t.Fatalf("idempotency key = %q", request.Header.Get("Idempotency-Key"))
	}
	// The API key must never reach the URL, where every proxy logs it.
	if strings.Contains(request.Query, "dtn_secret") || strings.Contains(request.Path, "dtn_secret") {
		t.Fatalf("credential leaked into the request line: %s?%s", request.Path, request.Query)
	}

	var body createPayload
	if err := json.Unmarshal([]byte(request.Body), &body); err != nil {
		t.Fatal(err)
	}
	if body.Snapshot != "ao-worker" || body.Target != "eu" || body.CPU != 2 || body.Memory != 4 || body.Disk != 10 {
		t.Fatalf("create body = %#v", body)
	}
	if body.Labels[runtime.LabelRuntimeID] != "rt-1" || body.Labels[runtime.LabelDeployment] != "staging" {
		t.Fatalf("labels = %#v", body.Labels)
	}
	if body.EnvVars["AO_CLOUD_CAPABILITY"] == "" {
		t.Fatal("capability not delivered through the environment")
	}
	// 90s rounds up: "stop as soon as you can" must not become "never stop".
	if body.AutoStopInterval == nil || *body.AutoStopInterval != 2 {
		t.Fatalf("auto stop = %v, want 2 minutes", body.AutoStopInterval)
	}
	if body.AutoDeleteInterval == nil || *body.AutoDeleteInterval != 1440 {
		t.Fatalf("auto delete = %v", body.AutoDeleteInterval)
	}
}

func TestCreateRejectsARequestThatWouldLeakSecretsIntoArgv(t *testing.T) {
	stub := newAPIStub(t)
	request := sampleRequest()
	request.Command = "/usr/bin/ao-agent"
	request.Args = []string{"--capability", "aocap_v1.abcdefgh.ijklmnop"}

	if _, err := stub.provider(t).Create(context.Background(), request); !errors.Is(err, runtime.ErrInvalid) {
		t.Fatalf("err = %v, want ErrInvalid", err)
	}
	if len(stub.requests) != 0 {
		t.Fatal("the adapter contacted the provider with a leaking request")
	}
}

func TestCreateDeliversSecretFilesWithOwnerOnlyPermissions(t *testing.T) {
	stub := newAPIStub(t)
	stub.json("POST /sandbox", http.StatusOK, map[string]any{"id": "sbx-1", "state": "started"})
	stub.json("POST /toolbox/sbx-1/toolbox/files/upload", http.StatusOK, nil)
	stub.json("POST /toolbox/sbx-1/toolbox/files/permissions", http.StatusOK, nil)

	request := sampleRequest()
	request.SecretFiles = map[string]string{"/home/agent/.ssh/id_ed25519": "PRIVATE KEY"}
	if _, err := stub.provider(t).Create(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	var permissions recordedRequest
	for _, recorded := range stub.requests {
		if strings.HasSuffix(recorded.Path, "/files/permissions") {
			permissions = recorded
		}
	}
	if permissions.Path == "" {
		t.Fatalf("permissions were never tightened: %#v", stub.requests)
	}
	if !strings.Contains(permissions.Query, "mode="+secretFileMode) {
		t.Fatalf("permissions query = %q, want mode %s", permissions.Query, secretFileMode)
	}
}

func TestCreateDestroysTheSandboxWhenSecretDeliveryFails(t *testing.T) {
	stub := newAPIStub(t)
	stub.json("POST /sandbox", http.StatusOK, map[string]any{"id": "sbx-1", "state": "started"})
	stub.json("POST /toolbox/sbx-1/toolbox/files/upload", http.StatusInternalServerError, nil)
	deleted := false
	stub.on("DELETE /sandbox/sbx-1", func(writer http.ResponseWriter, _ *http.Request) {
		deleted = true
		writer.WriteHeader(http.StatusOK)
	})

	request := sampleRequest()
	request.SecretFiles = map[string]string{"/run/secrets/token": "value"}
	if _, err := stub.provider(t).Create(context.Background(), request); err == nil {
		t.Fatal("a half-provisioned sandbox was returned as a success")
	}
	if !deleted {
		t.Fatal("the half-provisioned sandbox was left behind")
	}
}

func TestGetTreatsAMissingOrDestroyedSandboxAsNotFound(t *testing.T) {
	stub := newAPIStub(t)
	stub.json("GET /sandbox/sbx-gone", http.StatusNotFound, nil)
	stub.json("GET /sandbox/sbx-destroyed", http.StatusOK, map[string]any{"id": "sbx-destroyed", "state": "destroyed"})
	provider := stub.provider(t)

	for _, id := range []string{"sbx-gone", "sbx-destroyed"} {
		if _, err := provider.Get(context.Background(), id); !errors.Is(err, runtime.ErrSandboxNotFound) {
			t.Fatalf("%s: err = %v, want ErrSandboxNotFound", id, err)
		}
	}
}

func TestDeleteIsIdempotentAndForces(t *testing.T) {
	stub := newAPIStub(t)
	stub.json("DELETE /sandbox/sbx-gone", http.StatusNotFound, nil)
	if err := stub.provider(t).Delete(context.Background(), "sbx-gone"); err != nil {
		t.Fatalf("deleting a missing sandbox = %v, want nil", err)
	}
	if !strings.Contains(stub.requests[0].Query, "force=true") {
		t.Fatalf("query = %q, want a forced delete", stub.requests[0].Query)
	}
}

func TestStartAndStopReturnTheRefreshedSandbox(t *testing.T) {
	stub := newAPIStub(t)
	state := "stopped"
	stub.on("POST /sandbox/sbx-1/start", func(writer http.ResponseWriter, _ *http.Request) {
		state = "started"
		writer.WriteHeader(http.StatusOK)
	})
	stub.on("POST /sandbox/sbx-1/stop", func(writer http.ResponseWriter, _ *http.Request) {
		state = "stopped"
		writer.WriteHeader(http.StatusOK)
	})
	stub.on("GET /sandbox/sbx-1", func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{"id": "sbx-1", "state": state})
	})
	provider := stub.provider(t)

	started, err := provider.Start(context.Background(), "sbx-1")
	if err != nil {
		t.Fatal(err)
	}
	if started.State != runtime.ProviderRunning {
		t.Fatalf("state = %s", started.State)
	}
	stopped, err := provider.Stop(context.Background(), "sbx-1")
	if err != nil {
		t.Fatal(err)
	}
	if stopped.State != runtime.ProviderStopped {
		t.Fatalf("state = %s", stopped.State)
	}
}

func TestListFiltersByLabelsAndDropsDestroyedSandboxes(t *testing.T) {
	stub := newAPIStub(t)
	stub.json("GET /sandbox", http.StatusOK, []map[string]any{
		{"id": "sbx-1", "state": "started"},
		{"id": "sbx-2", "state": "destroyed"},
	})
	provider := stub.provider(t)

	all, err := provider.List(context.Background(), runtime.Selector{})
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 1 || all[0].ID != "sbx-1" {
		t.Fatalf("sandboxes = %#v", all)
	}
	// An empty selector must not filter: leak discovery needs every sandbox in
	// the account, and a leak has no labels to select on.
	if stub.requests[0].Query != "" {
		t.Fatalf("query = %q, want no label filter", stub.requests[0].Query)
	}

	if _, err := provider.List(context.Background(), runtime.Selector{
		Labels: map[string]string{runtime.LabelDeployment: "staging"},
	}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stub.requests[1].Query, "labels=") {
		t.Fatalf("query = %q, want a label filter", stub.requests[1].Query)
	}
}

func TestProviderStateNormalization(t *testing.T) {
	for state, want := range map[string]runtime.ProviderState{
		"started":          runtime.ProviderRunning,
		"STARTED":          runtime.ProviderRunning,
		"creating":         runtime.ProviderStarting,
		"pulling_snapshot": runtime.ProviderStarting,
		"stopped":          runtime.ProviderStopped,
		"archived":         runtime.ProviderStopped,
		"error":            runtime.ProviderError,
		"build_failed":     runtime.ProviderError,
		// An unrecognized state must never read as healthy: the control plane
		// would keep paying for a sandbox it cannot use.
		"some_new_daytona_state": runtime.ProviderError,
	} {
		if got := providerState(state); got != want {
			t.Fatalf("%s = %s, want %s", state, got, want)
		}
	}
}

func TestErrorsCarryTheStatusAndABoundedExcerpt(t *testing.T) {
	stub := newAPIStub(t)
	stub.on("POST /sandbox", func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusTooManyRequests)
		_, _ = writer.Write([]byte(strings.Repeat("x", 4096)))
	})
	_, err := stub.provider(t).Create(context.Background(), sampleRequest())
	if err == nil || !strings.Contains(err.Error(), "429") {
		t.Fatalf("err = %v, want the status surfaced", err)
	}
	if len(err.Error()) > 700 {
		t.Fatalf("error body was not truncated: %d bytes", len(err.Error()))
	}
}

func TestNewRequiresAnAPIKey(t *testing.T) {
	if _, err := New(Options{}); err == nil {
		t.Fatal("adapter built without a credential")
	}
	provider, err := New(Options{APIKey: "k"})
	if err != nil {
		t.Fatal(err)
	}
	if provider.baseURL != DefaultBaseURL {
		t.Fatalf("base URL = %q", provider.baseURL)
	}
}
