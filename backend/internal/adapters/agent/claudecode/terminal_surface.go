package claudecode

import (
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/terminalui"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const claudeTerminalSurfaceLookbackLines = 12

// InspectTerminalSurface reports independent work and composer facts from
// Claude Code's current TUI. Claude may keep its composer visible while a turn
// is active, so an empty composer never overrides an active footer marker.
func (p *Plugin) InspectTerminalSurface(output string) ports.TerminalSurfaceObservation {
	composer := terminalui.LastBorderedPromptComposerState(output, "❯")
	if composer == terminalui.ComposerUnknown {
		composer = terminalui.LastPromptComposerState(output, "❯")
	}

	observation := ports.TerminalSurfaceObservation{Composer: claudeComposerState(composer)}
	recent := strings.ToLower(terminalSurfaceTail(output, claudeTerminalSurfaceLookbackLines))
	switch {
	case strings.Contains(recent, "esc to interrupt"):
		observation.Work = ports.TerminalSurfaceWorkActive
	case strings.Contains(recent, "do you want to proceed?") ||
		strings.Contains(recent, "press enter to confirm"):
		observation.Work = ports.TerminalSurfaceWorkBlocked
	case observation.Composer != ports.TerminalComposerUnknown:
		observation.Work = ports.TerminalSurfaceWorkIdle
	}
	return observation
}

func claudeComposerState(state terminalui.ComposerState) ports.TerminalComposerState {
	switch state {
	case terminalui.ComposerEmpty:
		return ports.TerminalComposerEmpty
	case terminalui.ComposerDraft:
		return ports.TerminalComposerDraft
	default:
		return ports.TerminalComposerUnknown
	}
}

func terminalSurfaceTail(output string, lines int) string {
	parts := strings.Split(strings.ReplaceAll(output, "\r", "\n"), "\n")
	if len(parts) > lines {
		parts = parts[len(parts)-lines:]
	}
	return strings.Join(parts, "\n")
}
