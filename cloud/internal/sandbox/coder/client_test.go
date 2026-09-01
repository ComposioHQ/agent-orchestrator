package coder

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
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
			Agents: []workspaceAgent{{
				ID: testAgentID, Status: "connecting", LifecycleState: "starting",
				Health: workspaceHealth{Healthy: true},
			}},
		}}},
	}
	if environment := client.toEnvironment(view); environment.State != sandbox.StateProvisioning {
		t.Fatalf("state = %q, want provisioning", environment.State)
	}
}

func TestRunningBuildWaitsForAgentStartupScript(t *testing.T) {
	t.Parallel()
	client := &Client{}
	view := workspace{
		ID: testWorkspaceID, Name: "ao-test", Health: workspaceHealth{Healthy: true},
		LatestBuild: workspaceBuild{Status: "running", Resources: []workspaceResource{{
			Agents: []workspaceAgent{{
				ID: testAgentID, Status: "connected", LifecycleState: "starting",
				Health: workspaceHealth{Healthy: true},
			}},
		}}},
	}
	if environment := client.toEnvironment(view); environment.State != sandbox.StateProvisioning {
		t.Fatalf("state = %q, want provisioning", environment.State)
	}
	view.LatestBuild.Resources[0].Agents[0].LifecycleState = "ready"
	if environment := client.toEnvironment(view); environment.State != sandbox.StateRunning {
		t.Fatalf("ready state = %q, want running", environment.State)
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
			if got := request.URL.Query().Get("backend_type"); got != "buffered" {
				t.Errorf("PTY backend_type = %q, want buffered", got)
			}
			command := request.URL.Query().Get("command")
			match := regexp.MustCompile(`target=([0-9]+)`).FindStringSubmatch(command)
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
			expectedSequence := 0
			truncatedFirstCopy := false
			for {
				var request struct {
					Data string `json:"data"`
				}
				if err := decoder.Decode(&request); err != nil {
					t.Errorf("decode PTY input: %v", err)
					return
				}
				if !truncatedFirstCopy && strings.HasPrefix(request.Data, "data:0:") {
					request.Data = strings.TrimSuffix(request.Data, "\n")
					request.Data = request.Data[:len(request.Data)-1] + "\n"
					truncatedFirstCopy = true
					_, _ = io.WriteString(netConnection, "ignored incomplete frame\r\n")
				}
				parts := strings.SplitN(strings.TrimSuffix(request.Data, "\n"), ":", 4)
				if len(parts) != 4 {
					continue
				}
				sequence, sequenceErr := strconv.Atoi(parts[1])
				declared, declaredErr := strconv.Atoi(parts[2])
				if parts[0] == "data" && sequenceErr == nil && declaredErr == nil &&
					sequence == expectedSequence && len(parts[3]) == declared {
					encoded.WriteString(parts[3])
					expectedSequence++
					_, _ = io.WriteString(netConnection, fmt.Sprintf("%s:%d\r\n", bootstrapUploadACK, expectedSequence))
				}
				if parts[0] == "done" && encoded.Len() == wanted {
					_, _ = io.WriteString(netConnection, bootstrapUploadDone+"\r\n")
					break
				}
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
	bootstrapResult := make(chan error, 1)
	go func() {
		bootstrapResult <- client.BootstrapWorker(ctx, testWorkspaceID, sandbox.WorkerBootstrap{
			Binary: []byte("worker-binary"), Destination: "/usr/local/bin/ao-worker",
			HelperBinary: []byte("helper-binary"), HelperDestination: "/usr/local/bin/ao",
			User: "ao-worker", Environment: map[string]string{"AO_WORKER_TOKEN": secret},
		})
	}()
	var files map[string]string
	select {
	case files = <-archiveResult:
	case <-ctx.Done():
		t.Fatalf("receive bootstrap archive: %v", ctx.Err())
	}
	if files["ao-worker"] != "worker-binary" || files["ao"] != "helper-binary" {
		t.Fatalf("unexpected binaries in archive: %+v", files)
	}
	if !strings.Contains(files["worker.env"], secret) {
		t.Fatalf("worker environment missing from archive")
	}
	if err := <-bootstrapResult; err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
}

func TestBootstrapWorkerPropagatesPostUploadFailure(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/api/v2/workspaces/" + testWorkspaceID:
			writeWorkspace(t, writer, "running", "connected", true)
		case "/api/v2/workspaceagents/" + testAgentID + "/pty":
			serveBootstrapPTY(t, writer, request, func(_ *websocket.Conn, output io.Writer) {
				_, _ = io.WriteString(output, bootstrapFailed+":23\r\n")
			})
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
		User: "ao-worker",
	})
	if err == nil || !strings.Contains(err.Error(), bootstrapFailed+":23") {
		t.Fatalf("bootstrap error = %v, want post-upload failure", err)
	}
}

