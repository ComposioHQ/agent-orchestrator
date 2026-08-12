package worker

import (
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/pkg/contract"
)

func TestDeriveActivityUsesHarnessLifecycleEvents(t *testing.T) {
	tests := []struct {
		name    string
		harness string
		event   string
		payload string
		want    contract.ActivityState
		ok      bool
	}{
		{"claude submit", "claude-code", "user-prompt-submit", `{}`, contract.ActivityActive, true},
		{"claude tool", "claude-code", "pre-tool-use", `{}`, contract.ActivityActive, true},
		{"claude permission", "claude-code", "permission-request", `{}`, contract.ActivityBlocked, true},
		{"claude stop", "claude-code", "stop", `{}`, contract.ActivityIdle, true},
		{"claude input", "claude-code", "notification", `{"notification_type":"agent_needs_input"}`, contract.ActivityWaitingInput, true},
		{"claude clear", "claude-code", "session-end", `{"reason":"clear"}`, "", false},
		{"claude exit", "claude-code", "session-end", `{"reason":"logout"}`, contract.ActivityExited, true},
		{"codex submit", "codex", "user-prompt-submit", `{}`, contract.ActivityActive, true},
		{"codex permission", "codex", "permission-request", `{}`, contract.ActivityWaitingInput, true},
		{"codex stop", "codex", "stop", `{}`, contract.ActivityIdle, true},
		{"cursor start", "cursor", "session-start", `{}`, contract.ActivityActive, true},
		{"cursor stop", "cursor", "stop", `{}`, contract.ActivityIdle, true},
		{"unknown", "cursor", "other", `{}`, "", false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, ok := DeriveActivity(test.harness, test.event, []byte(test.payload))
			if got != test.want || ok != test.ok {
				t.Fatalf("activity = (%q, %v), want (%q, %v)", got, ok, test.want, test.ok)
			}
		})
	}
}

func TestValidActivityEventRejectsMismatchedState(t *testing.T) {
	if !ValidActivityEvent(ActivityEvent{
		Harness: "claude-code",
		Event:   "stop",
		State:   contract.ActivityIdle,
	}) {
		t.Fatal("valid Claude stop event was rejected")
	}
	if ValidActivityEvent(ActivityEvent{
		Harness: "claude-code",
		Event:   "stop",
		State:   contract.ActivityActive,
	}) {
		t.Fatal("mismatched Claude stop event was accepted")
	}
}

func TestActivityEventFromHookKeepsBoundedToolCorrelation(t *testing.T) {
	event, ok := ActivityEventFromHook(
		"claude-code",
		"permission-request",
		[]byte(`{"tool_name":"Bash","tool_use_id":"tool-1"}`),
	)
	if !ok {
		t.Fatal("permission request did not produce activity")
	}
	if event.ToolName != "Bash" || event.ToolUseID != "tool-1" {
		t.Fatalf("activity correlation = %#v", event)
	}
}

func TestActivityEventFromHookReportsMetadataOnlySessionStart(t *testing.T) {
	event, ok := ActivityEventFromHook(
		"claude-code",
		"session-start",
		[]byte(`{"session_id":"native-session-1"}`),
	)
	if !ok {
		t.Fatal("session start did not produce metadata event")
	}
	if event.State != "" || event.AgentSessionID != "native-session-1" {
		t.Fatalf("session start = %#v", event)
	}
	if !ValidActivityEvent(event) {
		t.Fatalf("session start was rejected: %#v", event)
	}
}
