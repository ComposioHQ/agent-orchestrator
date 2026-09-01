package sandbox

import (
	"encoding/json"
	"testing"
	"time"
)

func TestNewCoderWorkspaceLayout(t *testing.T) {
	t.Parallel()
	layout, err := NewCoderWorkspaceLayout("/home/coder")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"repository":       "/home/coder/repository",
		"worker data":      "/home/coder/.ao/worker",
		"home":             "/home/coder/.ao/home",
		"Claude config":    "/home/coder/.ao/home/.claude",
		"Codex home":       "/home/coder/.ao/home/.codex",
		"durable identity": "/home/coder/.ao/durable-session-id",
	}
	got := map[string]string{
		"repository":       layout.Repository,
		"worker data":      layout.WorkerData,
		"home":             layout.Home,
		"Claude config":    layout.ClaudeConfig,
		"Codex home":       layout.CodexHome,
		"durable identity": layout.DurableIdentity,
	}
	for name, expected := range want {
		if got[name] != expected {
			t.Errorf("%s = %q, want %q", name, got[name], expected)
		}
	}
}

func TestCoderConfigRejectsUnsafeDurableRoot(t *testing.T) {
	t.Parallel()
	for _, root := range []string{"", "/", "relative", "/home/coder/../workspace", "/home/coder\nother"} {
		root := root
		t.Run(root, func(t *testing.T) {
			t.Parallel()
			config := CoderConfig{
				BaseURL: "https://coder.example.com", Owner: "owner", TemplateID: "template",
				DurableRoot: root, WorkerTokenTTL: time.Minute,
			}
			if err := config.Validate(); err == nil {
				t.Fatal("Validate succeeded")
			}
		})
	}
}

func TestCoderSessionPlanPersistsDurableRoot(t *testing.T) {
	t.Parallel()
	plan, err := (ProvisioningDefaults{
		Provider: ProviderCoder,
		Coder: CoderConfig{
			BaseURL: "https://coder.example.com", Owner: "owner", TemplateID: "template",
			DurableRoot: "/persistent/ao", WorkerTokenTTL: time.Minute,
		},
	}).SessionPlan("codex")
	if err != nil {
		t.Fatal(err)
	}
	for name, raw := range map[string]json.RawMessage{
		"resource profile":  plan.ResourceProfile,
		"bootstrap context": plan.BootstrapContext,
	} {
		var decoded struct {
			Coder struct {
				DurableRoot string `json:"durableRoot"`
			} `json:"coder"`
		}
		if err := json.Unmarshal(raw, &decoded); err != nil {
			t.Fatalf("decode %s: %v", name, err)
		}
		if decoded.Coder.DurableRoot != "/persistent/ao" {
			t.Errorf("%s durable root = %q", name, decoded.Coder.DurableRoot)
		}
	}
}
