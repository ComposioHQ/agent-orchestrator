package agyjson

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestInstallChatHooksPreservesUserDefinitions(t *testing.T) {
	workspace := t.TempDir()
	hooksDir := filepath.Join(workspace, ".agents")
	if err := os.MkdirAll(hooksDir, 0o750); err != nil {
		t.Fatal(err)
	}
	hooksPath := filepath.Join(hooksDir, "hooks.json")
	if err := os.WriteFile(hooksPath, []byte(`{"user-hook":{"Stop":[{"type":"command","command":"echo done"}]}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := installChatHooks(workspace); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(hooksPath)
	if err != nil {
		t.Fatal(err)
	}
	var file hookFile
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatal(err)
	}
	if _, ok := file["user-hook"]; !ok {
		t.Fatal("existing user hook was removed")
	}
	raw, ok := file[managedHookName]
	if !ok {
		t.Fatalf("managed hook %q missing", managedHookName)
	}
	var definition hookDefinition
	if err := json.Unmarshal(raw, &definition); err != nil {
		t.Fatal(err)
	}
	if len(definition.PreInvocation) != 1 || definition.PreInvocation[0].Command != hookCommandPrefix+"pre-invocation" {
		t.Fatalf("unexpected PreInvocation hooks: %#v", definition.PreInvocation)
	}
	if len(definition.PreToolUse) != 1 || definition.PreToolUse[0].Matcher != "*" || len(definition.PreToolUse[0].Hooks) != 1 || definition.PreToolUse[0].Hooks[0].Command != hookCommandPrefix+"pre-tool-use" {
		t.Fatalf("unexpected PreToolUse hooks: %#v", definition.PreToolUse)
	}
}

func TestPreInvocationPersistsProviderIDAndInjectsSystemPrompt(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := &conversation{
		ctx:          ctx,
		cancel:       cancel,
		hookToken:    "secret",
		systemPrompt: "follow AO rules",
		events:       make(chan ports.ChatEvent, 4),
		deferred:     map[string]ports.ChatUserMessage{},
		approvals:    map[string]chan ports.ChatDecision{},
	}
	persisted := ""
	response, err := c.HandleAgyChatHook(
		context.Background(),
		"pre-invocation",
		"secret",
		[]byte(`{"conversationId":"native-123","invocationNum":0}`),
		func(id string) error { persisted = id; return nil },
	)
	if err != nil {
		t.Fatal(err)
	}
	if persisted != "native-123" || c.ProviderConversationID() != "native-123" {
		t.Fatalf("provider id not persisted: callback=%q conversation=%q", persisted, c.ProviderConversationID())
	}
	steps, ok := response["injectSteps"].([]map[string]string)
	if !ok || len(steps) != 1 || steps[0]["ephemeralMessage"] != "follow AO rules" {
		t.Fatalf("unexpected hook response: %#v", response)
	}
}

func TestPreToolUseApprovalRoundTrip(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := &conversation{
		ctx:         ctx,
		cancel:      cancel,
		hookToken:   "secret",
		events:      make(chan ports.ChatEvent, 4),
		deferred:    map[string]ports.ChatUserMessage{},
		approvals:   map[string]chan ports.ChatDecision{},
		permissions: ports.PermissionModeDefault,
		active:      &activeTurn{id: "agy-turn-1", permission: ports.PermissionModeDefault},
	}

	type result struct {
		response map[string]any
		err      error
	}
	resultCh := make(chan result, 1)
	go func() {
		response, err := c.HandleAgyChatHook(
			context.Background(),
			"pre-tool-use",
			"secret",
			[]byte(`{"conversationId":"native-123","stepIdx":2,"toolCall":{"name":"run_command","args":{"CommandLine":"git status"}}}`),
			nil,
		)
		resultCh <- result{response: response, err: err}
	}()

	select {
	case event := <-c.events:
		if event.Kind != ports.ChatEventApprovalRequested {
			t.Fatalf("event kind = %q, want approval_requested", event.Kind)
		}
		if err := c.ResolveRequest(context.Background(), event.RequestID, ports.ChatDecision{ID: "allow"}); err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("approval event was not emitted")
	}

	select {
	case got := <-resultCh:
		if got.err != nil {
			t.Fatal(got.err)
		}
		if got.response["decision"] != "allow" {
			t.Fatalf("decision = %#v, want allow", got.response)
		}
	case <-time.After(time.Second):
		t.Fatal("hook did not resume after approval")
	}
}

func TestSendTurnRejectsUnsupportedEffort(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := &conversation{
		ctx:       ctx,
		cancel:    cancel,
		events:    make(chan ports.ChatEvent, 1),
		deferred:  map[string]ports.ChatUserMessage{},
		approvals: map[string]chan ports.ChatDecision{},
	}
	_, err := c.SendTurn(context.Background(), ports.ChatUserMessage{
		Text:     "hello",
		Settings: ports.ChatTurnSettings{Effort: "high"},
	})
	if err == nil {
		t.Fatal("expected reasoning effort to be rejected")
	}
}
