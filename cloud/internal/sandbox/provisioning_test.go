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
	const templateID = "2a2e262c-b31c-4202-946d-a19ad45d1fd2"
	plan, err := (ProvisioningDefaults{
		Provider: ProviderCoder,
		Coder: CoderConfig{
			BaseURL: "https://coder.example.com", Owner: "owner", TemplateID: templateID,
			AgentName: "dev", Parameters: map[string]string{" region ": "us-west-2"},
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
				BaseURL     string `json:"baseUrl"`
				DurableRoot string `json:"durableRoot"`
			} `json:"coder"`
		}
		if err := json.Unmarshal(raw, &decoded); err != nil {
			t.Fatalf("decode %s: %v", name, err)
		}
		if decoded.Coder.DurableRoot != "/persistent/ao" {
			t.Errorf("%s durable root = %q", name, decoded.Coder.DurableRoot)
		}
		if name == "resource profile" && decoded.Coder.BaseURL != "https://coder.example.com" {
			t.Errorf("%s base URL = %q", name, decoded.Coder.BaseURL)
		}
	}
	profile, err := DecodeCoderSessionProfile(plan.ResourceProfile)
	if err != nil {
		t.Fatal(err)
	}
	if profile.BaseURL != "https://coder.example.com" ||
		profile.Owner != "owner" || profile.TemplateID != templateID ||
		profile.AgentName != "dev" || profile.Parameters["region"] != "us-west-2" ||
		profile.DurableRoot != "/persistent/ao" {
		t.Fatalf("unexpected durable profile: %+v", profile)
	}
}

func TestDecodeCoderSessionProfileRejectsIncompleteContract(t *testing.T) {
	t.Parallel()
	profiles := []json.RawMessage{
		nil,
		json.RawMessage(`{}`),
		json.RawMessage(`{"coder":{"owner":"owner","templateId":"template","durableRoot":"/mnt/ao"}}`),
		json.RawMessage(`{"coder":{"baseUrl":"https://coder.example.com","templateId":"template","durableRoot":"/mnt/ao"}}`),
		json.RawMessage(`{"coder":{"baseUrl":"https://coder.example.com","owner":"owner","durableRoot":"/mnt/ao"}}`),
		json.RawMessage(`{"coder":{"baseUrl":"https://coder.example.com","owner":"owner","templateId":"template"}}`),
		json.RawMessage(`{"coder":{"baseUrl":"https://coder.example.com/path","owner":"owner","templateId":"template","durableRoot":"/mnt/ao"}}`),
		json.RawMessage(`{"coder":{"baseUrl":"https://coder.example.com","owner":"owner","templateId":"template","durableRoot":"/mnt/ao","parameters":{"x":"one"," x ":"two"}}}`),
	}
	for index, raw := range profiles {
		if _, err := DecodeCoderSessionProfile(raw); err == nil {
			t.Errorf("profile %d unexpectedly decoded: %s", index, raw)
		}
	}
}
