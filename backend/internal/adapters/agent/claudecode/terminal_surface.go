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
	recent := terminalSurfaceTail(output, claudeTerminalSurfaceLookbackLines)
	switch {
	case claudeActiveFrameVisible(recent):
		observation.Work = ports.TerminalSurfaceWorkActive
	case claudeConfirmationFrameVisible(recent):
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

// Claude animates one of these glyphs at the start of its live work-status row.
// Requiring both the glyph and the interrupt hint prevents ordinary assistant
// prose that mentions the hint from becoming evidence that work is still active.
func claudeActiveFrameVisible(output string) bool {
	for _, line := range terminalSurfaceLines(output) {
		lower := strings.ToLower(line)
		if strings.Contains(lower, "esc to interrupt") && strings.ContainsAny(line, "✢✳✶✻✽") {
			return true
		}
	}
	return false
}

// A Claude confirmation menu has a question before its selected prompt row and
// the keyboard instruction after it. Transcript prose may contain either phrase
// (or even quote both), but it sits wholly before the current composer.
func claudeConfirmationFrameVisible(output string) bool {
	lines := terminalSurfaceLines(output)
	selection := -1
	for i := len(lines) - 1; i >= 0; i-- {
		if strings.Contains(lines[i], "❯") {
			selection = i
			break
		}
	}
	if selection < 0 {
		return false
	}
	before := strings.ToLower(strings.Join(lines[:selection], "\n"))
	after := strings.ToLower(strings.Join(lines[selection+1:], "\n"))
	return strings.Contains(before, "do you want to proceed?") &&
		strings.Contains(after, "press enter to confirm")
}

func terminalSurfaceTail(output string, lines int) string {
	parts := terminalSurfaceLines(output)
	if len(parts) > lines {
		parts = parts[len(parts)-lines:]
	}
	return strings.Join(parts, "\n")
}

func terminalSurfaceLines(output string) []string {
	return strings.Split(strings.ReplaceAll(output, "\r", "\n"), "\n")
}
