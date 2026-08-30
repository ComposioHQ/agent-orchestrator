package systeminstall

import "fmt"

var agentDocumentationURLs = map[Target]string{
	TargetClaudeCode: "https://code.claude.com/docs/en/installation",
	TargetCodex:      "https://github.com/openai/codex",
	TargetCursor:     "https://docs.cursor.com/en/cli/installation",
	TargetOpencode:   "https://github.com/anomalyco/opencode",
	TargetAider:      "https://aider.chat/docs/install.html",
	TargetCopilot:    "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
	TargetGrok:       "https://docs.x.ai/build/overview",
	TargetKimi:       "https://moonshotai.github.io/kimi-code/en/",
	TargetPi:         "https://github.com/earendil-works/pi",
	TargetAmp:        "https://ampcode.com/manual",
	TargetAuggie:     "https://docs.augmentcode.com/cli/overview",
	TargetDroid:      "https://docs.factory.ai/droid-cli/cli-reference",
	TargetCrush:      "https://github.com/charmbracelet/crush",
	TargetCline:      "https://github.com/cline/cline",
	TargetGoose:      "https://block.github.io/goose/index.html",
	TargetQwen:       "https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/",
	TargetContinue:   "https://docs.continue.dev/cli/quickstart",
	TargetDevin:      "https://docs.devin.ai/get-started/devin-intro",
	TargetKiro:       "https://kiro.dev/docs/getting-started/installation/",
	TargetKilocode:   "https://kilo.ai/docs/code-with-ai/platforms/cli",
	TargetVibe:       "https://github.com/mistralai/mistral-vibe",
	TargetMuse:       "https://ai.meta.com/llama/",
	TargetAgy:        "https://github.com/google-antigravity/antigravity-cli",
	TargetAutohand:   "https://docs.autohand.ai/working-with-autohand-code/cli",
	TargetKimchi:     "https://www.npmjs.com/package/@kimchi-dev/cli",
	TargetPrimeAgent: "https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/quickstart.md",
	TargetOMP:        "https://github.com/can1357/oh-my-pi",
}

func (s *Service) agentMethodPlans(target Target) []Plan {
	var plans []Plan
	switch target {
	case TargetClaudeCode:
		if s.goos == "darwin" {
			plans = []Plan{s.planBrewCask(target, "claude-code"), s.planNPM(target, "@anthropic-ai/claude-code")}
		} else {
			plans = []Plan{s.planNPM(target, "@anthropic-ai/claude-code")}
		}
	case TargetCodex:
		if s.goos == "darwin" {
			plans = []Plan{s.planBrewCask(target, "codex"), s.planNPM(target, "@openai/codex")}
		} else {
			plans = []Plan{s.planNPM(target, "@openai/codex")}
		}
	case TargetOpencode:
		switch s.goos {
		case "windows":
			plans = []Plan{s.planWinget(target, "SST.opencode")}
		case "darwin":
			plans = []Plan{s.planBrew(target, "anomalyco/tap/opencode"), s.planNPM(target, "opencode-ai@latest")}
		default:
			plans = []Plan{s.planNPM(target, "opencode-ai@latest")}
		}
	case TargetCopilot:
		switch s.goos {
		case "windows":
			plans = []Plan{s.planWinget(target, "GitHub.Copilot"), s.planNPM(target, "@github/copilot")}
		case "darwin":
			plans = []Plan{s.planBrewCask(target, "copilot-cli"), s.planNPM(target, "@github/copilot")}
		default:
			plans = []Plan{s.planNPM(target, "@github/copilot")}
		}
	case TargetPi:
		plans = []Plan{s.planNPM(target, "@earendil-works/pi-coding-agent")}
	case TargetAmp:
		if s.goos == "darwin" {
			plans = []Plan{s.planBrew(target, "ampcode/tap/ampcode"), s.planNPM(target, "@ampcode/cli")}
		} else {
			plans = []Plan{s.planNPM(target, "@ampcode/cli")}
		}
	case TargetDroid:
		if s.goos == "darwin" {
			plans = []Plan{s.planBrewCask(target, "droid"), s.planNPM(target, "droid")}
		} else {
			plans = []Plan{s.planNPM(target, "droid")}
		}
	case TargetCrush:
		if s.goos == "darwin" {
			plans = []Plan{s.planBrew(target, "charmbracelet/tap/crush"), s.planNPM(target, "@charmland/crush")}
		} else {
			plans = []Plan{s.planNPM(target, "@charmland/crush")}
		}
	case TargetQwen:
		if s.goos == "darwin" {
			plans = []Plan{s.planBrew(target, "qwen-code"), s.planNPM(target, "@qwen-code/qwen-code@latest")}
		} else {
			plans = []Plan{s.planNPM(target, "@qwen-code/qwen-code@latest")}
		}
	case TargetAutohand:
		if s.goos == "darwin" {
			plans = []Plan{s.planBrew(target, "autohandai/code/autohand-code"), s.planNPM(target, "autohand-cli")}
		} else {
			plans = []Plan{s.planNPM(target, "autohand-cli")}
		}
	case TargetVibe:
		plans = []Plan{s.planUV(target, "mistral-vibe"), s.planPipx(target, "mistral-vibe")}
	case TargetOMP:
		if s.goos == "darwin" {
			plans = []Plan{s.planBrew(target, "can1357/tap/omp"), s.planBun(target, "@oh-my-pi/pi-coding-agent")}
		} else {
			plans = []Plan{s.planBun(target, "@oh-my-pi/pi-coding-agent")}
		}
	default:
		plans = []Plan{s.planAgent(target)}
	}
	for index := range plans {
		plans[index].DocsURL = agentDocumentationURLs[target]
	}
	return plans
}

