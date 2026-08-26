package cursor

import (
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/terminalui"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const cursorTerminalActivityLookbackLines = 16

// InspectTerminalSurface identifies Cursor's current composer only when its
// provider-owned model footer appears below it. That structural boundary keeps
// prompt-shaped transcript text from being treated as safe current input.
func (p *Plugin) InspectTerminalSurface(output string) ports.TerminalSurfaceObservation {
	lines := terminalui.PlainTerminalLines(output)
	prompt := -1
	for i := len(lines) - 1; i >= 0; i-- {
		if strings.HasPrefix(strings.TrimSpace(lines[i]), "→") {
			prompt = i
			break
		}
	}
	if prompt < 0 || !cursorFooterAfter(lines, prompt) {
		return ports.TerminalSurfaceObservation{}
	}

	text := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(lines[prompt]), "→"))
	composer := ports.TerminalComposerDraft
	switch text {
	case "", "Add a follow-up", "Plan, search, build anything":
		composer = ports.TerminalComposerEmpty
	}
	work := ports.TerminalSurfaceWorkIdle
	start := prompt - cursorTerminalActivityLookbackLines
	if start < 0 {
		start = 0
	}
	for _, raw := range lines[start:prompt] {
		if strings.Contains(strings.ToLower(raw), "esc to interrupt") {
			work = ports.TerminalSurfaceWorkActive
		}
	}
	return ports.TerminalSurfaceObservation{
		Work:     work,
		Composer: composer,
	}
}

func cursorFooterAfter(lines []string, prompt int) bool {
	for _, raw := range lines[prompt+1:] {
		line := strings.TrimSpace(raw)
		if (strings.HasPrefix(line, "Cursor ") || strings.HasPrefix(line, "Composer ")) &&
			strings.Contains(line, " · ") {
			return true
		}
	}
	return false
}

// DetectTerminalActivity provides the legacy activity-only view of Cursor's
// current terminal surface.
func (p *Plugin) DetectTerminalActivity(output string) (domain.ActivityState, bool) {
	if p.InspectTerminalSurface(output).Work == ports.TerminalSurfaceWorkIdle {
		return domain.ActivityIdle, true
	}
	return "", false
}

// ComposerIsEmpty reports whether Cursor's structurally current composer is
// empty or showing one of its provider-owned placeholder strings.
func (p *Plugin) ComposerIsEmpty(output string) bool {
	return p.InspectTerminalSurface(output).Composer == ports.TerminalComposerEmpty
}
