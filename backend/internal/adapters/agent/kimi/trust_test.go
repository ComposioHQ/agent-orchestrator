package kimi

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestPreLaunchSeedsWorkspaceTrust(t *testing.T) {
	dataDir := t.TempDir()
	workspace := filepath.Join(t.TempDir(), "agent-orchestrator-351")

	p := &Plugin{}
	if err := p.PreLaunch(context.Background(), ports.LaunchConfig{
		DataDir:       dataDir,
		SessionID:     "agent-orchestrator-351",
		WorkspacePath: workspace,
	}); err != nil {
		t.Fatalf("PreLaunch: %v", err)
	}

	trustPath := filepath.Join(kimiCodeHomeDir(dataDir), kimiTrustDirName, kimiWorkdirKey(workspace))
	data, err := os.ReadFile(trustPath)
	if err != nil {
		t.Fatalf("read trust record: %v", err)
	}
	var trust kimiWorkspaceTrust
	if err := json.Unmarshal(data, &trust); err != nil {
		t.Fatalf("decode trust record: %v", err)
	}
	if trust.Root != workspace {
		t.Fatalf("root = %q, want %q", trust.Root, workspace)
	}
	if trust.TrustedAt <= 0 {
		t.Fatalf("trustedAt = %d, want positive unix ms", trust.TrustedAt)
	}
}

func TestPreLaunchIsIdempotentAndPreservesExistingTrust(t *testing.T) {
	dataDir := t.TempDir()
	workspace := filepath.Join(t.TempDir(), "ws")

	trustPath := filepath.Join(kimiCodeHomeDir(dataDir), kimiTrustDirName, kimiWorkdirKey(workspace))
	if err := os.MkdirAll(filepath.Dir(trustPath), 0o750); err != nil {
		t.Fatal(err)
	}
	existing := []byte(`{"root":"` + workspace + `","trustedAt":1786358959999}`)
	if err := os.WriteFile(trustPath, existing, 0o600); err != nil {
		t.Fatal(err)
	}

	p := &Plugin{}
	for i := 0; i < 2; i++ {
		if err := p.PreLaunch(context.Background(), ports.LaunchConfig{
			DataDir:       dataDir,
			SessionID:     "s-1",
			WorkspacePath: workspace,
		}); err != nil {
			t.Fatalf("PreLaunch: %v", err)
		}
	}
	data, err := os.ReadFile(trustPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != string(existing) {
		t.Fatalf("trust record rewritten: got %s, want %s", data, existing)
	}
}

func TestPreLaunchSkipsBlankInputs(t *testing.T) {
	p := &Plugin{}
	if err := p.PreLaunch(context.Background(), ports.LaunchConfig{}); err != nil {
		t.Fatalf("empty config: %v", err)
	}
	if err := p.PreLaunch(context.Background(), ports.LaunchConfig{
		DataDir:   t.TempDir(),
		SessionID: "s-1",
	}); err != nil {
		t.Fatalf("blank workspace: %v", err)
	}
}

func TestKimiWorkdirKeyMatchesKimiCodeLayout(t *testing.T) {
	// Vectors captured from Kimi Code 0.34.0 trust records on this machine.
	cases := []struct {
		workspace string
		want      string
	}{
		{
			workspace: "/Users/nikhilachale/.ao/dev/data/worktrees/agent-orchestrator/agent-orchestrator-346",
			want:      "wd_agent-orchestrator-346_82331d819f35",
		},
		{
			workspace: "/Users/nikhilachale/.ao/dev/data/worktrees/agent-orchestrator/agent-orchestrator-350",
			want:      "wd_agent-orchestrator-350_2ca3feb01d85",
		},
	}
	for _, tc := range cases {
		if got := kimiWorkdirKey(tc.workspace); got != tc.want {
			t.Errorf("kimiWorkdirKey(%q) = %q, want %q", tc.workspace, got, tc.want)
		}
	}
}

func TestKimiWorkdirSlug(t *testing.T) {
	cases := []struct {
		name string
		want string
	}{
		{name: "agent-orchestrator-351", want: "agent-orchestrator-351"},
		{name: "My Project!", want: "my-project"},
		{name: "--lead-trail--", want: "lead-trail"},
		{name: "", want: "workspace"},
		{name: ".", want: "workspace"},
		{name: "..", want: "workspace"},
		{name: "a-very-long-worktree-name-that-keeps-going-past-forty-chars", want: "a-very-long-worktree-name-that-keeps-goi"},
	}
	for _, tc := range cases {
		if got := kimiWorkdirSlug(tc.name); got != tc.want {
			t.Errorf("kimiWorkdirSlug(%q) = %q, want %q", tc.name, got, tc.want)
		}
	}
}
