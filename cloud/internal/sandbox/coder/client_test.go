package coder

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/cloud/internal/sandbox"
	"github.com/coder/websocket"
)

const (
	testWorkspaceID = "c334f2ce-4cfd-4d1e-a985-a58751f0a82e"
	testTemplateID  = "2a2e262c-b31c-4202-946d-a19ad45d1fd2"
	testAgentID     = "0536c201-bd3f-44c7-91cb-f22844bbade1"
)

func TestLifecycle(t *testing.T) {
	t.Parallel()

	var (
		mu          sync.Mutex
		transitions []string
	)
	handler := http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Coder-Session-Token") != "test-token" {
			t.Errorf("missing Coder token header")
		}
		switch {
		case request.Method == http.MethodPost && request.URL.Path == "/api/v2/users/ao-integration/workspaces":
			var body createWorkspaceRequest
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Errorf("decode create request: %v", err)
			}
			if body.Name != WorkspaceName("session-1") || body.TemplateID != testTemplateID {
				t.Errorf("unexpected create request: %+v", body)
			}
			if len(body.RichParameterValues) != 2 || body.RichParameterValues[0].Name != "instance_type" ||
				body.RichParameterValues[1].Name != "region" {
				t.Errorf("parameters were not sorted: %+v", body.RichParameterValues)
			}
			writer.WriteHeader(http.StatusCreated)
			writeWorkspace(t, writer, "starting", "connecting", false)
		case request.Method == http.MethodGet && request.URL.Path == "/api/v2/workspaces/"+testWorkspaceID:
			writeWorkspace(t, writer, "running", "connected", true)
		case request.Method == http.MethodGet && request.URL.Path == "/api/v2/users/ao-integration/workspace/"+WorkspaceName("session-1"):
			writeWorkspace(t, writer, "running", "connected", true)
		case request.Method == http.MethodGet && request.URL.Path == "/api/v2/users/ao-integration/workspace/"+WorkspaceName("missing"):
			http.Error(writer, "not found", http.StatusNotFound)
		case request.Method == http.MethodPost && request.URL.Path == "/api/v2/workspaces/"+testWorkspaceID+"/builds":
			var body map[string]string
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Errorf("decode transition: %v", err)
			}
			mu.Lock()
			transitions = append(transitions, body["transition"])
			mu.Unlock()
			writer.WriteHeader(http.StatusCreated)
		default:
			http.Error(writer, "unexpected route", http.StatusNotFound)
		}
	})
	server := httptest.NewServer(handler)
	defer server.Close()
	client := newTestClient(t, server.URL, map[string]string{
		"region": "ap-south-1", "instance_type": "t3.medium",
	})

	created, err := client.Create(context.Background(), sandbox.Spec{SessionID: "session-1"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.State != sandbox.StateProvisioning {
		t.Fatalf("created state = %q, want provisioning", created.State)
	}
	fetched, err := client.Get(context.Background(), testWorkspaceID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if fetched.State != sandbox.StateRunning || fetched.Target != testAgentID {
		t.Fatalf("unexpected fetched environment: %+v", fetched)
	}
	found, ok, err := client.FindBySession(context.Background(), "session-1")
	if err != nil || !ok || found.ID != testWorkspaceID {
		t.Fatalf("find: environment=%+v found=%t err=%v", found, ok, err)
	}
	_, ok, err = client.FindBySession(context.Background(), "missing")
	if err != nil || ok {
		t.Fatalf("missing find: found=%t err=%v", ok, err)
	}
	for _, operation := range []func(context.Context, sandbox.ID) error{
		client.Start, client.Stop, client.Pause, client.Resume, client.Delete,
	} {
		if err := operation(context.Background(), testWorkspaceID); err != nil {
			t.Fatalf("transition: %v", err)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(transitions, ",") != "start,stop,stop,start,delete" {
		t.Fatalf("transitions = %v", transitions)
	}
}

func TestRunningBuildWaitsForHealthyAgent(t *testing.T) {
	t.Parallel()
	client := &Client{}
	view := workspace{
		ID: testWorkspaceID, Name: "ao-test", Health: workspaceHealth{Healthy: true},
		LatestBuild: workspaceBuild{Status: "running", Resources: []workspaceResource{{
			Agents: []workspaceAgent{{ID: testAgentID, Status: "connecting", Health: workspaceHealth{Healthy: true}}},
		}}},
	}
	if environment := client.toEnvironment(view); environment.State != sandbox.StateProvisioning {
		t.Fatalf("state = %q, want provisioning", environment.State)
	}
}

func TestTransitionalBuildIsNotReportedStopped(t *testing.T) {
	t.Parallel()
	client := &Client{}
	view := workspace{ID: testWorkspaceID, LatestBuild: workspaceBuild{Status: "stopping"}}
	if environment := client.toEnvironment(view); environment.State != sandbox.StateProvisioning {
		t.Fatalf("state = %q, want provisioning", environment.State)
	}
}

func TestBootstrapWorkerStreamsArchiveWithoutSecretsInURL(t *testing.T) {
	t.Parallel()

	const secret = "TOP_SECRET_WORKER_TOKEN"
	archiveResult := make(chan map[string]string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch {
		case request.URL.Path == "/api/v2/workspaces/"+testWorkspaceID:
			writeWorkspace(t, writer, "running", "connected", true)
		case request.URL.Path == "/api/v2/workspaceagents/"+testAgentID+"/pty":
			if request.Header.Get("Coder-Session-Token") != "test-token" {
				t.Errorf("missing Coder token header")
			}
			if strings.Contains(request.URL.RawQuery, secret) {
				t.Errorf("worker secret leaked into PTY URL")
			}
			command := request.URL.Query().Get("command")
			match := regexp.MustCompile(`count=([0-9]+)`).FindStringSubmatch(command)
			if len(match) != 2 {
				t.Errorf("bootstrap command did not include payload length")
				return
			}
			wanted, _ := strconv.Atoi(match[1])
			connection, err := websocket.Accept(writer, request, nil)
			if err != nil {
				t.Errorf("accept websocket: %v", err)
				return
			}
			defer connection.CloseNow()
			netConnection := websocket.NetConn(context.Background(), connection, websocket.MessageBinary)
			defer netConnection.Close()
			decoder := json.NewDecoder(netConnection)
			var encoded strings.Builder
			for encoded.Len() < wanted {
				var request struct {
					Data string `json:"data"`
				}
				if err := decoder.Decode(&request); err != nil {
					t.Errorf("decode PTY input: %v", err)
					return
				}
				encoded.WriteString(request.Data)
			}
			archive, err := base64.StdEncoding.DecodeString(encoded.String())
			if err != nil {
				t.Errorf("decode archive: %v", err)
				return
			}
			archiveResult <- readArchive(t, archive)
			_, _ = io.WriteString(netConnection, bootstrapOK+"\r\n")
		default:
			http.Error(writer, "unexpected route", http.StatusNotFound)
		}
	}))
	defer server.Close()
	client := newTestClient(t, server.URL, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := client.BootstrapWorker(ctx, testWorkspaceID, sandbox.WorkerBootstrap{
		Binary: []byte("worker-binary"), Destination: "/usr/local/bin/ao-worker",
		HelperBinary: []byte("helper-binary"), HelperDestination: "/usr/local/bin/ao",
		User: "ao-worker", Environment: map[string]string{"AO_WORKER_TOKEN": secret},
	})
	if err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	files := <-archiveResult
	if files["ao-worker"] != "worker-binary" || files["ao"] != "helper-binary" {
		t.Fatalf("unexpected binaries in archive: %+v", files)
	}
	if !strings.Contains(files["worker.env"], secret) {
		t.Fatalf("worker environment missing from archive")
	}
}

func TestNewRejectsUnsafeConfiguration(t *testing.T) {
	t.Parallel()
	tests := []Config{
		{BaseURL: "https://user@example.com", Token: "token", Owner: "owner", TemplateID: testTemplateID},
		{BaseURL: "https://example.com/path", Token: "token", Owner: "owner", TemplateID: testTemplateID},
		{BaseURL: "https://example.com", Owner: "owner", TemplateID: testTemplateID},
		{BaseURL: "https://example.com", Token: "token", Owner: "owner", TemplateID: "not-a-uuid"},
	}
	for _, config := range tests {
		if _, err := New(config); err == nil {
			t.Fatalf("New(%+v) succeeded", config)
		}
	}
}

func TestGetTreatsDeletedWorkspaceAsNotFound(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		http.Error(writer, "deleted", http.StatusGone)
	}))
	defer server.Close()
	client := newTestClient(t, server.URL, nil)
	if _, err := client.Get(context.Background(), testWorkspaceID); !errors.Is(err, sandbox.ErrNotFound) {
		t.Fatalf("Get error = %v, want ErrNotFound", err)
	}
}

