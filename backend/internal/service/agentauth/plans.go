package agentauth

import (
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/service/shellterm"
)

// plans is the code-reviewed authentication allowlist in stable Harness
// settings order. Commands must be added here, never supplied by clients.
var plans = []Plan{
	plan("claude-code", ActionLogin, "Log in to Claude Code", []string{"claude", "auth", "login"}, "Native browser/device flow", "https://code.claude.com/docs/en/installation"),
	plan("codex", ActionLogin, "Log in to Codex", []string{"codex", "login"}, "Native browser/device-code flow", "https://github.com/openai/codex"),
	plan("cursor", ActionLogin, "Log in to Cursor", []string{"cursor-agent", "login"}, "Native browser flow", "https://docs.cursor.com/en/cli/installation"),
	plan("opencode", ActionLogin, "Log in to OpenCode", []string{"opencode", "auth", "login"}, "Native provider chooser", "https://github.com/anomalyco/opencode"),
	plan("aider", ActionSetup, "Set up Aider", []string{"aider"}, "Configure the provider in the native prompt; AO forwards terminal input without persisting or logging the raw input, while Aider controls credential storage", "https://aider.chat/docs/install.html"),
	plan("copilot", ActionLogin, "Log in to GitHub Copilot", []string{"copilot", "login"}, "Native GitHub device/browser flow", "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli"),
	plan("grok", ActionLogin, "Log in to Grok", []string{"grok", "login"}, "Native login; device-auth remains available inside the CLI", "https://docs.x.ai/build/overview"),
	plan("kimi", ActionLogin, "Log in to Kimi", []string{"kimi", "login"}, "Native browser flow", "https://moonshotai.github.io/kimi-code/en/"),
	plan("pi", ActionLogin, "Log in to Pi", []string{"pi", "--verbose"}, "Type /login after Pi finishes starting", "https://github.com/earendil-works/pi"),
	plan("amp", ActionLogin, "Log in to Amp", []string{"amp", "login"}, "Native browser flow", "https://ampcode.com/manual"),
	plan("auggie", ActionLogin, "Log in to Auggie", []string{"auggie", "login"}, "Native browser flow", "https://docs.augmentcode.com/cli/overview"),
	interactivePlan("droid", ActionLogin, "Log in to Droid", []string{"droid", "/login"}, "", ready("Trust this folder?"), "Authentication opens automatically in this terminal", "https://docs.factory.ai/droid-cli/cli-reference"),
	plan("crush", ActionLogin, "Log in to Crush", []string{"crush", "login"}, "Native Charm Hyper login flow; GitHub Copilot remains available as a platform option", "https://github.com/charmbracelet/crush"),
	plan("cline", ActionLogin, "Log in to Cline", []string{"cline", "auth"}, "Native authentication flow", "https://github.com/cline/cline"),
	plan("goose", ActionSetup, "Set up Goose", []string{"goose", "configure"}, "Native provider configuration; AO forwards terminal input without persisting or logging the raw input, while Goose controls credential storage", "https://block.github.io/goose/index.html"),
	qwenPlan(),
	plan("continue", ActionLogin, "Log in to Continue", []string{"cn", "login"}, "Native browser flow", "https://docs.continue.dev/cli/quickstart"),
	plan("devin", ActionLogin, "Log in to Devin", []string{"devin", "auth", "login"}, "Native browser flow; manual-token flow remains available from the CLI", "https://docs.devin.ai/get-started/devin-intro"),
	plan("kiro", ActionLogin, "Log in to Kiro", []string{"kiro-cli", "login"}, "Native browser flow; device flow remains a CLI option", "https://kiro.dev/docs/getting-started/installation/"),
	plan("kilocode", ActionLogin, "Log in to Kilo Code", []string{"kilo", "auth", "login"}, "Native browser flow", "https://kilo.ai/docs/code-with-ai/platforms/cli"),
	plan("vibe", ActionSetup, "Set up Vibe", []string{"vibe", "--setup"}, "Native provider setup; AO forwards terminal input without persisting or logging the raw input, while Vibe controls credential storage", "https://github.com/mistralai/mistral-vibe"),
	plan("muse", ActionLogin, "Log in to Muse", []string{"muse", "login"}, "Native login flow", "https://ai.meta.com/llama/"),
	plan("agy", ActionLogin, "Log in to Agy", []string{"agy"}, "Native first-run browser sign-in", "https://github.com/google-antigravity/antigravity-cli"),
	plan("autohand", ActionSetup, "Set up Autohand", []string{"autohand"}, "Native first-run sign-in/settings", "https://docs.autohand.ai/working-with-autohand-code/cli"),
	plan("kimchi", ActionLogin, "Log in to Kimchi", []string{"kimchi", "login"}, "Native browser login flow", "https://docs.kimchi.dev/docs/service-keys"),
	interactivePlan("prime-agent", ActionLogin, "Log in to Prime Agent", []string{"prime-agent"}, "/login", ready("for shortcuts"), "Authentication opens automatically in this terminal", "https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/quickstart.md"),
	interactivePlan("omp", ActionLogin, "Log in to OMP", []string{"omp"}, "/login", ready("╭── π"), "Authentication opens automatically in this terminal", "https://github.com/can1357/oh-my-pi"),
}

func interactivePlan(agentID string, action Action, title string, command []string, initialInput string, readyStates []shellterm.InitialInputReadyState, guidance, docs string) Plan {
	p := plan(agentID, action, title, command, guidance, docs)
	// Ready states must be harness-owned markers rendered only after the editor
	// and submit handler are active; banners and update notices are not ready.
	p.initialInput = initialInput
	p.initialInputReadyStates = readyStates
	return p
}

func ready(text string) []shellterm.InitialInputReadyState {
	return []shellterm.InitialInputReadyState{{Text: text}}
}

func qwenPlan() Plan {
	p := interactivePlan("qwen", ActionSetup, "Set up Qwen", []string{"qwen"}, "/auth", []shellterm.InitialInputReadyState{
		{Text: "Type your message or @path/to/file"},
		{Text: "-- INSERT --"},
		{Text: "-- NORMAL --", RawPrefix: "i"},
	}, "Provider setup opens automatically in this terminal", "https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/")
	// Qwen localizes its editor placeholder from the process environment. Pin
	// only this auth terminal to English so the reviewed readiness markers are
	// stable without modifying the user's persisted language setting.
	p.env = map[string]string{"QWEN_CODE_LANG": "en"}
	return p
}

var planByAgentID = func() map[string]Plan {
	out := make(map[string]Plan, len(plans))
	for _, plan := range plans {
		out[plan.AgentID] = plan
	}
	return out
}()

func plan(agentID string, action Action, title string, command []string, guidance, docs string) Plan {
	return Plan{
		AgentID:          agentID,
		Action:           action,
		DisplayCommand:   strings.Join(command, " "),
		Guidance:         guidance,
		DocumentationURL: docs,
		command:          command,
		title:            title,
	}
}
