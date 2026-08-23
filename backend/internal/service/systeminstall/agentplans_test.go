package systeminstall

import (
	"context"
	"strings"
	"testing"
)

func TestAgentPlansCoverEveryHarnessOnce(t *testing.T) {
	s := newTestService("darwin", "npm", "brew", "curl", "bash", "sh", "bun", "uv", "python3")
	plans, err := s.AgentPlans(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(plans) != 27 {
		t.Fatalf("got %d plans, want 27", len(plans))
	}
	seen := make(map[string]bool, len(plans))
	for _, plan := range plans {
		if seen[plan.AgentID] {
			t.Fatalf("duplicate plan for %q", plan.AgentID)
		}
		seen[plan.AgentID] = true
		if plan.DocumentationURL == "" {
			t.Fatalf("plan %q has no documentation URL", plan.AgentID)
		}
		if plan.Available && (!plan.Automatic || plan.Command == "" || plan.Method == "") {
			t.Fatalf("available plan %q is incomplete: %+v", plan.AgentID, plan)
		}
	}
}

func TestAgentPlanSelectsAvailableFallback(t *testing.T) {
	tests := []struct {
		name        string
		goos        string
		target      Target
		found       []string
		wantMethod  string
		wantCommand string
	}{
		{"claude brew", "darwin", TargetClaudeCode, []string{"brew"}, "homebrew", "brew install --cask claude-code"},
		{"codex npm", "linux", TargetCodex, []string{"npm"}, "npm", "npm install -g @openai/codex"},
		{"copilot winget", "windows", TargetCopilot, []string{"winget", "npm"}, "winget", "winget install -e --id GitHub.Copilot"},
		{"vibe python", "linux", TargetVibe, []string{"python3"}, "pip", "python3 -m pip install mistral-vibe"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			plan := newTestService(tt.goos, tt.found...).planAgent(tt.target)
			if plan.Unsupported || plan.Method != tt.wantMethod || strings.Join(plan.Command, " ") != tt.wantCommand {
				t.Fatalf("plan = %+v, want method %q command %q", plan, tt.wantMethod, tt.wantCommand)
			}
		})
	}
}

func TestAgentTargetsAreValidButPrerequisitesAreNotHarnessRows(t *testing.T) {
	for _, target := range agentTargets {
		if !Valid(target) || !IsAgentTarget(target) {
			t.Fatalf("agent target %q is not accepted by both allowlists", target)
		}
	}
	for _, target := range []Target{TargetTmux, TargetGH, TargetClaude} {
		if !Valid(target) || IsAgentTarget(target) {
			t.Fatalf("prerequisite target %q was classified incorrectly", target)
		}
	}
}
