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

// A Claude confirmation menu has a provider-owned numbered selection row, at
// least one sibling option, and keyboard instructions beneath it. The question
// text and footer wording change between Claude releases and between command,
// file-edit, and user-question prompts, so structure is the stable boundary.
// Transcript prose may quote any of these words, but it does not form this
// current selection frame around the last prompt marker.
func claudeConfirmationFrameVisible(output string) bool {
	lines := terminalui.PlainTerminalLines(output)
	selection := -1
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if !strings.HasPrefix(line, "❯") {
			continue
		}
		// The selected option must be Claude's last prompt-shaped row. If a
		// normal composer appears below an old menu, that menu is transcript,
		// not a request that is still waiting.
		if !claudeNumberedOption(strings.TrimSpace(strings.TrimPrefix(line, "❯"))) {
			return false
		}
		selection = i
		break
	}
	if selection < 0 {
		return false
	}

	hasHeader := false
	optionCount := 1
	for i := selection - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			continue
		}
		if claudeNumberedOption(line) {
			optionCount++
			continue
		}
		hasHeader = true
		break
	}
	if !hasHeader {
		return false
	}

	hasHint := false
	for i := selection + 1; i < len(lines); i++ {
		line := strings.TrimSpace(lines[i])
		if claudeNumberedOption(line) {
			optionCount++
		}
		lower := strings.ToLower(line)
		if strings.Contains(lower, "press enter to confirm") ||
			strings.Contains(lower, "enter to select") ||
			strings.Contains(lower, "esc to cancel") ||
			strings.Contains(lower, "tab to amend") {
			hasHint = true
		}
	}
	return optionCount >= 2 && hasHint
}

func claudeNumberedOption(line string) bool {
	dot := strings.IndexByte(line, '.')
	if dot <= 0 {
		return false
	}
	for _, r := range line[:dot] {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
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
