package coder

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/cloud/internal/sandbox"
	"github.com/coder/websocket"
	"github.com/google/uuid"
)

// TestLiveLifecycle exercises the real Coder API and template persistence when
// explicitly configured. It is skipped in ordinary and CI test runs and always
// requests workspace deletion before returning.
func TestLiveLifecycle(t *testing.T) {
	baseURL := os.Getenv("CODER_LIVE_URL")
	if baseURL == "" {
		t.Skip("CODER_LIVE_URL is not set")
	}
	durableRoot := os.Getenv("CODER_LIVE_DURABLE_ROOT")
	if durableRoot == "" {
		t.Fatal("CODER_LIVE_DURABLE_ROOT is required for the stop/start persistence test")
	}
	parameters := map[string]string{}
	if raw := os.Getenv("CODER_LIVE_PARAMETERS_JSON"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &parameters); err != nil {
			t.Fatalf("decode CODER_LIVE_PARAMETERS_JSON: %v", err)
		}
	}
	client, err := New(Config{
		BaseURL: baseURL, Token: os.Getenv("CODER_LIVE_TOKEN"),
		Owner: os.Getenv("CODER_LIVE_OWNER"), TemplateID: os.Getenv("CODER_LIVE_TEMPLATE_ID"),
		AgentName: os.Getenv("CODER_LIVE_AGENT_NAME"), Parameters: parameters,
	})
	if err != nil {
		t.Fatalf("new live client: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
	defer cancel()
	sessionID := "live-" + uuid.NewString()
	environment, err := client.Create(ctx, sandbox.Spec{SessionID: sessionID})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	t.Logf("created workspace %s", environment.ID)
	deleted := false
	defer func() {
		if !deleted {
			cleanupContext, cleanupCancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cleanupCancel()
			if cleanupErr := client.Delete(cleanupContext, environment.ID); cleanupErr != nil {
				t.Errorf("cleanup workspace %s: %v", environment.ID, cleanupErr)
			}
		}
	}()

	environment = waitForState(t, ctx, client, environment.ID, sandbox.StateRunning)
	if environment.Target == "" {
		t.Fatal("running workspace carried no healthy agent target")
	}
	if err := client.BootstrapWorker(ctx, environment.ID, sandbox.WorkerBootstrap{
		Binary:      []byte("#!/bin/sh\nset -eu\necho live > \"$AO_WORKSPACE_DIR/uncommitted.txt\"\nmkdir -p \"$CLAUDE_CONFIG_DIR/projects/live\" \"$CODEX_HOME/sessions\"\necho '{}' > \"$CLAUDE_CONFIG_DIR/projects/live/conversation.jsonl\"\necho state > \"$CODEX_HOME/sessions/thread.jsonl\"\nsleep 300\n"),
		Destination: "/usr/local/bin/ao-worker", User: "ao-worker",
		Environment: map[string]string{
			"AO_CODER_LIVE_TEST": "true",
			"AO_WORKSPACE_DIR":   durableRoot + "/repository",
			"CLAUDE_CONFIG_DIR":  durableRoot + "/.ao/home/.claude",
			"CODEX_HOME":         durableRoot + "/.ao/home/.codex",
		},
		DurableRoot: durableRoot, DurableIdentity: sessionID,
	}); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	assertLiveDurableState(t, ctx, client, environment.Target, durableRoot)
	if err := client.Stop(ctx, environment.ID); err != nil {
		t.Fatalf("stop: %v", err)
	}
	waitForState(t, ctx, client, environment.ID, sandbox.StateStopped)
	if err := client.Start(ctx, environment.ID); err != nil {
		t.Fatalf("start: %v", err)
	}
	environment = waitForState(t, ctx, client, environment.ID, sandbox.StateRunning)
	assertLiveDurableState(t, ctx, client, environment.Target, durableRoot)
	// A restore bootstrap requires the marker written before Stop. If the
	// template recreated its filesystem, bootstrap fails before starting a new
	// worker and the live test catches the persistence contract violation.
	if err := client.BootstrapWorker(ctx, environment.ID, sandbox.WorkerBootstrap{
		Binary:      []byte("#!/bin/sh\nsleep 300\n"),
		Destination: "/usr/local/bin/ao-worker", User: "ao-worker",
		Environment: map[string]string{"AO_CODER_LIVE_TEST": "restored"},
		DurableRoot: durableRoot, DurableIdentity: sessionID,
		RequireDurableIdentity: true,
	}); err != nil {
		t.Fatalf("restore bootstrap did not find durable session identity: %v", err)
	}
	if err := client.Delete(ctx, environment.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	waitForDeleted(t, ctx, client, environment.ID)
	deleted = true
}

func assertLiveDurableState(
	t *testing.T,
	ctx context.Context,
	client *Client,
	agentID string,
	durableRoot string,
) {
	t.Helper()
	checks := []struct {
		path    string
		content string
	}{
		{path.Join(durableRoot, "repository", "uncommitted.txt"), "live"},
		{path.Join(durableRoot, ".ao", "home", ".claude", "projects", "live", "conversation.jsonl"), "{}"},
		{path.Join(durableRoot, ".ao", "home", ".codex", "sessions", "thread.jsonl"), "state"},
	}
	var condition strings.Builder
	for index, check := range checks {
		if index > 0 {
			condition.WriteString(" && ")
		}
		condition.WriteString("[ -f ")
		condition.WriteString(shellQuote(check.path))
		condition.WriteString(" ] && [ \"$(cat ")
		condition.WriteString(shellQuote(check.path))
		condition.WriteString(")\" = ")
		condition.WriteString(shellQuote(check.content))
		condition.WriteString(" ]")
	}
	script := "set -u\nattempt=0\nwhile [ $attempt -lt 30 ]; do\n" +
		"  if " + condition.String() + "; then echo " + bootstrapOK + "; exit 0; fi\n" +
		"  attempt=$((attempt + 1))\n  sleep 1\ndone\nexit 1\n"
	ptyURL, err := url.Parse(client.baseURL + "/api/v2/workspaceagents/" + url.PathEscape(agentID) + "/pty")
	if err != nil {
		t.Fatalf("build persistence probe URL: %v", err)
	}
	query := ptyURL.Query()
	query.Set("width", "120")
	query.Set("height", "40")
	query.Set("backend_type", "buffered")
	query.Set("command", "sh -lc "+shellQuote(script))
	ptyURL.RawQuery = query.Encode()
	connection, response, err := websocket.Dial(ctx, ptyURL.String(), &websocket.DialOptions{
		HTTPClient: client.http,
		HTTPHeader: http.Header{"Coder-Session-Token": []string{client.token}},
	})
	if err != nil {
		if response != nil {
			_ = response.Body.Close()
		}
		t.Fatalf("open persistence probe PTY: %v", err)
	}
	defer connection.CloseNow()
	netConnection := websocket.NetConn(context.Background(), connection, websocket.MessageBinary)
	defer netConnection.Close()
	output, err := readBootstrapResult(ctx, streamPTYOutput(netConnection))
	if err != nil || !strings.Contains(output, bootstrapOK) {
		t.Fatalf("durable repository/harness state did not survive stop/start: %s: %v", sanitizePTYOutput(output), err)
	}
	t.Logf("verified %d durable files after Coder stop/start", len(checks))
}

func waitForState(t *testing.T, ctx context.Context, client *Client, id sandbox.ID, state string) sandbox.Environment {
	t.Helper()
	for {
		environment, err := client.Get(ctx, id)
		if err != nil {
			t.Fatalf("get workspace while waiting for %s: %v", state, err)
		}
		if environment.State == state {
			return environment
		}
		select {
		case <-ctx.Done():
			t.Fatalf("wait for workspace %s: %v", state, ctx.Err())
		case <-time.After(5 * time.Second):
		}
	}
}

func waitForDeleted(t *testing.T, ctx context.Context, client *Client, id sandbox.ID) {
	t.Helper()
	for {
		environment, err := client.Get(ctx, id)
		if errors.Is(err, sandbox.ErrNotFound) || (err == nil && environment.State == sandbox.StateDeleted) {
			return
		}
		if err != nil {
			t.Fatalf("get workspace while waiting for deletion: %v", err)
		}
		select {
		case <-ctx.Done():
			t.Fatalf("wait for workspace deletion: %v", ctx.Err())
		case <-time.After(5 * time.Second):
		}
	}
}
