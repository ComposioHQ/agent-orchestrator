package claudecode

import (
	"strings"
	"unicode/utf8"

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
		observation.Composer = ports.TerminalComposerUnknown
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

// Claude renders its active status immediately above the current composer (or
// above the composer's upper border). Transcript and draft text may quote the
// same words, so only that structurally current row is eligible as work chrome.
func claudeActiveFrameVisible(output string) bool {
	lines := terminalui.PlainTerminalLines(output)
	prompt := -1
	for i := len(lines) - 1; i >= 0; i-- {
		if strings.HasPrefix(strings.TrimSpace(lines[i]), "❯") {
			prompt = i
			break
		}
	}
	if prompt < 0 {
		return false
	}
	status := previousClaudeSurfaceLine(lines, prompt)
	if status >= 0 && claudeHorizontalRule(lines[status]) {
		status = previousClaudeSurfaceLine(lines, status)
	}
	if status < 0 {
		return false
	}
	line := strings.TrimSpace(lines[status])
	first, _ := utf8.DecodeRuneInString(line)
	if !strings.ContainsRune("✢✳✶✻✽", first) {
		return false
	}
	return strings.Contains(strings.ToLower(line), "esc to interrupt")
}

func previousClaudeSurfaceLine(lines []string, before int) int {
	for i := before - 1; i >= 0; i-- {
		if strings.TrimSpace(lines[i]) != "" {
			return i
		}
	}
	return -1
}

func claudeHorizontalRule(line string) bool {
	line = strings.TrimSpace(line)
	if utf8.RuneCountInString(line) < 16 {
		return false
	}
	for _, r := range line {
		if r != '─' {
			return false
		}
	}
	return true
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
