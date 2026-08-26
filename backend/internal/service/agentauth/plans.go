package agentauth

import "strings"

// plans is the code-reviewed authentication allowlist in stable Harness
// settings order. Commands must be added here, never supplied by clients.
var plans = []Plan{
	plan("claude-code", ActionLogin, "Log in to Claude Code", []string{"claude", "auth", "login"}, "", "Native browser/device flow", "https://code.claude.com/docs/en/installation"),
	plan("codex", ActionLogin, "Log in to Codex", []string{"codex", "login"}, "", "Native browser/device-code flow", "https://github.com/openai/codex"),
	plan("cursor", ActionLogin, "Log in to Cursor", []string{"cursor-agent", "login"}, "", "Native browser flow", "https://docs.cursor.com/en/cli/installation"),
	plan("opencode", ActionLogin, "Log in to OpenCode", []string{"opencode", "auth", "login"}, "", "Native provider chooser", "https://github.com/anomalyco/opencode"),
	plan("aider", ActionSetup, "Set up Aider", []string{"aider"}, "", "Configure provider/API key in the native prompt; docs fallback", "https://aider.chat/docs/install.html"),
	plan("copilot", ActionLogin, "Log in to GitHub Copilot", []string{"copilot", "login"}, "", "Native GitHub device/browser flow", "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli"),
	plan("grok", ActionLogin, "Log in to Grok", []string{"grok", "login"}, "", "Native login; device-auth remains available inside the CLI", "https://docs.x.ai/build/overview"),
	plan("kimi", ActionLogin, "Log in to Kimi", []string{"kimi", "login"}, "", "Native browser flow", "https://moonshotai.github.io/kimi-code/en/"),
	plan("pi", ActionLogin, "Log in to Pi", []string{"pi"}, "/login\r", "Native Pi login flow", "https://github.com/earendil-works/pi"),
	plan("amp", ActionLogin, "Log in to Amp", []string{"amp", "login"}, "", "Native browser flow", "https://ampcode.com/manual"),
	plan("auggie", ActionLogin, "Log in to Auggie", []string{"auggie", "login"}, "", "Native browser flow", "https://docs.augmentcode.com/cli/overview"),
	plan("droid", ActionLogin, "Log in to Droid", []string{"droid"}, "/login\r", "Native Droid login flow", "https://docs.factory.ai/droid-cli/cli-reference"),
	plan("crush", ActionSetup, "Set up Crush", []string{"crush"}, "", "Native provider picker", "https://github.com/charmbracelet/crush"),
	plan("cline", ActionLogin, "Log in to Cline", []string{"cline", "auth"}, "", "Native authentication flow", "https://github.com/cline/cline"),
	plan("goose", ActionSetup, "Set up Goose", []string{"goose", "configure"}, "", "Native provider configuration", "https://block.github.io/goose/index.html"),
	plan("qwen", ActionLogin, "Log in to Qwen", []string{"qwen"}, "/auth\r", "Native Qwen authentication flow", "https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/"),
	plan("continue", ActionLogin, "Log in to Continue", []string{"cn", "login"}, "", "Native browser flow", "https://docs.continue.dev/cli/quickstart"),
	plan("devin", ActionInstructions, "", nil, "", "Open official API-key/environment setup docs; AO stores no key", "https://docs.devin.ai/get-started/devin-intro"),
	plan("kiro", ActionLogin, "Log in to Kiro", []string{"kiro-cli", "login"}, "", "Native browser flow; device flow remains a CLI option", "https://kiro.dev/docs/getting-started/installation/"),
	plan("kilocode", ActionLogin, "Log in to Kilo Code", []string{"kilo", "auth", "login"}, "", "Native browser flow", "https://kilo.ai/docs/code-with-ai/platforms/cli"),
	plan("vibe", ActionSetup, "Set up Vibe", []string{"vibe", "--setup"}, "", "Native provider setup", "https://github.com/mistralai/mistral-vibe"),
	plan("muse", ActionLogin, "Log in to Muse", []string{"muse", "login"}, "", "Native login flow", "https://ai.meta.com/llama/"),
	plan("agy", ActionLogin, "Log in to Agy", []string{"agy"}, "", "Native first-run browser sign-in", "https://github.com/google-antigravity/antigravity-cli"),
	plan("autohand", ActionSetup, "Set up Autohand", []string{"autohand"}, "", "Native first-run sign-in/settings", "https://docs.autohand.ai/working-with-autohand-code/cli"),
	plan("kimchi", ActionSetup, "Set up Kimchi", []string{"kimchi", "setup"}, "", "Native setup; /login remains available in the CLI", "https://www.npmjs.com/package/@kimchi-dev/cli"),
	plan("prime-agent", ActionLogin, "Log in to Prime Agent", []string{"prime-agent"}, "/login\r", "Native Prime Agent login flow", "https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/quickstart.md"),
	plan("omp", ActionLogin, "Log in to OMP", []string{"omp"}, "/login\r", "Native OMP login flow", "https://github.com/can1357/oh-my-pi"),
}

var planByAgentID = func() map[string]Plan {
	out := make(map[string]Plan, len(plans))
	for _, plan := range plans {
		out[plan.AgentID] = plan
	}
	return out
}()

func plan(agentID string, action Action, title string, command []string, initialInput, guidance, docs string) Plan {
	return Plan{
		AgentID:          agentID,
		Action:           action,
		DisplayCommand:   strings.Join(command, " "),
		Guidance:         guidance,
		DocumentationURL: docs,
		command:          command,
		title:            title,
		initialInput:     initialInput,
	}
}
