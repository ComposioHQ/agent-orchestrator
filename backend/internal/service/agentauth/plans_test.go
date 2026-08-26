package agentauth

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestPlansMatchAuthenticationMatrix(t *testing.T) {
	t.Parallel()

	cases := []struct {
		id, title, executable, guidance, docs, initialInput string
		action                                              Action
		argv                                                []string
	}{
		{"claude-code", "Log in to Claude Code", "claude", "Native browser/device flow", "https://code.claude.com/docs/en/installation", "", ActionLogin, []string{"claude", "auth", "login"}},
		{"codex", "Log in to Codex", "codex", "Native browser/device-code flow", "https://github.com/openai/codex", "", ActionLogin, []string{"codex", "login"}},
		{"cursor", "Log in to Cursor", "cursor-agent", "Native browser flow", "https://docs.cursor.com/en/cli/installation", "", ActionLogin, []string{"cursor-agent", "login"}},
		{"opencode", "Log in to OpenCode", "opencode", "Native provider chooser", "https://github.com/anomalyco/opencode", "", ActionLogin, []string{"opencode", "auth", "login"}},
		{"aider", "Set up Aider", "aider", "Configure provider/API key in the native prompt; docs fallback", "https://aider.chat/docs/install.html", "", ActionSetup, []string{"aider"}},
		{"copilot", "Log in to GitHub Copilot", "copilot", "Native GitHub device/browser flow", "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli", "", ActionLogin, []string{"copilot", "login"}},
		{"grok", "Log in to Grok", "grok", "Native login; device-auth remains available inside the CLI", "https://docs.x.ai/build/overview", "", ActionLogin, []string{"grok", "login"}},
		{"kimi", "Log in to Kimi", "kimi", "Native browser flow", "https://moonshotai.github.io/kimi-code/en/", "", ActionLogin, []string{"kimi", "login"}},
		{"pi", "Log in to Pi", "pi", "Native Pi login flow", "https://github.com/earendil-works/pi", "/login\r", ActionLogin, []string{"pi"}},
		{"amp", "Log in to Amp", "amp", "Native browser flow", "https://ampcode.com/manual", "", ActionLogin, []string{"amp", "login"}},
		{"auggie", "Log in to Auggie", "auggie", "Native browser flow", "https://docs.augmentcode.com/cli/overview", "", ActionLogin, []string{"auggie", "login"}},
		{"droid", "Log in to Droid", "droid", "Native Droid login flow", "https://docs.factory.ai/droid-cli/cli-reference", "/login\r", ActionLogin, []string{"droid"}},
		{"crush", "Set up Crush", "crush", "Native provider picker", "https://github.com/charmbracelet/crush", "", ActionSetup, []string{"crush"}},
		{"cline", "Log in to Cline", "cline", "Native authentication flow", "https://github.com/cline/cline", "", ActionLogin, []string{"cline", "auth"}},
		{"goose", "Set up Goose", "goose", "Native provider configuration", "https://block.github.io/goose/index.html", "", ActionSetup, []string{"goose", "configure"}},
		{"qwen", "Log in to Qwen", "qwen", "Native Qwen authentication flow", "https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/", "/auth\r", ActionLogin, []string{"qwen"}},
		{"continue", "Log in to Continue", "cn", "Native browser flow", "https://docs.continue.dev/cli/quickstart", "", ActionLogin, []string{"cn", "login"}},
		{"devin", "", "", "Open official API-key/environment setup docs; AO stores no key", "https://docs.devin.ai/get-started/devin-intro", "", ActionInstructions, nil},
		{"kiro", "Log in to Kiro", "kiro-cli", "Native browser flow; device flow remains a CLI option", "https://kiro.dev/docs/getting-started/installation/", "", ActionLogin, []string{"kiro-cli", "login"}},
		{"kilocode", "Log in to Kilo Code", "kilo", "Native browser flow", "https://kilo.ai/docs/code-with-ai/platforms/cli", "", ActionLogin, []string{"kilo", "auth", "login"}},
		{"vibe", "Set up Vibe", "vibe", "Native provider setup", "https://github.com/mistralai/mistral-vibe", "", ActionSetup, []string{"vibe", "--setup"}},
		{"muse", "Log in to Muse", "muse", "Native login flow", "https://ai.meta.com/llama/", "", ActionLogin, []string{"muse", "login"}},
		{"agy", "Log in to Agy", "agy", "Native first-run browser sign-in", "https://github.com/google-antigravity/antigravity-cli", "", ActionLogin, []string{"agy"}},
		{"autohand", "Set up Autohand", "autohand", "Native first-run sign-in/settings", "https://docs.autohand.ai/working-with-autohand-code/cli", "", ActionSetup, []string{"autohand"}},
		{"kimchi", "Set up Kimchi", "kimchi", "Native setup; /login remains available in the CLI", "https://www.npmjs.com/package/@kimchi-dev/cli", "", ActionSetup, []string{"kimchi", "setup"}},
		{"prime-agent", "Log in to Prime Agent", "prime-agent", "Native Prime Agent login flow", "https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/quickstart.md", "/login\r", ActionLogin, []string{"prime-agent"}},
		{"omp", "Log in to OMP", "omp", "Native OMP login flow", "https://github.com/can1357/oh-my-pi", "/login\r", ActionLogin, []string{"omp"}},
	}

	svc := New(foundExecutables(cases))
	plans := svc.Plans()
	if len(plans) != len(cases) {
		t.Fatalf("Plans() returned %d plans, want %d", len(plans), len(cases))
	}
	seen := make(map[string]bool, len(plans))
	for i, want := range cases {
		got := plans[i]
		if seen[got.AgentID] {
			t.Fatalf("Plans() returned duplicate id %q", got.AgentID)
		}
		seen[got.AgentID] = true
		if got.AgentID != want.id || got.Action != want.action || !got.Available || got.Guidance != want.guidance || got.DocumentationURL != want.docs {
			t.Fatalf("plan %d = %#v, want id=%q action=%q available=true guidance=%q docs=%q", i, got, want.id, want.action, want.guidance, want.docs)
		}
		if got.title != want.title || got.DisplayCommand != strings.Join(want.argv, " ") || !reflect.DeepEqual(got.command, want.argv) || got.initialInput != want.initialInput {
			t.Fatalf("plan %q terminal = title %q display %q argv %#v initialInput %q, want title %q display %q argv %#v initialInput %q", want.id, got.title, got.DisplayCommand, got.command, got.initialInput, want.title, strings.Join(want.argv, " "), want.argv, want.initialInput)
		}
		data, err := json.Marshal(got)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(data), "command") || strings.Contains(string(data), "initialInput") {
			t.Fatalf("plan %q serialized trusted command data: %s", want.id, data)
		}
	}
}