func newTestClient(t *testing.T, baseURL string, parameters map[string]string) *Client {
	t.Helper()
	client, err := New(Config{
		BaseURL: baseURL, Token: "test-token", Owner: "ao-integration",
		TemplateID: testTemplateID, Parameters: parameters,
	})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	return client
}

func writeWorkspace(t *testing.T, writer http.ResponseWriter, status, agentStatus string, healthy bool) {
	t.Helper()
	writer.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(writer).Encode(workspace{
		ID: testWorkspaceID, Name: "ao-test", OwnerName: "ao-integration", TemplateID: testTemplateID,
		Health: workspaceHealth{Healthy: healthy},
		LatestBuild: workspaceBuild{Status: status, Resources: []workspaceResource{{Agents: []workspaceAgent{{
			ID: testAgentID, Name: "dev", Status: agentStatus, Health: workspaceHealth{Healthy: healthy},
		}}}}},
	}); err != nil {
		t.Errorf("write workspace: %v", err)
	}
}

func readArchive(t *testing.T, compressed []byte) map[string]string {
	t.Helper()
	gzipReader, err := gzip.NewReader(strings.NewReader(string(compressed)))
	if err != nil {
		t.Fatalf("open gzip: %v", err)
	}
	defer gzipReader.Close()
	tape := tar.NewReader(gzipReader)
	files := map[string]string{}
	for {
		header, err := tape.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("read tar: %v", err)
		}
		contents, err := io.ReadAll(tape)
		if err != nil {
			t.Fatalf("read %s: %v", header.Name, err)
		}
		files[header.Name] = string(contents)
	}
	return files
}
