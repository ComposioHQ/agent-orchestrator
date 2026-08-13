package codex

import (
	"regexp"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/terminalui"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

var codexTerminalEscape = regexp.MustCompile(`\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\][^\x07]*(?:\x07|\x1b\\))`)

// DetectTerminalActivity reports idle only when Codex's composer and footer are visible.
func (p *Plugin) DetectTerminalActivity(output string) (domain.ActivityState, bool) {
	observation := p.InspectTerminalSurface(output)
	if observation.Work == ports.TerminalSurfaceWorkIdle {
		return domain.ActivityIdle, true
	}
	return "", false
}

// InspectTerminalSurface reports Codex work and composer facts separately.
// A visible prompt can contain a draft, and Codex can render that prompt while
// an active turn remains interruptible.
func (p *Plugin) InspectTerminalSurface(output string) ports.TerminalSurfaceObservation {
	observation := ports.TerminalSurfaceObservation{
		Composer: codexComposerState(terminalui.LastPromptComposerState(codexComposerFrame(output), "›")),
	}
	lines := terminalLines(output)
	if len(lines) < 2 {
		return observation
	}
	start := len(lines) - 12
	if start < 0 {
		start = 0
	}
	for _, line := range lines[start:] {
		if strings.Contains(strings.ToLower(line), "esc to interrupt") {
			if strings.Contains(strings.ToLower(line), "press enter to confirm") ||
				strings.Contains(strings.ToLower(line), "enter to select") {
				observation.Work = ports.TerminalSurfaceWorkWaitingInput
			} else {
				observation.Work = ports.TerminalSurfaceWorkActive
			}
			return observation
		}
	}
	for _, line := range lines[start:] {
		lower := strings.ToLower(line)
		if strings.Contains(lower, "press enter to confirm") || strings.Contains(lower, "esc to go back") {
			observation.Work = ports.TerminalSurfaceWorkWaitingInput
			return observation
		}
	}
	for i := len(lines) - 2; i >= start; i-- {
		if !strings.HasPrefix(strings.TrimSpace(lines[i]), "›") {
			continue
		}
		if strings.Contains(lines[i+1], " · ") {
			observation.Work = ports.TerminalSurfaceWorkIdle
			return observation
		}
	}
	return observation
}

// codexComposerFrame excludes Codex's normal non-dim footer while retaining
// ANSI styling and any wrapped composer rows. Without this provider-owned
// boundary, safe parsing would have to mistake footer chrome for a draft.
func codexComposerFrame(output string) string {
	raw := strings.Split(strings.ReplaceAll(output, "\r", "\n"), "\n")
	start := len(raw) - 16
	if start < 0 {
		start = 0
	}
	for footer := len(raw) - 1; footer >= start; footer-- {
		plainFooter := strings.TrimSpace(codexTerminalEscape.ReplaceAllString(raw[footer], ""))
		if !strings.Contains(plainFooter, " · ") {
			continue
		}
		for prompt := footer - 1; prompt >= start; prompt-- {
			plainPrompt := strings.TrimSpace(codexTerminalEscape.ReplaceAllString(raw[prompt], ""))
			if strings.HasPrefix(plainPrompt, "›") {
				return strings.Join(raw[prompt:footer], "\n")
			}
		}
	}
	return output
}

func codexComposerState(state terminalui.ComposerState) ports.TerminalComposerState {
	switch state {
	case terminalui.ComposerEmpty:
		return ports.TerminalComposerEmpty
	case terminalui.ComposerDraft:
		return ports.TerminalComposerDraft
	default:
		return ports.TerminalComposerUnknown
	}
}

func terminalLines(output string) []string {
	plain := codexTerminalEscape.ReplaceAllString(strings.ReplaceAll(output, "\r", "\n"), "")
	raw := strings.Split(plain, "\n")
	lines := raw[:0]
	for _, line := range raw {
		line = strings.TrimSpace(line)
		if line != "" {
			lines = append(lines, line)
		}
	}
	return lines
}
