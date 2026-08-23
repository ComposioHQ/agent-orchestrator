package daytona

import (
	"context"
	"crypto/tls"
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
	method string
	path   string
	query  string
	header http.Header
	body   string
}

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
			method: request.Method, path: request.URL.Path, query: request.URL.RawQuery,
			header: request.Header.Clone(), body: string(body),
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

func (s *apiStub) json(key string, status int, body any) {
	s.handlers[key] = func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(status)
		if body != nil {
			_ = json.NewEncoder(writer).Encode(body)
		}
	}
}

func (s *apiStub) provider(t *testing.T) *Provider {
	t.Helper()
	provider, err := New(Options{
		BaseURL: s.server.URL, APIKey: "dtn_test_key", OrganizationID: "daytona-org",
		Target: "us", HTTPClient: s.server.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	return provider
}

func sampleRef() runtime.Ref {
	return runtime.Ref{OrgID: "org-1", WorkspaceID: "ws-1", SessionID: "sess-1", UserID: "user-1", Role: runtime.RoleWorker}
}

func sampleRequest(secret []byte) runtime.CreateRequest {
	ref := sampleRef()
	return runtime.CreateRequest{
		Ref: ref, Labels: runtime.Labels("staging", ref, "rt-1"), Snapshot: "ao-worker",
		Capability:       runtime.FileSecret{Path: runtime.CapabilityFilePath, Content: []byte("aocap_v1.create-capability-material"), Mode: 0o600},
		ControlPlaneURL:  "https://cloud.example",
		SecretFiles:      []runtime.FileSecret{{Path: "/run/ao/secrets/test-ticket", Content: secret, Mode: 0o600}},
		Command:          "/usr/local/bin/codex",
		Args:             []string{"exec", "it's-semantic"},
		Env:              map[string]string{"AO_AGENT_MODE": "cloud"},
		Resources:        runtime.Resources{CPU: 2, MemoryGB: 4, DiskGB: 10},
		AutoStopInterval: 90 * time.Second, AutoDeleteInterval: 24 * time.Hour,
		IdempotencyKey: "rt-1",
	}
}

func sampleStartRequest() runtime.StartRequest {
	return runtime.StartRequest{
		Ref:             sampleRef(),
		SecretFiles:     []runtime.FileSecret{{Path: "/run/ao/secrets/test-ticket", Content: []byte("fresh-restart-ticket-material"), Mode: 0o600}},
		Command:         "/usr/local/bin/codex",
		Args:            []string{"exec", "restart"},
		BootstrapKey:    "restart-1",
		RuntimeID:       "rt-1",
		Capability:      runtime.FileSecret{Path: runtime.CapabilityFilePath, Content: []byte("aocap_v1.restart-capability-material"), Mode: 0o600},
		ControlPlaneURL: "https://cloud.example",
	}
}

func installCreateHandlers(stub *apiStub) {
	stub.json("POST /sandbox", http.StatusOK, map[string]any{
		"id": "sbx-1", "state": "started", "labels": runtime.Labels("staging", sampleRef(), "rt-1"),
		"createdAt": "2026-08-23T12:00:00Z", "lastActivityAt": "2026-08-23T12:01:00Z",
	})
	stub.json("POST /toolbox/sbx-1/toolbox/files/upload", http.StatusOK, nil)
	stub.json("POST /toolbox/sbx-1/toolbox/files/permissions", http.StatusOK, nil)
	stub.json("GET /toolbox/sbx-1/toolbox/process/session", http.StatusOK, []map[string]string{{"sessionId": "ao-runtime-old-grant"}})
	stub.json("DELETE /toolbox/sbx-1/toolbox/process/session/ao-runtime-old-grant", http.StatusNoContent, nil)
	stub.json("POST /toolbox/sbx-1/toolbox/process/session", http.StatusOK, nil)
	stub.json("POST /toolbox/sbx-1/toolbox/process/session/ao-runtime-rt-1/exec", http.StatusOK, nil)
}

func TestCreateDeliversOwnerOnlySecretThenExecutesSemanticCommand(t *testing.T) {
	stub := newAPIStub(t)
	installCreateHandlers(stub)
	secret := []byte("aocap_v1.secret-material-never-log")

	sandbox, err := stub.provider(t).Create(context.Background(), sampleRequest(secret))
	if err != nil {
		t.Fatal(err)
	}
	if sandbox.ID != "sbx-1" || sandbox.State != runtime.ProviderRunning {
		t.Fatalf("sandbox = %#v", sandbox)
	}
	if sandbox.LastActivityAt.IsZero() {
		t.Fatal("provider last activity was not preserved")
	}
	if len(secret) == 0 || strings.Trim(string(secret), "\x00") != "" {
		t.Fatalf("transient secret buffer was not purged: %q", secret)
	}

	if len(stub.requests) != 7 {
		t.Fatalf("requests = %#v", stub.requests)
	}
	create := stub.requests[0]
	if create.header.Get("Authorization") != "Bearer dtn_test_key" || create.header.Get("Idempotency-Key") != "rt-1" {
		t.Fatalf("create headers = %#v", create.header)
	}
	if strings.Contains(create.body, "secret-material") || strings.Contains(create.query, "dtn_test_key") {
		t.Fatal("credential leaked into Daytona create request or URL")
	}
	capabilityUpload := stub.requests[3]
	if !strings.Contains(capabilityUpload.body, "aocap_v1.create-capability-material") {
		t.Fatalf("raw capability was not delivered: %q", capabilityUpload.body)
	}
	for _, forbidden := range []string{"sandboxId", "workspaceId", "controlPlaneRedeemUrl"} {
		if strings.Contains(capabilityUpload.body, forbidden) {
			t.Fatalf("obsolete capability metadata %q was delivered: %q", forbidden, capabilityUpload.body)
		}
	}
	var body createPayload
	if err := json.Unmarshal([]byte(create.body), &body); err != nil {
		t.Fatal(err)
	}
	if body.Snapshot != "ao-worker" || body.CPU != 2 || body.Memory != 4 || body.Disk != 10 {
		t.Fatalf("create body = %#v", body)
	}
	if body.EnvVars["AO_AGENT_MODE"] != "cloud" {
		t.Fatalf("create environment = %#v", body.EnvVars)
	}
	if body.AutoStopInterval == nil || *body.AutoStopInterval != 2 || body.AutoDeleteInterval == nil || *body.AutoDeleteInterval != 1440 {
		t.Fatalf("provider guards = %v %v", body.AutoStopInterval, body.AutoDeleteInterval)
	}
	permissions := stub.requests[2]
	if !strings.Contains(permissions.query, "mode=0600") {
		t.Fatalf("permissions query = %q", permissions.query)
	}
	var launch struct {
		Command  string `json:"command"`
		RunAsync bool   `json:"runAsync"`
	}
	if err := json.Unmarshal([]byte(stub.requests[6].body), &launch); err != nil {
		t.Fatal(err)
	}
	want := "exec '/usr/local/bin/ao-sandbox' '--listen' '0.0.0.0:8080' '--control-plane-url' 'https://cloud.example' '--sandbox-id' 'rt-1' '--workspace-id' 'ws-1' '--session-id' 'sess-1' '--workspace' '/workspace' '--ready-file' '/run/ao/ready.json' '--secret-dir' '/run/ao/secrets' '--route-prefix' '/api/sandbox/v1' '--' '/usr/local/bin/codex' 'exec' 'it'\"'\"'s-semantic'"
	if launch.Command != want || !launch.RunAsync {
		t.Fatalf("launch = %#v, want command %q", launch, want)
	}
	if strings.Contains(launch.Command, "aocap_") {
		t.Fatal("capability leaked into bootstrap command")
	}
}

func TestCreateTreatsExistingBootstrapSessionAsIdempotent(t *testing.T) {
	stub := newAPIStub(t)
	installCreateHandlers(stub)
	stub.json("POST /toolbox/sbx-1/toolbox/process/session", http.StatusConflict, map[string]string{"error": "exists"})

	if _, err := stub.provider(t).Create(context.Background(), sampleRequest([]byte("aocap_v1.secret-material"))); err != nil {
		t.Fatal(err)
	}
	for _, request := range stub.requests {
		if strings.HasSuffix(request.path, "/exec") {
			t.Fatal("idempotent retry executed the runtime twice")
		}
	}
}

func TestCreatePurgesSecretAndReturnsSandboxHandleOnBootstrapFailure(t *testing.T) {
	stub := newAPIStub(t)
	installCreateHandlers(stub)
	stub.json("POST /toolbox/sbx-1/toolbox/process/session/ao-runtime-rt-1/exec", http.StatusBadGateway, map[string]string{"error": "toolbox unavailable"})
	deleted := false
	stub.handlers["DELETE /sandbox/sbx-1"] = func(writer http.ResponseWriter, _ *http.Request) {
		deleted = true
		writer.WriteHeader(http.StatusNoContent)
	}
	secret := []byte("aocap_v1.must-be-purged-on-error")

	sandbox, err := stub.provider(t).Create(context.Background(), sampleRequest(secret))
	if err == nil {
		t.Fatal("bootstrap failure returned success")
	}
	if sandbox.ID != "sbx-1" {
		t.Fatalf("sandbox id = %q, want retained provider handle", sandbox.ID)
	}
	if deleted {
		t.Fatal("bootstrap failure deleted compute before its handle could be persisted")
	}
	if strings.Trim(string(secret), "\x00") != "" {
		t.Fatal("secret survived failed creation")
	}
}

func TestCreateRejectsSecretInArgvBeforeCallingProvider(t *testing.T) {
	stub := newAPIStub(t)
	secret := []byte("aocap_v1.argv-leak-material")
	request := sampleRequest(secret)
	request.Args = append(request.Args, string(secret))
	if _, err := stub.provider(t).Create(context.Background(), request); !errors.Is(err, runtime.ErrInvalid) {
		t.Fatalf("err = %v, want ErrInvalid", err)
	}
	if len(stub.requests) != 0 {
		t.Fatal("invalid request reached provider")
	}
	if strings.Trim(string(secret), "\x00") != "" {
		t.Fatal("rejected secret was not purged")
	}
}

func TestLifecycleNormalizesStatesAndDeleteIsIdempotent(t *testing.T) {
	stub := newAPIStub(t)
	state := "stopped"
	stub.handlers["POST /sandbox/sbx-1/start"] = func(writer http.ResponseWriter, _ *http.Request) { state = "started" }
	stub.handlers["POST /sandbox/sbx-1/stop"] = func(writer http.ResponseWriter, _ *http.Request) { state = "stopped" }
	stub.handlers["GET /sandbox/sbx-1"] = func(writer http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(writer).Encode(map[string]any{"id": "sbx-1", "state": state})
	}
	stub.json("POST /toolbox/sbx-1/toolbox/files/upload", http.StatusOK, nil)
	stub.json("POST /toolbox/sbx-1/toolbox/files/permissions", http.StatusOK, nil)
	stub.json("GET /toolbox/sbx-1/toolbox/process/session", http.StatusOK, []map[string]string{{"sessionId": "ao-runtime-old-grant"}})
	stub.json("DELETE /toolbox/sbx-1/toolbox/process/session/ao-runtime-old-grant", http.StatusNoContent, nil)
	stub.json("POST /toolbox/sbx-1/toolbox/process/session", http.StatusOK, nil)
	stub.json("POST /toolbox/sbx-1/toolbox/process/session/ao-runtime-restart-1/exec", http.StatusOK, nil)
	stub.json("DELETE /sandbox/gone", http.StatusNotFound, nil)
	provider := stub.provider(t)
	started, err := provider.Start(context.Background(), "sbx-1", sampleStartRequest())
	if err != nil || started.State != runtime.ProviderRunning {
		t.Fatalf("start = %#v, %v", started, err)
	}
	stopped, err := provider.Stop(context.Background(), "sbx-1")
	if err != nil || stopped.State != runtime.ProviderStopped {
		t.Fatalf("stop = %#v, %v", stopped, err)
	}
	before := len(stub.requests)
	if _, err := provider.Stop(context.Background(), "sbx-1"); err != nil {
		t.Fatalf("idempotent stop: %v", err)
	}
	if len(stub.requests) != before+1 || stub.requests[len(stub.requests)-1].method != http.MethodGet {
		t.Fatal("idempotent stop performed another transition")
	}
	if err := provider.Delete(context.Background(), "gone"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stub.requests[len(stub.requests)-1].query, "force=true") {
		t.Fatal("delete was not forced")
	}
}

func TestListFiltersLabelsAndDropsDestroyedSandboxes(t *testing.T) {
	stub := newAPIStub(t)
	stub.json("GET /sandbox", http.StatusOK, []map[string]any{
		{"id": "live", "state": "started"}, {"id": "gone", "state": "destroyed"},
	})
	provider := stub.provider(t)
	got, err := provider.List(context.Background(), runtime.Selector{Labels: map[string]string{runtime.LabelDeployment: "staging"}})
	if err != nil || len(got) != 1 || got[0].ID != "live" {
		t.Fatalf("list = %#v, %v", got, err)
	}
	if !strings.Contains(stub.requests[0].query, "labels=") {
		t.Fatalf("query = %q", stub.requests[0].query)
	}
}

func TestNewRejectsMissingKeyAndInsecureRemoteOrigin(t *testing.T) {
	if _, err := New(Options{}); err == nil {
		t.Fatal("missing API key accepted")
	}
	if _, err := New(Options{APIKey: "secret", BaseURL: "http://daytona.example/api"}); err == nil {
		t.Fatal("insecure remote origin accepted")
	}
	//nolint:gosec // The adapter must reject this intentionally insecure test transport.
	if _, err := New(Options{
		APIKey: "secret", BaseURL: "https://daytona.example/api",
		HTTPClient: &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}},
	}); err == nil {
		t.Fatal("insecure TLS transport accepted")
	}
}