func TestBootstrapThroughPTYRejectsPrematureClose(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		serveBootstrapPTY(t, writer, request, func(connection *websocket.Conn, _ io.Writer) {
			_ = connection.Close(websocket.StatusNormalClosure, "")
		})
	}))
	defer server.Close()
	client := newTestClient(t, server.URL, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	err := client.bootstrapThroughPTY(ctx, mustParseURL(t, server.URL+"/pty"), "payload")
	if err == nil || !strings.Contains(err.Error(), "read workspace PTY") {
		t.Fatalf("bootstrap error = %v, want premature-close error", err)
	}
}

func TestBootstrapThroughPTYCancellationStopsOutput(t *testing.T) {
	t.Parallel()

	uploaded := make(chan struct{})
	releaseServer := make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(releaseServer) }) }
	defer release()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		serveBootstrapPTY(t, writer, request, func(_ *websocket.Conn, _ io.Writer) {
			close(uploaded)
			<-releaseServer
		})
	}))
	defer server.Close()
	client := newTestClient(t, server.URL, nil)
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		result <- client.bootstrapThroughPTY(ctx, mustParseURL(t, server.URL+"/pty"), "payload")
	}()
	select {
	case <-uploaded:
	case <-time.After(5 * time.Second):
		t.Fatal("bootstrap upload did not complete")
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("bootstrap error = %v, want context canceled", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("bootstrap did not return after cancellation")
	}
	release()
}

func TestStreamPTYOutputCancellationDoesNotBlock(t *testing.T) {
	t.Parallel()

	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	ctx, cancel := context.WithCancel(context.Background())
	_, done := streamPTYOutput(ctx, reader)
	written := make(chan struct{})
	go func() {
		_, _ = io.WriteString(writer, "unconsumed output\n")
		close(written)
	}()
	select {
	case <-written:
	case <-time.After(5 * time.Second):
		t.Fatal("PTY reader did not consume output")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("PTY output goroutine blocked after cancellation")
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
			ID: testAgentID, Name: "dev", Status: agentStatus, LifecycleState: "ready",
			Health: workspaceHealth{Healthy: healthy},
		}}}}},
	}); err != nil {
		t.Errorf("write workspace: %v", err)
	}
}

func serveBootstrapPTY(
	t *testing.T,
	writer http.ResponseWriter,
	request *http.Request,
	afterUpload func(*websocket.Conn, io.Writer),
) {
	t.Helper()
	connection, err := websocket.Accept(writer, request, nil)
	if err != nil {
		t.Errorf("accept websocket: %v", err)
		return
	}
	defer connection.CloseNow()
	netConnection := websocket.NetConn(context.Background(), connection, websocket.MessageBinary)
	defer netConnection.Close()
	decoder := json.NewDecoder(netConnection)
	expectedSequence := 0
	for {
		var input struct {
			Data string `json:"data"`
		}
		if err := decoder.Decode(&input); err != nil {
			t.Errorf("decode PTY input: %v", err)
			return
		}
		parts := strings.SplitN(strings.TrimSuffix(input.Data, "\n"), ":", 4)
		if len(parts) != 4 {
			continue
		}
		sequence, sequenceErr := strconv.Atoi(parts[1])
		declared, declaredErr := strconv.Atoi(parts[2])
		if sequenceErr != nil || declaredErr != nil {
			continue
		}
		if parts[0] == "data" && sequence == expectedSequence && len(parts[3]) == declared {
			expectedSequence++
			if _, err := io.WriteString(netConnection,
				fmt.Sprintf("%s:%d\r\n", bootstrapUploadACK, expectedSequence)); err != nil {
				t.Errorf("write upload acknowledgement: %v", err)
				return
			}
			continue
		}
		if parts[0] == "done" && sequence == expectedSequence && declared == 0 {
			if _, err := io.WriteString(netConnection, bootstrapUploadDone+"\r\n"); err != nil {
				t.Errorf("write upload completion: %v", err)
				return
			}
			afterUpload(connection, netConnection)
			return
		}
	}
}

func mustParseURL(t *testing.T, value string) *url.URL {
	t.Helper()
	parsed, err := url.Parse(value)
	if err != nil {
		t.Fatalf("parse URL: %v", err)
	}
	return parsed
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
