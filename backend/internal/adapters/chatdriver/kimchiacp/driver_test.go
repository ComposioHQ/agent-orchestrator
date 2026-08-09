package kimchiacp

import (
	"reflect"
	"testing"

	acpdriver "github.com/aoagents/agent-orchestrator/backend/internal/adapters/chatdriver/acp"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestConfigureReturnsACPMode(t *testing.T) {
	args, env, err := configure(acpdriver.LaunchConfig{})
	if err != nil {
		t.Fatalf("configure: %v", err)
	}
	want := []string{"--mode", "acp"}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("args = %#v, want %#v", args, want)
	}
	if env != nil {
		t.Fatalf("env = %#v, want nil", env)
	}
}

func TestConfigureAppendsSystemPromptWhenProvided(t *testing.T) {
	args, _, err := configure(acpdriver.LaunchConfig{SystemPrompt: "Follow AO worker rules."})
	if err != nil {
		t.Fatalf("configure: %v", err)
	}
	want := []string{"--mode", "acp", "--append-system-prompt", "Follow AO worker rules."}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("args = %#v, want %#v", args, want)
	}
}

func TestConfigureOmitsBlankSystemPrompt(t *testing.T) {
	args, _, err := configure(acpdriver.LaunchConfig{SystemPrompt: "   "})
	if err != nil {
		t.Fatalf("configure: %v", err)
	}
	want := []string{"--mode", "acp"}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("args = %#v, want %#v", args, want)
	}
}

func TestSessionModeMapsPermissionVocabulary(t *testing.T) {
	tests := map[ports.PermissionMode]string{
		ports.PermissionModeDefault:           "",
		ports.PermissionModeAcceptEdits:       "auto",
		ports.PermissionModeAuto:              "auto",
		ports.PermissionModeBypassPermissions: "yolo",
	}
	for permission, want := range tests {
		if got := sessionMode(permission); got != want {
			t.Errorf("mode(%q) = %q, want %q", permission, got, want)
		}
	}
}

func TestSessionOptionsUseModelConfigOption(t *testing.T) {
	if got := sessionOptions(ports.ChatTurnSettings{}); got != nil {
		t.Fatalf("empty settings = %#v", got)
	}
	got := sessionOptions(ports.ChatTurnSettings{Model: "glm-5.2"})
	want := []acpdriver.SessionOption{{ID: "model", Value: "glm-5.2"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("options = %#v, want %#v", got, want)
	}
}