func (s *Service) resolveAgentMethod(target Target, method string) (Plan, error) {
	for _, plan := range s.agentMethodPlans(target) {
		if plan.Method != method {
			continue
		}
		if plan.Unsupported {
			return Plan{}, fmt.Errorf("%w: install method %q is not available: %s", ErrInstallMethod, method, plan.Reason)
		}
		return plan, nil
	}
	return Plan{}, fmt.Errorf("%w: unknown install method %q for %s", ErrInstallMethod, method, target)
}

// planAgent contains the first-party, code-reviewed installation recipe for
// each Harness settings entry. The renderer never supplies any part of these
// commands; it can only select the target id.
func (s *Service) planAgent(target Target) Plan {
	switch target {
	case TargetClaudeCode:
		preferred := s.officialByOS(target,
			"https://claude.ai/install.sh", "bash",
			"https://claude.ai/install.ps1",
			"https://code.claude.com/docs/en/installation")
		if s.goos == "darwin" {
			return withDocs(firstAvailable(preferred, s.planBrewCask(target, "claude-code"), s.planNPM(target, "@anthropic-ai/claude-code")), "https://code.claude.com/docs/en/installation")
		}
		return withDocs(firstAvailable(preferred, s.planNPM(target, "@anthropic-ai/claude-code")), "https://code.claude.com/docs/en/installation")
	case TargetCodex:
		var preferred Plan
		if s.goos == "windows" {
			preferred = s.planPowerShellInstaller(target, "https://chatgpt.com/codex/install.ps1")
		} else {
			preferred = s.planShellInstaller(target, "https://chatgpt.com/codex/install.sh", "sh")
		}
		if s.goos == "darwin" {
			return withDocs(firstAvailable(preferred, s.planBrewCask(target, "codex"), s.planNPM(target, "@openai/codex")), "https://github.com/openai/codex")
		}
		return withDocs(firstAvailable(preferred, s.planNPM(target, "@openai/codex")), "https://github.com/openai/codex")
	case TargetOpencode:
		preferred := withDocs(s.planOpencode(), "https://github.com/anomalyco/opencode")
		if s.goos == "darwin" {
			return withDocs(firstAvailable(preferred, s.planBrew(target, "anomalyco/tap/opencode"), s.planNPM(target, "opencode-ai@latest")), "https://github.com/anomalyco/opencode")
		}
		return withDocs(firstAvailable(preferred, s.planNPM(target, "opencode-ai@latest")), "https://github.com/anomalyco/opencode")
	case TargetCopilot:
		if s.goos == "windows" {
			return withDocs(firstAvailable(s.planWinget(target, "GitHub.Copilot"), s.planNPM(target, "@github/copilot")), "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli")
		}
		if s.goos == "darwin" {
			return withDocs(firstAvailable(s.planBrewCask(target, "copilot-cli"), s.planNPM(target, "@github/copilot")), "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli")
		}
		return withDocs(s.planNPM(target, "@github/copilot"), "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli")
	case TargetCursor:
		return s.officialByOS(target,
			"https://cursor.com/install", "bash",
			"https://cursor.com/install?win32=true",
			"https://docs.cursor.com/en/cli/installation")
	case TargetAider:
		return s.officialByOS(target,
			"https://aider.chat/install.sh", "sh",
			"https://aider.chat/install.ps1",
			"https://aider.chat/docs/install.html")
	case TargetGrok:
		return s.officialByOS(target,
			"https://x.ai/cli/install.sh", "bash",
			"https://x.ai/cli/install.ps1",
			"https://docs.x.ai/build/overview")
	case TargetKimi:
		return s.officialByOS(target,
			"https://code.kimi.com/kimi-code/install.sh", "bash",
			"https://code.kimi.com/kimi-code/install.ps1",
			"https://moonshotai.github.io/kimi-code/en/")
	case TargetPi:
		if s.goos != "windows" {
			return withDocs(firstAvailable(s.planShellInstaller(target, "https://pi.dev/install.sh", "sh"), s.planNPM(target, "@earendil-works/pi-coding-agent")), "https://github.com/earendil-works/pi")
		}
		return withDocs(s.planNPM(target, "@earendil-works/pi-coding-agent"), "https://github.com/earendil-works/pi")
	case TargetAmp:
		preferred := s.officialByOS(target,
			"https://ampcode.com/install.sh", "bash",
			"https://ampcode.com/install.ps1",
			"https://ampcode.com/manual")
		if s.goos == "darwin" {
			return withDocs(firstAvailable(preferred, s.planBrew(target, "ampcode/tap/ampcode"), s.planNPM(target, "@ampcode/cli")), "https://ampcode.com/manual")
		}
		return withDocs(firstAvailable(preferred, s.planNPM(target, "@ampcode/cli")), "https://ampcode.com/manual")
	case TargetAuggie:
		return withDocs(s.planNPM(target, "@augmentcode/auggie"), "https://docs.augmentcode.com/cli/overview")
	case TargetDroid:
		preferred := s.officialByOS(target,
			"https://app.factory.ai/cli", "sh",
			"https://app.factory.ai/cli/windows",
			"https://docs.factory.ai/droid-cli/cli-reference")
		if s.goos == "darwin" {
			return withDocs(firstAvailable(preferred, s.planBrewCask(target, "droid"), s.planNPM(target, "droid")), "https://docs.factory.ai/droid-cli/cli-reference")
		}
		return withDocs(firstAvailable(preferred, s.planNPM(target, "droid")), "https://docs.factory.ai/droid-cli/cli-reference")
	case TargetCrush:
		if s.goos == "darwin" {
			return withDocs(firstAvailable(s.planBrew(target, "charmbracelet/tap/crush"), s.planNPM(target, "@charmland/crush")), "https://github.com/charmbracelet/crush")
		}
		return withDocs(s.planNPM(target, "@charmland/crush"), "https://github.com/charmbracelet/crush")
	case TargetCline:
		return withDocs(s.planNPM(target, "cline@latest"), "https://github.com/cline/cline")
	case TargetGoose:
		if s.goos == "windows" {
			return manualPlan(target, "Goose does not publish a native Windows CLI installer; use WSL or the desktop download.", "https://block.github.io/goose/index.html")
		}
		return withDocs(s.planShellInstaller(target, "https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh", "bash"), "https://block.github.io/goose/index.html")
	case TargetQwen:
		preferred := s.officialByOS(target,
			"https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh", "bash",
			"https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1",
			"https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/")
		if s.goos == "darwin" {
			return withDocs(firstAvailable(preferred, s.planBrew(target, "qwen-code"), s.planNPM(target, "@qwen-code/qwen-code@latest")), "https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/")
		}
		return withDocs(firstAvailable(preferred, s.planNPM(target, "@qwen-code/qwen-code@latest")), "https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/")
	case TargetContinue:
		return withDocs(s.planNPM(target, "@continuedev/cli"), "https://docs.continue.dev/cli/quickstart")
	case TargetDevin:
		if s.goos == "windows" {
			return manualPlan(target, "Devin for Terminal documents installation through WSL on Windows.", "https://docs.devin.ai/get-started/devin-intro")
		}
		return withDocs(s.planShellInstaller(target, "https://cli.devin.ai/install.sh", "bash"), "https://docs.devin.ai/get-started/devin-intro")
	case TargetKiro:
		return s.officialByOS(target,
			"https://cli.kiro.dev/install", "bash",
			"https://cli.kiro.dev/install.ps1",
			"https://kiro.dev/docs/getting-started/installation/")
	case TargetKilocode:
		return withDocs(s.planNPM(target, "@kilocode/cli"), "https://kilo.ai/docs/code-with-ai/platforms/cli")
	case TargetVibe:
		return withDocs(firstAvailable(s.planUV(target, "mistral-vibe"), s.planPipx(target, "mistral-vibe")), "https://github.com/mistralai/mistral-vibe")
	case TargetMuse:
		if s.goos == "windows" {
			return manualPlan(target, "Muse Code does not currently publish a native Windows installer.", "https://ai.meta.com/llama/")
		}
		return withDocs(s.planShellInstaller(target, "https://dev.meta.ai/install.sh", "bash"), "https://ai.meta.com/llama/")
	case TargetAgy:
		return s.officialByOS(target,
			"https://antigravity.google/cli/install.sh", "bash",
			"https://antigravity.google/cli/install.ps1",
			"https://github.com/google-antigravity/antigravity-cli")
	case TargetAutohand:
		preferred := s.officialByOS(target,
			"https://autohand.ai/install.sh", "sh",
			"https://autohand.ai/install.ps1",
			"https://docs.autohand.ai/working-with-autohand-code/cli")
		if s.goos == "darwin" {
			return withDocs(firstAvailable(preferred, s.planBrew(target, "autohandai/code/autohand-code"), s.planNPM(target, "autohand-cli")), "https://docs.autohand.ai/working-with-autohand-code/cli")
		}
		return withDocs(firstAvailable(preferred, s.planNPM(target, "autohand-cli")), "https://docs.autohand.ai/working-with-autohand-code/cli")
	case TargetKimchi:
		return withDocs(s.planNPM(target, "@kimchi-dev/cli"), "https://www.npmjs.com/package/@kimchi-dev/cli")
	case TargetPrimeAgent:
		if s.goos == "windows" {
			return manualPlan(target, "Prime Agent currently documents macOS and Linux; use WSL on Windows.", "https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/quickstart.md")
		}
		return withDocs(s.planShellInstaller(target, "https://app.primeintellect.ai/prime-agent/install.sh", "sh"), "https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/quickstart.md")
	case TargetOMP:
		preferred := s.officialByOS(target,
			"https://omp.sh/install", "sh",
			"https://omp.sh/install.ps1",
			"https://github.com/can1357/oh-my-pi")
		if s.goos == "darwin" {
			return withDocs(firstAvailable(preferred, s.planBrew(target, "can1357/tap/omp"), s.planBun(target, "@oh-my-pi/pi-coding-agent")), "https://github.com/can1357/oh-my-pi")
		}
		return withDocs(firstAvailable(preferred, s.planBun(target, "@oh-my-pi/pi-coding-agent")), "https://github.com/can1357/oh-my-pi")
	default:
		return Plan{Target: target, Unsupported: true, Method: "manual", Reason: "unknown install target"}
	}
}

