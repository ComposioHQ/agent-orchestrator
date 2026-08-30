package systeminstall

import (
	"context"
	"errors"
	"strings"
	"testing"
)

type installCapabilitiesStub struct {
	prefix            string
	prefixErr         error
	homebrewPrefix    string
	homebrewErr       error
	homebrewInstalled bool
	writable          bool
}

func (s installCapabilitiesStub) NPMGlobalPrefix() (string, error) { return s.prefix, s.prefixErr }
func (s installCapabilitiesStub) HomebrewPrefix() (string, error) {
	if s.homebrewPrefix == "" && s.homebrewErr == nil {
		return "/opt/homebrew", nil
	}
	return s.homebrewPrefix, s.homebrewErr
}
func (s installCapabilitiesStub) HomebrewPackageInstalled(string, bool) bool {
	return s.homebrewInstalled
}
func (s installCapabilitiesStub) PathWritable(string) bool { return s.writable }

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
		{"copilot winget", "windows", TargetCopilot, []string{"winget", "npm"}, "winget", "winget install -e --id GitHub.Copilot --silent --accept-package-agreements --accept-source-agreements --disable-interactivity"},
		{"vibe pipx", "linux", TargetVibe, []string{"pipx"}, "pipx", "pipx install mistral-vibe"},
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

func TestAgentPlansNeverAutoExecuteRemoteScriptsOrSudo(t *testing.T) {
	s := newTestService(
		"darwin", "npm", "brew", "curl", "bash", "sh", "pwsh", "bun", "uv", "pipx",
	)
	for _, target := range agentTargets {
		plan := s.planAgent(target)
		command := strings.Join(plan.Command, " ")
		if strings.Contains(command, "sudo") {
			t.Errorf("%s command contains sudo: %q", target, command)
		}
		if strings.Contains(command, "curl") || strings.Contains(command, "irm ") || strings.Contains(command, "|") {
			t.Errorf("%s command executes a mutable remote script: %q", target, command)
		}
		if len(plan.Command) >= 2 && (plan.Command[1] == "-c" || plan.Command[1] == "-Command") {
			t.Errorf("%s command uses a shell evaluation boundary: %q", target, command)
		}
	}
}

func TestScriptOnlyHarnessesAreManual(t *testing.T) {
	s := newTestService("darwin", "curl", "bash", "sh", "pwsh")
	for _, target := range []Target{TargetCursor, TargetAider, TargetGrok, TargetKimi, TargetGoose, TargetDevin, TargetKiro, TargetMuse, TargetAgy, TargetPrimeAgent} {
		plan := s.planAgent(target)
		if !plan.Unsupported || plan.Method != "manual" || len(plan.Command) != 0 {
			t.Errorf("%s plan = %+v, want manual with no command", target, plan)
		}
		if plan.DocsURL == "" {
			t.Errorf("%s manual plan has no documentation URL", target)
		}
	}
}

func TestVibeRequiresIsolatedToolInstaller(t *testing.T) {
	for _, found := range [][]string{{"python3"}, {"python"}, {}} {
		plan := newTestService("linux", found...).planAgent(TargetVibe)
		if !plan.Unsupported || plan.Method != "pipx" {
			t.Errorf("found %v: plan = %+v, want unavailable isolated-tool plan", found, plan)
		}
	}
}

func TestNPMPlanRequiresWritableGlobalPrefix(t *testing.T) {
	tests := []struct {
		name       string
		caps       installCapabilitiesStub
		wantReason string
	}{
		{name: "prefix lookup fails", caps: installCapabilitiesStub{prefixErr: errors.New("npm failed")}, wantReason: "could not be resolved"},
		{name: "prefix not writable", caps: installCapabilitiesStub{prefix: "/usr/local", writable: false}, wantReason: "not writable"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := newTestService("darwin", "npm")
			s.installCapabilities = tt.caps
			plan := s.planAgent(TargetCodex)
			if !plan.Unsupported || !strings.Contains(plan.Reason, tt.wantReason) {
				t.Fatalf("plan = %+v, want unavailable reason containing %q", plan, tt.wantReason)
			}
		})
	}

	s := newTestService("darwin", "npm")
	s.installCapabilities = installCapabilitiesStub{prefix: "/Users/test/.npm", writable: true}
	plan := s.planAgent(TargetCodex)
	if plan.Unsupported || plan.ExpectedDestination != "/Users/test/.npm/bin" {
		t.Fatalf("plan = %+v, want writable npm destination", plan)
	}
}

func TestHomebrewPlanRequiresWritablePrefix(t *testing.T) {
	s := newTestService("darwin", "brew")
	s.installCapabilities = installCapabilitiesStub{homebrewPrefix: "/opt/homebrew", writable: false}
	plan := s.planBrew(TargetCodex, "codex")
	if !plan.Unsupported || !strings.Contains(plan.Reason, "not writable") {
		t.Fatalf("plan = %+v, want unavailable Homebrew writability reason", plan)
	}
}

func TestHomebrewPlanReinstallsAnExistingPackage(t *testing.T) {
	s := newTestService("darwin", "brew")
	s.installCapabilities = installCapabilitiesStub{homebrewPrefix: "/opt/homebrew", homebrewInstalled: true, writable: true}
	plan := s.planBrewCask(TargetCodex, "codex")
	if got := strings.Join(plan.Command, " "); got != "brew reinstall --cask codex" {
		t.Fatalf("command = %q, want an actual cask reinstall", got)
	}
}

func TestAgentPlansExposeEveryViableServerOwnedMethod(t *testing.T) {
	s := newTestService("darwin", "brew", "npm")
	s.installCapabilities = installCapabilitiesStub{prefix: "/Users/test/.npm", writable: true}
	plans, err := s.AgentPlans(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var codex AgentPlan
	for _, plan := range plans {
		if plan.AgentID == string(TargetCodex) {
			codex = plan
			break
		}
	}
	if len(codex.Methods) != 2 {
		t.Fatalf("codex methods = %+v, want homebrew and npm", codex.Methods)
	}
	if codex.Methods[0].ID != "homebrew" || !codex.Methods[0].Recommended || !codex.Methods[0].Available {
		t.Fatalf("first method = %+v, want recommended viable homebrew", codex.Methods[0])
	}
	if codex.Methods[1].ID != "npm" || codex.Methods[1].Recommended || !codex.Methods[1].Available {
		t.Fatalf("second method = %+v, want alternate viable npm", codex.Methods[1])
	}
	if strings.Contains(codex.Methods[0].Command, "curl") || strings.Contains(codex.Methods[1].Command, "curl") {
		t.Fatalf("codex methods include remote script execution: %+v", codex.Methods)
	}
}

func TestResolveAgentMethodRejectsUnknownOrUnavailableMethod(t *testing.T) {
	s := newTestService("darwin", "brew")
	if _, err := s.resolveAgentMethod(TargetCodex, "npm"); err == nil || !strings.Contains(err.Error(), "not available") {
		t.Fatalf("resolve npm error = %v, want unavailable", err)
	}
	if _, err := s.resolveAgentMethod(TargetCodex, "made-up"); err == nil || !strings.Contains(err.Error(), "unknown install method") {
		t.Fatalf("resolve made-up error = %v, want unknown method", err)
	}
	plan, err := s.resolveAgentMethod(TargetCodex, "homebrew")
	if err != nil || plan.Method != "homebrew" {
		t.Fatalf("resolve homebrew = %+v, %v", plan, err)
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