func TestUnknownPlanReturnsStableTargetError(t *testing.T) {
	t.Parallel()

	_, err := New(foundExecutables(nil)).Plan("not-a-harness")
	var targetErr *Error
	if !errors.As(err, &targetErr) || targetErr.Code != "AGENT_AUTH_TARGET_UNKNOWN" {
		t.Fatalf("Plan() error = %v, want AGENT_AUTH_TARGET_UNKNOWN", err)
	}
}

func TestPlanMissingExecutableIsUnavailable(t *testing.T) {
	t.Parallel()

	plan, err := New(foundExecutables(nil)).Plan("codex")
	if err != nil {
		t.Fatal(err)
	}
	if plan.Available || plan.Reason == "" {
		t.Fatalf("Plan(codex) = %#v, want unavailable plan with useful reason", plan)
	}
}

func foundExecutables(cases []struct {
	id, title, executable, guidance, docs, initialInput string
	action                                              Action
	argv                                                []string
}) ExecutableFinder {
	found := map[string]string{}
	for _, tc := range cases {
		if tc.executable != "" {
			found[tc.executable] = "/test/bin/" + tc.executable
		}
	}
	return executableFinderFunc(func(name string) (string, error) {
		path, ok := found[name]
		if !ok {
			return "", errors.New("not found")
		}
		return path, nil
	})
}