func (s *Service) officialByOS(target Target, unixURL, unixShell, windowsURL, docsURL string) Plan {
	if s.goos == "windows" {
		return withDocs(s.planPowerShellInstaller(target, windowsURL), docsURL)
	}
	return withDocs(s.planShellInstaller(target, unixURL, unixShell), docsURL)
}

func (s *Service) planShellInstaller(target Target, url, shell string) Plan {
	return Plan{
		Target: target, Unsupported: true, Method: "manual",
		Reason: fmt.Sprintf("AO does not automatically execute mutable remote installer scripts. Follow the vendor instructions for %s using %s.", url, shell),
	}
}

func (s *Service) planPowerShellInstaller(target Target, url string) Plan {
	return Plan{
		Target: target, Unsupported: true, Method: "manual",
		Reason: fmt.Sprintf("AO does not automatically execute mutable remote installer scripts. Follow the vendor instructions for %s in PowerShell.", url),
	}
}

func (s *Service) planUV(target Target, pkg string) Plan {
	if _, err := s.executables.LookPath("uv"); err != nil {
		return Plan{Target: target, Unsupported: true, Method: "uv", Reason: "uv was not found on PATH. Install uv, then retry."}
	}
	return Plan{Target: target, Method: "uv", Command: []string{"uv", "tool", "install", pkg}}
}

