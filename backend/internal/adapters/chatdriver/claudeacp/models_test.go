package claudeacp

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestModelDiscoveryRunnerMapsSDKCatalog(t *testing.T) {
	wantLaunch := runtimeLaunch{command: "/runtime/node/bin/node", args: []string{"/runtime/claude-model-catalog.mjs"}}
	request := ports.AgentModelDiscoveryRequest{
		AgentID: "claude-code", Binary: "/opt/claude", WorkingDir: "/work/project",
		Env: map[string]string{"CLAUDE_CONFIG_DIR": "/config"},
	}
	var gotLaunch runtimeLaunch
	var gotRequest ports.AgentModelDiscoveryRequest
	runner := modelDiscoveryRunner{
		resolve: func(context.Context) (runtimeLaunch, error) { return wantLaunch, nil },
		run: func(_ context.Context, launch runtimeLaunch, req ports.AgentModelDiscoveryRequest) ([]byte, error) {
			gotLaunch = launch
			gotRequest = req
			return []byte(`{"version":1,"models":[{"value":"sonnet","displayName":"Sonnet","description":"Balanced"},{"value":"opus","displayName":"Opus"}]}`), nil
		},
	}

	got, err := runner.discover(context.Background(), request)
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	want := []ports.AgentModelInfo{
		{ID: "sonnet", Label: "Sonnet"},
		{ID: "opus", Label: "Opus"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("models = %#v, want %#v", got, want)
	}
	if !reflect.DeepEqual(gotLaunch, wantLaunch) || !reflect.DeepEqual(gotRequest, request) {
		t.Fatalf("run inputs = %#v %#v", gotLaunch, gotRequest)
	}
}

func TestModelDiscoveryRunnerRejectsUnsupportedResponseVersion(t *testing.T) {
	runner := modelDiscoveryRunner{
		resolve: func(context.Context) (runtimeLaunch, error) { return runtimeLaunch{}, nil },
		run: func(context.Context, runtimeLaunch, ports.AgentModelDiscoveryRequest) ([]byte, error) {
			return []byte(`{"version":2,"models":[]}`), nil
		},
	}
	if _, err := runner.discover(context.Background(), ports.AgentModelDiscoveryRequest{}); err == nil {
		t.Fatal("discover accepted an unsupported response version")
	}
}

func TestModelDiscoveryRunnerClosesOverExecutionFailure(t *testing.T) {
	runner := modelDiscoveryRunner{
		resolve: func(context.Context) (runtimeLaunch, error) { return runtimeLaunch{}, nil },
		run: func(context.Context, runtimeLaunch, ports.AgentModelDiscoveryRequest) ([]byte, error) {
			return nil, errors.New("sdk unavailable")
		},
	}
	if _, err := runner.discover(context.Background(), ports.AgentModelDiscoveryRequest{}); err == nil {
		t.Fatal("discover swallowed the SDK failure")
	}
}