func (s *Service) planBun(target Target, pkg string) Plan {
	if _, err := s.executables.LookPath("bun"); err != nil {
		return Plan{Target: target, Unsupported: true, Method: "bun", Reason: "Bun was not found on PATH."}
	}
	return Plan{Target: target, Method: "bun", Command: []string{"bun", "install", "-g", pkg}}
}

func (s *Service) planPipx(target Target, pkg string) Plan {
	if _, err := s.executables.LookPath("pipx"); err != nil {
		return Plan{Target: target, Unsupported: true, Method: "pipx", Reason: "pipx was not found on PATH. Install pipx, then retry."}
	}
	return Plan{Target: target, Method: "pipx", Command: []string{"pipx", "install", pkg}}
}

func firstAvailable(plans ...Plan) Plan {
	for _, plan := range plans {
		if !plan.Unsupported {
			return plan
		}
	}
	if len(plans) == 0 {
		return Plan{Unsupported: true, Method: "manual", Reason: "No installation method is configured."}
	}
	// When every candidate is unavailable, report the last fallback's failure.
	// Returning the first candidate used to make an unavailable official script
	// mask actionable package-manager diagnostics (for example an unwritable
	// npm prefix).
	return plans[len(plans)-1]
}

func manualPlan(target Target, reason, docsURL string) Plan {
	return Plan{Target: target, Unsupported: true, Method: "manual", Reason: reason, DocsURL: docsURL}
}
